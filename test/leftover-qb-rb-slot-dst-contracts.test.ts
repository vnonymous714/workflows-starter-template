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

describe("ESPN leftover numeric QB/RB slots, team ids, and injury padding", () => {
	it("maps leftover numeric slots 0/2 to QB/RB starters even when defaultPositionId is WR", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1001, [
				{
					lineupSlotId: 0,
					playerPoolEntry: {
						player: {
							id: 10011,
							fullName: "Numeric QB",
							defaultPositionId: 3,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 10012,
							fullName: "Numeric RB",
							defaultPositionId: 3,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => p.pos)).toEqual(["QB", "RB"]);
		expect(roster.bench).toHaveLength(0);
		expect(roster.starters[0]?.name).toBe("Numeric QB");
		expect(roster.starters[1]?.name).toBe("Numeric RB");
	});

	it("benches leftover string slots 1/3 using defaultPositionId (QB/WR)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1002, [
				{
					lineupSlotId: "1" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 10021,
							fullName: "Unknown String Slot One",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: "3" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 10022,
							fullName: "Unknown String Slot Three",
							defaultPositionId: 3,
							proTeamId: 15,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown String Slot One", pos: "QB" },
			{ name: "Unknown String Slot Three", pos: "WR" },
		]);
	});

	it("falls unused string defaultPositionId 0/7 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1003, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 10031,
							fullName: "Unknown Default String Zero",
							defaultPositionId: "0" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 10032,
							fullName: "Unknown Default String Seven",
							defaultPositionId: "7" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 19 to NYG and 17 to NE", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1004, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 10041,
							fullName: "String Team NYG",
							defaultPositionId: 2,
							proTeamId: "19" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 10042,
							fullName: "String Team NE",
							defaultPositionId: 2,
							proTeamId: "17" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team NYG", team: "NYG" },
				{ name: "String Team NE", team: "NE" },
			],
		);
	});

	it("maps leftover mixed-case Ir to IR and keeps padded mixed Out as ACTIVE", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1005, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 10051,
							fullName: "Mixed Ir",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Ir",
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 10052,
							fullName: "Padded Mixed Out",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Out ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("IR");
		expect(roster.bench[0]?.tags).toContain("IR");
		expect(roster.bench[0]?.injuryDesc).toContain("Ir");
		expect(roster.starters[0]?.status).toBe("ACTIVE");
		expect(roster.starters[0]?.tags).toBeUndefined();
		expect(roster.starters[0]?.injuryDesc).toBeUndefined();
	});

	it("uses leftover numeric latestScoringPeriod when scoring/current period are omitted", () => {
		const { week } = sanitizeEspnTeamRoster({
			id: 1006,
			seasonId: 2024,
			status: { latestScoringPeriod: 13 },
			teams: [{ id: 1, name: "Numeric Latest Period" }],
		});

		expect(week).toBe(13);
		expect(week).not.toBe(14);
	});

	it("adds High Floor when leftover appliedStatTotal is exactly 18", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1007, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						appliedStatTotal: 18,
						player: {
							id: 10071,
							fullName: "Exact High Floor",
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

	it("maps ESPN HTTP 500 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "500500",
				fetchImpl: async () => new Response("Boom", { status: 500 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 500,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, four-placeholder reindex, and QB-slot override", () => {
	const league = {
		league_id: "leftover-qb-rb-league",
		name: "Leftover QB RB League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-qb-rb-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-qb-rb-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-qb-rb-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("treats leftover 3-letter PHI and 2-letter GB as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-qb-rb-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "PHI", "GB"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "PHI Defense", pos: "DST", team: "PHI" },
				{ name: "GB Defense", pos: "DST", team: "GB" },
			],
		);
	});

	it("treats mixed-case Phi as FLEX Player #Phi rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-qb-rb-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Phi"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Phi");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Phi Defense");
	});

	it("reindexes Chase onto the second WR after dropping four placeholder 0 starters", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-qb-rb-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "8138", "7553", "0", "0", "0", "0", "7564"],
					players: ["4984", "8183", "8138", "7553", "0", "0", "0", "0", "7564"],
				},
			]),
		);

		expect(roster.starters).toHaveLength(5);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[3]?.name).toBe("Jaylen Waddle");
		expect(roster.starters[3]?.pos).toBe("WR");
		expect(roster.starters[4]?.name).toBe("Ja'Marr Chase");
		expect(roster.starters[4]?.pos).toBe("WR");
		expect(roster.starters[4]?.pos).not.toBe("FLEX");
		expect(roster.starters[4]?.pos).not.toBe("TE");
	});

	it("keeps known RB metadata when that player occupies the hardcoded QB slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-qb-rb-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["8136", "8183"],
					players: ["8136", "8183"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Tyler Allgeier");
		expect(roster.starters[0]?.pos).toBe("QB");
		expect(roster.starters[0]?.team).toBe("ATL");
		expect(roster.starters[0]?.tags).toContain("Red Zone Handcuff");
		expect(roster.starters[0]?.projPts).toBe(9.2);
	});

	it("treats query 2e1 as parseInt roster 2, not scientific 20", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-qb-rb-league", userOrRosterId: "2e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
					settings: { wins: 9, losses: 4 },
				},
				{
					roster_id: 2,
					owner_id: "user_2",
					starters: ["7564"],
					players: ["7564"],
					settings: { wins: 3, losses: 10 },
				},
				{
					roster_id: 20,
					owner_id: "user_20",
					starters: ["8138"],
					players: ["8138"],
					settings: { wins: 1, losses: 12 },
				},
			]),
		);

		expect(roster.rank).toBe(2);
		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.record).toBe("3-10");
		expect(roster.rank).not.toBe(20);
	});

	it("maps Sleeper league HTTP 500 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-qb-rb-league")) {
				return new Response("Boom", { status: 500 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "leftover-qb-rb-league" }, fetchImpl),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (500)",
		});
	});
});

