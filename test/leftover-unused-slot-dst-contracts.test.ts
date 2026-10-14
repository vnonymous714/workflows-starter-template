import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	GrokRequestError,
	parseGrokVerdict,
	recId,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	EspnRequestError,
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import { importSleeperRoster } from "../src/sleeper-client";
import type { FantasyPlayer } from "../src/types/fantasy";
import worker from "../worker/index";

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

function uniqueId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function leagueWithEntries(
	id: number,
	entries: NonNullable<
		NonNullable<EspnRawLeagueResponse["teams"]>[number]["roster"]
	>["entries"],
	extras: Partial<EspnRawLeagueResponse> = {},
): EspnRawLeagueResponse {
	return {
		id,
		seasonId: 2024,
		teams: [
			{
				id: 1,
				name: `League ${id}`,
				roster: { entries },
			},
		],
		...extras,
	};
}

function namedPlayer(name: string): FantasyPlayer {
	return {
		id: `p_${name.replace(/\s+/g, "_").toLowerCase()}`,
		name,
		pos: "QB",
		team: "NFL",
		opp: "vs OPP",
		projPts: 10,
		status: "ACTIVE",
	};
}

describe("ESPN leftover unused slots, unused team ids, and rounding", () => {
	it("benches leftover numeric unknown slots 8/9 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1201, [
				{
					lineupSlotId: 8,
					playerPoolEntry: {
						player: {
							id: 12011,
							fullName: "Unknown Numeric Slot Eight",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 9,
					playerPoolEntry: {
						player: {
							id: 12012,
							fullName: "Unknown Numeric Slot Nine",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Eight", pos: "QB" },
			{ name: "Unknown Numeric Slot Nine", pos: "K" },
		]);
	});

	it("falls unused leftover numeric defaultPositionId 7/9 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1202, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 12021,
							fullName: "Unknown Default Numeric Seven",
							defaultPositionId: 7,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 12022,
							fullName: "Unknown Default Numeric Nine",
							defaultPositionId: 9,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 22 to ARI and 12 to KC", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1203, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 12031,
							fullName: "String Team ARI",
							defaultPositionId: 2,
							proTeamId: "22" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 12032,
							fullName: "String Team KC",
							defaultPositionId: 2,
							proTeamId: "12" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team ARI", team: "ARI" },
				{ name: "String Team KC", team: "KC" },
			],
		);
	});

	it("keeps leftover padded mixed Doubtful as ACTIVE (leftover of leftover padded Ir/Out)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1204, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 12041,
							fullName: "Padded Mixed Doubtful",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Doubtful ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("adds High Floor when leftover appliedStatTotal 17.951 rounds to 18", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1205, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						appliedStatTotal: 17.951,
						player: {
							id: 12051,
							fullName: "Rounded High Floor",
							defaultPositionId: 2,
							proTeamId: 8,
						},
					},
				},
			]),
		);

		expect(roster.starters[0]?.projPts).toBe(18);
		expect(roster.starters[0]?.tags).toContain("High Floor");
	});

	it("maps ESPN HTTP 502 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "502502",
				fetchImpl: async () => new Response("Bad gateway", { status: 502 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 502,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, six-placeholder reindex, and FLEX-slot override", () => {
	const league = {
		league_id: "leftover-unused-slot-league",
		name: "Leftover Unused Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-unused-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-unused-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-unused-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("treats leftover 3-letter ATL and 2-letter NO as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unused-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "ATL", "NO"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "ATL Defense", pos: "DST", team: "ATL" },
				{ name: "NO Defense", pos: "DST", team: "NO" },
			],
		);
	});

	it("treats mixed-case Atl as FLEX Player #Atl rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unused-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Atl"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Atl");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Atl Defense");
	});

	it("reindexes Chase onto FLEX after dropping six placeholder 0 starters", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unused-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: [
						"4984",
						"8183",
						"8138",
						"7553",
						"4035",
						"11439",
						"0",
						"0",
						"0",
						"0",
						"0",
						"0",
						"7564",
					],
					players: [
						"4984",
						"8183",
						"8138",
						"7553",
						"4035",
						"11439",
						"0",
						"0",
						"0",
						"0",
						"0",
						"0",
						"7564",
					],
				},
			]),
		);

		expect(roster.starters).toHaveLength(7);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[3]?.name).toBe("Jaylen Waddle");
		expect(roster.starters[3]?.pos).toBe("WR");
		expect(roster.starters[4]?.name).toBe("George Kittle");
		expect(roster.starters[4]?.pos).toBe("WR");
		expect(roster.starters[5]?.name).toBe("Brandon Aubrey");
		expect(roster.starters[5]?.pos).toBe("TE");
		expect(roster.starters[6]?.name).toBe("Ja'Marr Chase");
		expect(roster.starters[6]?.pos).toBe("FLEX");
		expect(roster.starters[6]?.pos).not.toBe("TE");
		expect(roster.starters[6]?.pos).not.toBe("K");
	});

	it("keeps known RB metadata when that player occupies the hardcoded FLEX slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unused-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "8138", "7564", "7553", "4035", "8136"],
					players: ["4984", "8183", "8138", "7564", "7553", "4035", "8136"],
				},
			]),
		);

		expect(roster.starters[6]?.name).toBe("Tyler Allgeier");
		expect(roster.starters[6]?.pos).toBe("FLEX");
		expect(roster.starters[6]?.team).toBe("ATL");
		expect(roster.starters[6]?.tags).toContain("Red Zone Handcuff");
		expect(roster.starters[6]?.projPts).toBe(9.2);
	});

	it("treats query 4e1 as parseInt roster 4, not scientific 40", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unused-slot-league", userOrRosterId: "4e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
					settings: { wins: 9, losses: 4 },
				},
				{
					roster_id: 4,
					owner_id: "user_4",
					starters: ["7564"],
					players: ["7564"],
					settings: { wins: 3, losses: 10 },
				},
				{
					roster_id: 40,
					owner_id: "user_40",
					starters: ["8138"],
					players: ["8138"],
					settings: { wins: 1, losses: 12 },
				},
			]),
		);

		expect(roster.rank).toBe(4);
		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.record).toBe("3-10");
		expect(roster.rank).not.toBe(40);
	});

	it("maps Sleeper league HTTP 502 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-unused-slot-league")) {
				return new Response("Bad gateway", { status: 502 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-unused-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (502)",
		});
	});
});

