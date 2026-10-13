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

describe("ESPN leftover unknown slots, unused team ids, and rounding", () => {
	it("benches leftover numeric unknown slots 5/7 using defaultPositionId (QB/TE)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1101, [
				{
					lineupSlotId: 5,
					playerPoolEntry: {
						player: {
							id: 11011,
							fullName: "Unknown Numeric Slot Five",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 7,
					playerPoolEntry: {
						player: {
							id: 11012,
							fullName: "Unknown Numeric Slot Seven",
							defaultPositionId: 4,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Five", pos: "QB" },
			{ name: "Unknown Numeric Slot Seven", pos: "TE" },
		]);
	});

	it("falls unused leftover string defaultPositionId 6/8 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1102, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 11021,
							fullName: "Unknown Default String Six",
							defaultPositionId: "6" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 11022,
							fullName: "Unknown Default String Eight",
							defaultPositionId: "8" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 21 to PHI and 9 to GB", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1103, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 11031,
							fullName: "String Team PHI",
							defaultPositionId: 2,
							proTeamId: "21" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 11032,
							fullName: "String Team GB",
							defaultPositionId: 2,
							proTeamId: "9" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team PHI", team: "PHI" },
				{ name: "String Team GB", team: "GB" },
			],
		);
	});

	it("keeps leftover padded mixed Ir as ACTIVE (inverse of leftover mixed Ir)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1104, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 11041,
							fullName: "Padded Mixed Ir",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Ir ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("adds High Floor when leftover appliedStatTotal 17.96 rounds to 18", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1105, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						appliedStatTotal: 17.96,
						player: {
							id: 11051,
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

	it("maps ESPN HTTP 429 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "429429",
				fetchImpl: async () => new Response("Slow down", { status: 429 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 429,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, five-placeholder reindex, and WR-slot override", () => {
	const league = {
		league_id: "leftover-unknown-slot-league",
		name: "Leftover Unknown Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-unknown-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-unknown-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-unknown-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("treats leftover 3-letter SEA and 2-letter KC as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unknown-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "SEA", "KC"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "SEA Defense", pos: "DST", team: "SEA" },
				{ name: "KC Defense", pos: "DST", team: "KC" },
			],
		);
	});

	it("treats mixed-case Sea as FLEX Player #Sea rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unknown-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Sea"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Sea");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Sea Defense");
	});

	it("reindexes Chase onto TE after dropping five placeholder 0 starters", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unknown-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: [
						"4984",
						"8183",
						"8138",
						"7553",
						"4035",
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

		expect(roster.starters).toHaveLength(6);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[3]?.name).toBe("Jaylen Waddle");
		expect(roster.starters[3]?.pos).toBe("WR");
		expect(roster.starters[4]?.name).toBe("George Kittle");
		expect(roster.starters[4]?.pos).toBe("WR");
		expect(roster.starters[5]?.name).toBe("Ja'Marr Chase");
		expect(roster.starters[5]?.pos).toBe("TE");
		expect(roster.starters[5]?.pos).not.toBe("WR");
		expect(roster.starters[5]?.pos).not.toBe("FLEX");
	});

	it("keeps known RB metadata when that player occupies the hardcoded WR slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unknown-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "8138", "8136"],
					players: ["4984", "8183", "8138", "8136"],
				},
			]),
		);

		expect(roster.starters[3]?.name).toBe("Tyler Allgeier");
		expect(roster.starters[3]?.pos).toBe("WR");
		expect(roster.starters[3]?.team).toBe("ATL");
		expect(roster.starters[3]?.tags).toContain("Red Zone Handcuff");
		expect(roster.starters[3]?.projPts).toBe(9.2);
	});

	it("treats query 3e1 as parseInt roster 3, not scientific 30", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-unknown-slot-league", userOrRosterId: "3e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
					settings: { wins: 9, losses: 4 },
				},
				{
					roster_id: 3,
					owner_id: "user_3",
					starters: ["7564"],
					players: ["7564"],
					settings: { wins: 4, losses: 9 },
				},
				{
					roster_id: 30,
					owner_id: "user_30",
					starters: ["8138"],
					players: ["8138"],
					settings: { wins: 1, losses: 12 },
				},
			]),
		);

		expect(roster.rank).toBe(3);
		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.record).toBe("4-9");
		expect(roster.rank).not.toBe(30);
	});

	it("maps Sleeper league HTTP 429 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-unknown-slot-league")) {
				return new Response("Slow down", { status: 429 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-unknown-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (429)",
		});
	});
});

describe("Grok leftover suffix recId, substring lookup, and numeric content", () => {
	it("uses first name when leftover suffixes Sr/V are 3 chars or fewer", () => {
		expect(recId(namedPlayer("Jim Brown Sr"))).toBe("Jim");
		expect(recId(namedPlayer("Henry Wilson V"))).toBe("Henry");
		expect(recId(namedPlayer("Jim Brown Sr"))).not.toBe("Sr");
		expect(recId(namedPlayer("Henry Wilson V"))).not.toBe("V");
	});

	it("resolves substring addl to Jaylen Waddle via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "addl");

		expect(player?.id).toBe("p_waddle");
		expect(player?.name).toBe("Jaylen Waddle");
	});

	it("matches first-token rec id Jaylen to Waddle and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const waddle = resolvePlayer(state, "p_waddle")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Jaylen",
					act: "START",
					vs: "Chase",
					delta: 1,
					conf: 0.8,
					why: "slot work",
					src: "grok",
					flags: [],
				},
				waddle,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "ayle",
					act: "START",
					vs: "Chase",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				waddle,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is omitted", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
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
							delta: -2,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 2 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 2 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard start and delete-state routes", () => {
	it("returns JSON Not Found for GET /api/workflow/start because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/start");

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns JSON Not Found for GET /api/workflow/event without an id segment", async () => {
		const res = await fetchWorker("/api/workflow/event");

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for DELETE /api/fantasy/state", async () => {
		const res = await fetchWorker(
			`/api/fantasy/state?teamId=${uniqueId("state-delete")}`,
			{ method: "DELETE" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