describe("Grok leftover suffix recId, substring lookup, and boolean content", () => {
	it("uses first name when leftover suffixes IV/Jr are 3 chars or fewer", () => {
		expect(recId(namedPlayer("Michael Thomas IV"))).toBe("Michael");
		expect(recId(namedPlayer("Odell Beckham Jr"))).toBe("Odell");
		expect(recId(namedPlayer("Odell Beckham Jr"))).not.toBe("Jr");
		expect(recId(namedPlayer("Michael Thomas IV"))).not.toBe("IV");
	});

	it("resolves substring ergu to Jake Ferguson via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "ergu");

		expect(player?.id).toBe("p_ferguson");
		expect(player?.name).toBe("Jake Ferguson");
	});

	it("matches first-token rec id Jake to Ferguson and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const ferguson = resolvePlayer(state, "p_ferguson")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Jake",
					act: "START",
					vs: "Kittle",
					delta: 1,
					conf: 0.8,
					why: "red zone",
					src: "grok",
					flags: [],
				},
				ferguson,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "ake",
					act: "START",
					vs: "Kittle",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				ferguson,
			),
		).toBe(false);
	});

	it("defaults omitted recs[].why to empty and omitted flags to []", () => {
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
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(recs[0]?.why).toBe("");
		expect(recs[0]?.flags).toEqual([]);
		expect(recs[0]?.vs).toBe("");
		expect(recs[0]?.src).toBe("grok");
	});

	it("throws TypeError when xAI content is boolean true (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: true } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard and trailing-slash start routes", () => {
	it("returns JSON Not Found for GET /api/workflow/event/:id because the route is POST-only", async () => {
		const res = await fetchWorker(`/api/workflow/event/${uniqueId("event-get")}`);

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns JSON Not Found for POST /api/workflow/start/ trailing slash", async () => {
		const res = await fetchWorker("/api/workflow/start/", { method: "POST" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for PUT /api/fantasy/state", async () => {
		const res = await fetchWorker(
			`/api/fantasy/state?teamId=${uniqueId("state-put")}`,
			{ method: "PUT" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
