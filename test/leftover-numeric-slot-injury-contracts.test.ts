import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
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

describe("ESPN leftover numeric starter slots, team ids, and injury case", () => {
	it("maps leftover numeric slots 4/6 to WR/TE starters", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(901, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 9011,
							fullName: "Numeric WR",
							defaultPositionId: 2,
							proTeamId: 15,
						},
					},
				},
				{
					lineupSlotId: 6,
					playerPoolEntry: {
						player: {
							id: 9012,
							fullName: "Numeric TE",
							defaultPositionId: 2,
							proTeamId: 25,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => p.pos)).toEqual(["WR", "TE"]);
		expect(roster.bench).toHaveLength(0);
		expect(roster.starters[0]?.name).toBe("Numeric WR");
		expect(roster.starters[1]?.name).toBe("Numeric TE");
	});

	it("benches leftover string slot 5 using defaultPositionId (QB)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(902, [
				{
					lineupSlotId: "5" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 9021,
							fullName: "Unknown String Slot",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.pos).toBe("QB");
		expect(roster.bench[0]?.name).toBe("Unknown String Slot");
	});

	it("falls unused numeric defaultPositionId 0/6 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(903, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 9031,
							fullName: "Unknown Default Zero",
							defaultPositionId: 0,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 9032,
							fullName: "Unknown Default Six",
							defaultPositionId: 6,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 34 to HOU and 32 to NFL", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(904, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 9041,
							fullName: "String Team HOU",
							defaultPositionId: 2,
							proTeamId: "34" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 9042,
							fullName: "String Gap 32",
							defaultPositionId: 2,
							proTeamId: "32" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team HOU", team: "HOU" },
				{ name: "String Gap 32", team: "NFL" },
			],
		);
	});

	it("maps leftover mixed-case Doubtful/Out/Injury_Reserve after toUpperCase", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(905, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 9051,
							fullName: "Mixed Doubtful",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Doubtful",
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 9052,
							fullName: "Mixed Out",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Out",
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 9053,
							fullName: "Mixed IR",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Injury_Reserve",
						},
					},
				},
			]),
		);

		expect(roster.starters[0]?.status).toBe("DOUBTFUL");
		expect(roster.starters[0]?.tags).toContain("DOUBTFUL");
		expect(roster.starters[1]?.status).toBe("OUT");
		expect(roster.starters[1]?.injuryDesc).toContain("Out");
		expect(roster.bench[0]?.status).toBe("IR");
		expect(roster.bench[0]?.tags).toContain("IR");
	});

	it("uses leftover string scoringPeriodId before currentPeriodId and latestScoringPeriod", () => {
		const { week } = sanitizeEspnTeamRoster({
			id: 906,
			seasonId: 2024,
			scoringPeriodId: "12" as unknown as number,
			currentPeriodId: 8,
			status: { latestScoringPeriod: 11 },
			teams: [{ id: 1, name: "String Scoring Period" }],
		});

		expect(week).toBe("12");
		expect(week).not.toBe(8);
		expect(week).not.toBe(11);
		expect(week).not.toBe(14);
	});

	it("uses leftover string latestScoringPeriod when scoring/current period are omitted", () => {
		const { week } = sanitizeEspnTeamRoster({
			id: 907,
			seasonId: 2024,
			status: { latestScoringPeriod: "10" as unknown as number },
			teams: [{ id: 1, name: "String Latest Period" }],
		});

		expect(week).toBe("10");
		expect(week).not.toBe(14);
	});

	it("maps ESPN HTTP 404 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "404404",
				fetchImpl: async () => new Response("Missing", { status: 404 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 404,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, three-placeholder reindex, and TE-slot override", () => {
	const league = {
		league_id: "leftover-numeric-league",
		name: "Leftover Numeric League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-numeric-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-numeric-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-numeric-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("treats leftover 3-letter NYG and 2-letter NE as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-numeric-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "NYG", "NE"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "NYG Defense", pos: "DST", team: "NYG" },
				{ name: "NE Defense", pos: "DST", team: "NE" },
			],
		);
	});

	it("treats mixed-case Nyg as FLEX Player #Nyg rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-numeric-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Nyg"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Nyg");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Nyg Defense");
	});

	it("reindexes Chase onto WR after dropping three placeholder 0 starters", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-numeric-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "8138", "0", "0", "0", "7564"],
					players: ["4984", "8183", "8138", "0", "0", "0", "7564"],
				},
			]),
		);

		expect(roster.starters).toHaveLength(4);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[3]?.name).toBe("Ja'Marr Chase");
		expect(roster.starters[3]?.pos).toBe("WR");
		expect(roster.starters[3]?.pos).not.toBe("FLEX");
	});

	it("keeps known RB metadata when that player occupies the hardcoded TE slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-numeric-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "8138", "7564", "7553", "8136"],
					players: ["4984", "8183", "8138", "7564", "7553", "8136"],
				},
			]),
		);

		expect(roster.starters[5]?.name).toBe("Tyler Allgeier");
		expect(roster.starters[5]?.pos).toBe("TE");
		expect(roster.starters[5]?.team).toBe("ATL");
		expect(roster.starters[5]?.tags).toContain("Red Zone Handcuff");
		expect(roster.starters[5]?.projPts).toBe(9.2);
	});

	it("treats query 1e2 as parseInt roster 1, not scientific 100", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-numeric-league", userOrRosterId: "1e2" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
					settings: { wins: 9, losses: 4 },
				},
				{
					roster_id: 100,
					owner_id: "user_100",
					starters: ["7564"],
					players: ["7564"],
					settings: { wins: 1, losses: 12 },
				},
			]),
		);

		expect(roster.rank).toBe(1);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.record).toBe("9-4");
	});

	it("maps Sleeper league HTTP 401 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-numeric-league")) {
				return new Response("Unauthorized", { status: 401 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "leftover-numeric-league" }, fetchImpl),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (401)",
		});
	});
});