describe("Grok leftover suffix recId, substring lookup, and numeric content", () => {
	it("uses first name when leftover suffixes VI/I are 3 chars or fewer", () => {
		expect(recId(namedPlayer("Patrick Mahomes VI"))).toBe("Patrick");
		expect(recId(namedPlayer("Henry Wilson I"))).toBe("Henry");
		expect(recId(namedPlayer("Patrick Mahomes VI"))).not.toBe("VI");
		expect(recId(namedPlayer("Henry Wilson I"))).not.toBe("I");
	});

	it("resolves substring ubre to Brandon Aubrey via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "ubre");

		expect(player?.id).toBe("p_aubrey");
		expect(player?.name).toBe("Brandon Aubrey");
	});

	it("matches first-token rec id Brandon to Aubrey and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const aubrey = resolvePlayer(state, "p_aubrey")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Brandon",
					act: "START",
					vs: "Chase",
					delta: 1,
					conf: 0.8,
					why: "dome kicker",
					src: "grok",
					flags: [],
				},
				aubrey,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "rand",
					act: "START",
					vs: "Chase",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				aubrey,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is an empty string", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "",
							delta: -2,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow(GrokRequestError);
		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "",
							delta: -2,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 3 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 3 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard start and patch-state routes", () => {
	it("returns JSON Not Found for PUT /api/workflow/start because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/start", { method: "PUT" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns JSON Not Found for DELETE /api/workflow/event without an id segment", async () => {
		const res = await fetchWorker("/api/workflow/event", { method: "DELETE" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for PATCH /api/fantasy/state", async () => {
		const res = await fetchWorker(
			`/api/fantasy/state?teamId=${uniqueId("state-patch")}`,
			{ method: "PATCH" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
