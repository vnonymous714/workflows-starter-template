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

describe("ESPN leftover unknown bench slots, unused team ids, and rounding", () => {
	it("benches leftover numeric unknown slots 10/11 using defaultPositionId (QB/WR)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1301, [
				{
					lineupSlotId: 10,
					playerPoolEntry: {
						player: {
							id: 13011,
							fullName: "Unknown Numeric Slot Ten",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 11,
					playerPoolEntry: {
						player: {
							id: 13012,
							fullName: "Unknown Numeric Slot Eleven",
							defaultPositionId: 3,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Ten", pos: "QB" },
			{ name: "Unknown Numeric Slot Eleven", pos: "WR" },
		]);
	});

	it("falls unused leftover string defaultPositionId 9/10 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1302, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 13021,
							fullName: "Unknown Default String Nine",
							defaultPositionId: "9" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 13022,
							fullName: "Unknown Default String Ten",
							defaultPositionId: "10" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 13 to LV and 15 to MIA", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1303, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 13031,
							fullName: "String Team LV",
							defaultPositionId: 2,
							proTeamId: "13" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 13032,
							fullName: "String Team MIA",
							defaultPositionId: 2,
							proTeamId: "15" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team LV", team: "LV" },
				{ name: "String Team MIA", team: "MIA" },
			],
		);
	});

	it("keeps leftover padded mixed Questionable as ACTIVE (leftover of leftover padded Doubtful)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1304, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 13041,
							fullName: "Padded Mixed Questionable",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Questionable ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("does not add High Floor when leftover appliedStatTotal 17.949 rounds to 17.9", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1305, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						appliedStatTotal: 17.949,
						player: {
							id: 13051,
							fullName: "Rounded No High Floor",
							defaultPositionId: 2,
							proTeamId: 8,
						},
					},
				},
			]),
		);

		expect(roster.starters[0]?.projPts).toBe(17.9);
		expect(roster.starters[0]?.tags).toBeUndefined();
	});

	it("maps ESPN HTTP 503 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "503503",
				fetchImpl: async () => new Response("Unavailable", { status: 503 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 503,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, seven-placeholder reindex, and RB-slot override", () => {
	const league = {
		league_id: "leftover-bench-slot-league",
		name: "Leftover Bench Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-bench-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-bench-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-bench-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("treats leftover 3-letter BUF and 2-letter TB as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-bench-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "BUF", "TB"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "BUF Defense", pos: "DST", team: "BUF" },
				{ name: "TB Defense", pos: "DST", team: "TB" },
			],
		);
	});

	it("treats mixed-case Buf as FLEX Player #Buf rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-bench-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Buf"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Buf");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Buf Defense");
	});

	it("reindexes Chase onto K after dropping seven placeholder 0 starters", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-bench-slot-league" },
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
						"BAL",
						"0",
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
						"BAL",
						"0",
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

		expect(roster.starters).toHaveLength(8);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[5]?.name).toBe("Brandon Aubrey");
		expect(roster.starters[5]?.pos).toBe("TE");
		expect(roster.starters[6]?.name).toBe("Baltimore Ravens");
		expect(roster.starters[6]?.pos).toBe("FLEX");
		expect(roster.starters[7]?.name).toBe("Ja'Marr Chase");
		expect(roster.starters[7]?.pos).toBe("K");
		expect(roster.starters[7]?.pos).not.toBe("FLEX");
		expect(roster.starters[7]?.pos).not.toBe("DST");
	});

	it("keeps known RB metadata when that player occupies the hardcoded first RB slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-bench-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8136"],
					players: ["4984", "8136"],
				},
			]),
		);

		expect(roster.starters[1]?.name).toBe("Tyler Allgeier");
		expect(roster.starters[1]?.pos).toBe("RB");
		expect(roster.starters[1]?.team).toBe("ATL");
		expect(roster.starters[1]?.tags).toContain("Red Zone Handcuff");
		expect(roster.starters[1]?.projPts).toBe(9.2);
	});

	it("treats query 5e1 as parseInt roster 5, not scientific 50", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-bench-slot-league", userOrRosterId: "5e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
					settings: { wins: 9, losses: 4 },
				},
				{
					roster_id: 5,
					owner_id: "user_5",
					starters: ["7564"],
					players: ["7564"],
					settings: { wins: 2, losses: 11 },
				},
				{
					roster_id: 50,
					owner_id: "user_50",
					starters: ["8138"],
					players: ["8138"],
					settings: { wins: 1, losses: 12 },
				},
			]),
		);

		expect(roster.rank).toBe(5);
		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.record).toBe("2-11");
		expect(roster.rank).not.toBe(50);
	});

	it("maps Sleeper league HTTP 503 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-bench-slot-league")) {
				return new Response("Unavailable", { status: 503 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-bench-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (503)",
		});
	});
});

describe("Grok leftover suffix recId, substring lookup, and numeric content", () => {
	it("uses first name when leftover suffixes VII/IX are 3 chars or fewer", () => {
		expect(recId(namedPlayer("Patrick Mahomes VII"))).toBe("Patrick");
		expect(recId(namedPlayer("Henry Wilson IX"))).toBe("Henry");
		expect(recId(namedPlayer("Patrick Mahomes VII"))).not.toBe("VII");
		expect(recId(namedPlayer("Henry Wilson IX"))).not.toBe("IX");
	});

	it("resolves substring lgei to Tyler Allgeier via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "lgei");

		expect(player?.id).toBe("p_allgeier");
		expect(player?.name).toBe("Tyler Allgeier");
	});

	it("matches first-token rec id Tyler to Allgeier and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const allgeier = resolvePlayer(state, "p_allgeier")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Tyler",
					act: "START",
					vs: "Chase",
					delta: 1,
					conf: 0.8,
					why: "handcuff volume",
					src: "grok",
					flags: [],
				},
				allgeier,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "yler",
					act: "START",
					vs: "Chase",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				allgeier,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded HOLD", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "HOLD ",
							delta: 0,
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
							act: "HOLD ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 4 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 4 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard start and options-state routes", () => {
	it("returns JSON Not Found for PATCH /api/workflow/start because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/start", { method: "PATCH" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns JSON Not Found for PUT /api/workflow/event/:id because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/event/abc", { method: "PUT" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for OPTIONS /api/fantasy/state", async () => {
		const res = await fetchWorker(
			`/api/fantasy/state?teamId=${uniqueId("state-options")}`,
			{ method: "OPTIONS" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
