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

describe("ESPN leftover unknown bench slots, unused team ids, and padded IR", () => {
	it("benches leftover numeric unknown slots 14/15 using defaultPositionId (K/DST)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1501, [
				{
					lineupSlotId: 14,
					playerPoolEntry: {
						player: {
							id: 15011,
							fullName: "Unknown Numeric Slot Fourteen",
							defaultPositionId: 5,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 15,
					playerPoolEntry: {
						player: {
							id: 15012,
							fullName: "Unknown Numeric Slot Fifteen",
							defaultPositionId: 16,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Fourteen", pos: "K" },
			{ name: "Unknown Numeric Slot Fifteen", pos: "DST" },
		]);
	});

	it("falls unused leftover string defaultPositionId 13/14 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1502, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 15021,
							fullName: "Unknown Default String Thirteen",
							defaultPositionId: "13" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 15022,
							fullName: "Unknown Default String Fourteen",
							defaultPositionId: "14" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 1 to ATL and 2 to BUF", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1503, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 15031,
							fullName: "String Team ATL",
							defaultPositionId: 3,
							proTeamId: "1" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 15032,
							fullName: "String Team BUF",
							defaultPositionId: 2,
							proTeamId: "2" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team ATL", team: "ATL" },
				{ name: "String Team BUF", team: "BUF" },
			],
		);
	});

	it("keeps leftover padded all-caps INJURY_RESERVE as ACTIVE (leftover of leftover padded Injury_Reserve)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1504, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 15041,
							fullName: "Padded Caps Injury Reserve",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "INJURY_RESERVE ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 400 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "400400",
				fetchImpl: async () => new Response("Bad Request", { status: 400 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 400,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover seed dictionary, DST letters, and second-WR override", () => {
	const league = {
		league_id: "leftover-seed-dict-league",
		name: "Leftover Seed Dict League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-seed-dict-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-seed-dict-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-seed-dict-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("maps leftover known seed ids 8183/7553/4035/9493 instead of generic Player # fallbacks", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-seed-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "8183", "7553", "4035", "9493"],
				},
			]),
		);

		expect(roster.bench.map((p) => ({
			id: p.id,
			name: p.name,
			pos: p.pos,
			team: p.team,
			opp: p.opp,
			projPts: p.projPts,
		}))).toEqual([
			{
				id: "p_8183",
				name: "Bijan Robinson",
				pos: "RB",
				team: "ATL",
				opp: "@ CAR",
				projPts: 18.6,
			},
			{
				id: "p_7553",
				name: "Jaylen Waddle",
				pos: "WR",
				team: "MIA",
				opp: "@ NYJ",
				projPts: 13.8,
			},
			{
				id: "p_4035",
				name: "George Kittle",
				pos: "TE",
				team: "SF",
				opp: "vs CHI",
				projPts: 14.1,
			},
			{
				id: "p_9493",
				name: "Jaxon Smith-Njigba",
				pos: "WR",
				team: "SEA",
				opp: "@ ARI",
				projPts: 15.9,
			},
		]);
		expect(roster.bench[0]?.tags).toEqual(["Bellcow", "Target Funnel"]);
		expect(roster.bench[1]?.tags).toEqual(["Shadow Coverage", "Deep Threat"]);
		expect(roster.bench[2]?.tags).toEqual(["Red Zone Focus", "High YAC"]);
		expect(roster.bench[3]?.tags).toEqual(["Full Practice Fri", "Slot Funnel"]);
		expect(roster.bench.map((p) => p.name)).not.toContain("Player #8183");
		expect(roster.bench.map((p) => p.name)).not.toContain("Player #9493");
	});

	it("keeps leftover known RB metadata when that player occupies the hardcoded second WR slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-seed-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "8138", "7564", "9221"],
					players: ["4984", "8183", "8138", "7564", "9221"],
				},
			]),
		);

		expect(roster.starters[4]?.name).toBe("Zach Charbonnet");
		expect(roster.starters[4]?.pos).toBe("WR");
		expect(roster.starters[4]?.team).toBe("SEA");
		expect(roster.starters[4]?.opp).toBe("@ ARI");
		expect(roster.starters[4]?.projPts).toBe(16.2);
		expect(roster.starters[4]?.tags).toContain("Handcuff Smash");
		expect(roster.starters[4]?.pos).not.toBe("RB");
		expect(roster.starters[4]?.name).not.toBe("Player #9221");
	});

	it("treats leftover 3-letter CLE and DAL as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-seed-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "CLE", "DAL"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "CLE Defense", pos: "DST", team: "CLE" },
				{ name: "DAL Defense", pos: "DST", team: "DAL" },
			],
		);
	});

	it("treats mixed-case Cle as FLEX Player #Cle rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-seed-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Cle"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Cle");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Cle Defense");
	});

	it("maps Sleeper league HTTP 400 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-seed-dict-league")) {
				return new Response("Bad Request", { status: 400 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-seed-dict-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (400)",
		});
	});
});

describe("Grok leftover XIII recId boundary, substring lookup, and numeric content", () => {
	it("uses the 4-char leftover suffix XIII as the rec key and first name for leftover XI/XII", () => {
		expect(recId(namedPlayer("Patrick Mahomes XIII"))).toBe("XIII");
		expect(recId(namedPlayer("Patrick Mahomes XIII"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XIII"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Henry Wilson XI"))).toBe("Henry");
		expect(recId(namedPlayer("Henry Wilson XI"))).not.toBe("XI");
		expect(recId(namedPlayer("Henry Wilson XII"))).toBe("Henry");
		expect(recId(namedPlayer("Henry Wilson XII"))).not.toBe("XII");
	});

	it("resolves substring axon to Jaxon Smith-Njigba via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "axon");

		expect(player?.id).toBe("p_jsn");
		expect(player?.name).toBe("Jaxon Smith-Njigba");
	});

	it("matches first-token rec id Jaxon to Smith-Njigba and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const jsn = resolvePlayer(state, "p_jsn")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Jaxon",
					act: "START",
					vs: "Waddle",
					delta: 1,
					conf: 0.8,
					why: "slot targets",
					src: "grok",
					flags: [],
				},
				jsn,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "axo",
					act: "START",
					vs: "Waddle",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				jsn,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded ADD", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "ADD ",
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
							act: "ADD ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 6 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 6 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard start and swap routes", () => {
	it("returns JSON Not Found for HEAD /api/workflow/start because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/start", { method: "HEAD" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns JSON Not Found for OPTIONS /api/workflow/event/:id because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/event/abc", {
			method: "OPTIONS",
		});

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for HEAD /api/fantasy/roster/swap", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${uniqueId("swap-head")}`,
			{ method: "HEAD" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("");
	});
});