describe("Grok leftover suffix recId, substring lookup, and numeric content", () => {
	it("uses first name when leftover suffixes II/Sr. are 3 chars or fewer", () => {
		expect(recId(namedPlayer("Aaron Rodgers II"))).toBe("Aaron");
		expect(recId(namedPlayer("Jim Brown Sr."))).toBe("Jim");
		expect(recId(namedPlayer("Jim Brown Sr."))).not.toBe("Sr.");
	});

	it("resolves substring kitt to George Kittle via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "kitt");

		expect(player?.id).toBe("p_kittle");
		expect(player?.name).toBe("George Kittle");
	});

	it("matches first-token rec id George to Kittle and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const kittle = resolvePlayer(state, "p_kittle")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "George",
					act: "START",
					vs: "Ferguson",
					delta: 1,
					conf: 0.8,
					why: "red zone",
					src: "grok",
					flags: [],
				},
				kittle,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "eorg",
					act: "START",
					vs: "Ferguson",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				kittle,
			),
		).toBe(false);
	});

	it("coerces omitted recs[].conf to 0 and stringifies numeric why", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						delta: -2,
						why: 12,
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(recs[0]?.conf).toBe(0);
		expect(recs[0]?.why).toBe("12");
	});

	it("throws TypeError when xAI content is a truthy number (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 1 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover trailing-slash intel/import routes", () => {
	it("returns 400 Expected WebSocket for POST /api/fantasy/intel/refresh/ trailing slash", async () => {
		const res = await fetchWorker(
			`/api/fantasy/intel/refresh/?teamId=${uniqueId("intel-slash")}`,
			{ method: "POST" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket for POST /api/fantasy/roster/sleeper-import/ trailing slash", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/sleeper-import/?teamId=${uniqueId("sleeper-slash")}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leagueId: "1122334455" }),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns JSON Not Found for /api/workflow/status without a trailing id segment", async () => {
		const res = await fetchWorker("/api/workflow/status");

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});
});
