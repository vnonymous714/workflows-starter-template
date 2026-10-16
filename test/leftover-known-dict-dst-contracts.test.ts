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
	it("benches leftover numeric unknown slots 12/13 using defaultPositionId (RB/TE)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1401, [
				{
					lineupSlotId: 12,
					playerPoolEntry: {
						player: {
							id: 14011,
							fullName: "Unknown Numeric Slot Twelve",
							defaultPositionId: 2,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 13,
					playerPoolEntry: {
						player: {
							id: 14012,
							fullName: "Unknown Numeric Slot Thirteen",
							defaultPositionId: 4,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Twelve", pos: "RB" },
			{ name: "Unknown Numeric Slot Thirteen", pos: "TE" },
		]);
	});

	it("falls unused leftover string defaultPositionId 11/12 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1402, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 14021,
							fullName: "Unknown Default String Eleven",
							defaultPositionId: "11" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 14022,
							fullName: "Unknown Default String Twelve",
							defaultPositionId: "12" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 16 to MIN and 20 to NYJ", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1403, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 14031,
							fullName: "String Team MIN",
							defaultPositionId: 3,
							proTeamId: "16" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 14032,
							fullName: "String Team NYJ",
							defaultPositionId: 2,
							proTeamId: "20" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team MIN", team: "MIN" },
				{ name: "String Team NYJ", team: "NYJ" },
			],
		);
	});

	it("keeps leftover padded mixed Injury_Reserve as ACTIVE (leftover of leftover padded Questionable)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1404, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 14041,
							fullName: "Padded Mixed Injury Reserve",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Injury_Reserve ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 504 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "504504",
				fetchImpl: async () => new Response("Gateway Timeout", { status: 504 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 504,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover known dictionary, DST letters, and second-RB override", () => {
	const league = {
		league_id: "leftover-known-dict-league",
		name: "Leftover Known Dict League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-known-dict-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-known-dict-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-known-dict-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("maps leftover known ids 6797/8155/6801/9226 instead of generic Player # fallbacks", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-known-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "6797", "8155", "6801", "9226"],
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
				id: "p_6797",
				name: "Justin Jefferson",
				pos: "WR",
				team: "MIN",
				opp: "vs ATL",
				projPts: 19.5,
			},
			{
				id: "p_8155",
				name: "Breece Hall",
				pos: "RB",
				team: "NYJ",
				opp: "vs MIA",
				projPts: 17.1,
			},
			{
				id: "p_6801",
				name: "CeeDee Lamb",
				pos: "WR",
				team: "DAL",
				opp: "vs CIN",
				projPts: 19.1,
			},
			{
				id: "p_9226",
				name: "Sam LaPorta",
				pos: "TE",
				team: "DET",
				opp: "vs GB",
				projPts: 13.5,
			},
		]);
		expect(roster.bench[0]?.tags).toEqual(["Target Magnet", "WR1"]);
		expect(roster.bench[1]?.tags).toEqual(["Dual Threat", "High Floor"]);
		expect(roster.bench[2]?.tags).toEqual(["Alpha WR", "High Volume"]);
		expect(roster.bench[3]?.tags).toEqual(["Red Zone Weapon"]);
		expect(roster.bench.map((p) => p.name)).not.toContain("Player #6797");
		expect(roster.bench.map((p) => p.name)).not.toContain("Player #8155");
	});

	it("keeps leftover known WR metadata when that player occupies the hardcoded second RB slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-known-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "6797"],
					players: ["4984", "8183", "6797"],
				},
			]),
		);

		expect(roster.starters[2]?.name).toBe("Justin Jefferson");
		expect(roster.starters[2]?.pos).toBe("RB");
		expect(roster.starters[2]?.team).toBe("MIN");
		expect(roster.starters[2]?.opp).toBe("vs ATL");
		expect(roster.starters[2]?.projPts).toBe(19.5);
		expect(roster.starters[2]?.tags).toContain("Target Magnet");
		expect(roster.starters[2]?.pos).not.toBe("WR");
		expect(roster.starters[2]?.name).not.toBe("Player #6797");
	});

	it("treats leftover 3-letter CHI and CIN as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-known-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "CHI", "CIN"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "CHI Defense", pos: "DST", team: "CHI" },
				{ name: "CIN Defense", pos: "DST", team: "CIN" },
			],
		);
	});

	it("treats mixed-case Chi as FLEX Player #Chi rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-known-dict-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Chi"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Chi");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Chi Defense");
	});

	it("maps Sleeper league HTTP 504 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-known-dict-league")) {
				return new Response("Gateway Timeout", { status: 504 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-known-dict-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (504)",
		});
	});
});

describe("Grok leftover VIII recId boundary, substring lookup, and numeric content", () => {
	it("uses the 4-char leftover suffix VIII as the rec key and first name for leftover X", () => {
		expect(recId(namedPlayer("Patrick Mahomes VIII"))).toBe("VIII");
		expect(recId(namedPlayer("Patrick Mahomes VIII"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes VIII"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Henry Wilson X"))).toBe("Henry");
		expect(recId(namedPlayer("Henry Wilson X"))).not.toBe("X");
	});

	it("resolves substring harb to Zach Charbonnet via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "harb");

		expect(player?.id).toBe("p_charbonnet");
		expect(player?.name).toBe("Zach Charbonnet");
	});

	it("matches first-token rec id Zach to Charbonnet and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Zach",
					act: "START",
					vs: "Kyren",
					delta: 1,
					conf: 0.8,
					why: "goal line volume",
					src: "grok",
					flags: [],
				},
				charbonnet,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "ach",
					act: "START",
					vs: "Kyren",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				charbonnet,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded SIT", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "SIT ",
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
							act: "SIT ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 5 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 5 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard start and decide routes", () => {
	it("returns JSON Not Found for OPTIONS /api/workflow/start because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/start", { method: "OPTIONS" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns JSON Not Found for PATCH /api/workflow/event/:id because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/event/abc", {
			method: "PATCH",
		});

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for HEAD /api/fantasy/decide", async () => {
		const res = await fetchWorker(
			`/api/fantasy/decide?teamId=${uniqueId("decide-head")}`,
			{ method: "HEAD" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("");
	});
});
