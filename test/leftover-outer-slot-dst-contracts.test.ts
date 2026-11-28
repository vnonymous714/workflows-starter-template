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

describe("ESPN leftover outer slots, unused ids, and leading-padded OUT", () => {
	it("benches leftover numeric unknown slots 33/34 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2201, [
				{
					lineupSlotId: 33,
					playerPoolEntry: {
						player: {
							id: 22011,
							fullName: "Unknown Numeric Slot Thirty Three",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 34,
					playerPoolEntry: {
						player: {
							id: 22012,
							fullName: "Unknown Numeric Slot Thirty Four",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Thirty Three", pos: "QB" },
			{ name: "Unknown Numeric Slot Thirty Four", pos: "K" },
		]);
	});

	it("falls unused leftover string defaultPositionId 28/29 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2202, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 22021,
							fullName: "Unknown Default String Twenty Eight",
							defaultPositionId: "28" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 22022,
							fullName: "Unknown Default String Twenty Nine",
							defaultPositionId: "29" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 26 to SEA and 27 to TB", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2203, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 22031,
							fullName: "String Team SEA",
							defaultPositionId: 3,
							proTeamId: "26" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 22032,
							fullName: "String Team TB",
							defaultPositionId: 2,
							proTeamId: "27" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team SEA", team: "SEA" },
				{ name: "String Team TB", team: "TB" },
			],
		);
	});

	it("keeps leftover leading-padded all-caps OUT as ACTIVE (leftover of leading padded QUESTIONABLE)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2204, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 22041,
							fullName: "Leading Padded Caps OUT",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: " OUT",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 414 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "414414",
				fetchImpl: async () =>
					new Response("URI Too Long", { status: 414 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 414,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, scientific query, and JSN DST override", () => {
	const league = {
		league_id: "leftover-outer-slot-league",
		name: "Leftover Outer Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-outer-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-outer-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-outer-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("keeps leftover known WR metadata when that player occupies the hardcoded DST slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-outer-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: [
						"4984",
						"8183",
						"8138",
						"8136",
						"9221",
						"4035",
						"7564",
						"11439",
						"9493",
					],
					players: [
						"4984",
						"8183",
						"8138",
						"8136",
						"9221",
						"4035",
						"7564",
						"11439",
						"9493",
					],
				},
			]),
		);

		expect(roster.starters[8]?.name).toBe("Jaxon Smith-Njigba");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[8]?.team).toBe("SEA");
		expect(roster.starters[8]?.opp).toBe("@ ARI");
		expect(roster.starters[8]?.projPts).toBe(15.9);
		expect(roster.starters[8]?.tags).toEqual(["Full Practice Fri", "Slot Funnel"]);
		expect(roster.starters[8]?.pos).not.toBe("WR");
		expect(roster.starters[8]?.name).not.toBe("Player #9493");
	});

	it("treats leftover 3-letter LV and PIT as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-outer-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "LV", "PIT"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "LV Defense", pos: "DST", team: "LV" },
				{ name: "PIT Defense", pos: "DST", team: "PIT" },
			],
		);
	});

	it("treats mixed-case Lv as FLEX Player #Lv rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-outer-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Lv"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Lv");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Lv Defense");
	});

	it("parses leftover query 12e1 as roster 12 rather than 120", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-outer-slot-league", userOrRosterId: "12e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
				},
				{
					roster_id: 12,
					owner_id: "user_12",
					starters: ["7564"],
					players: ["7564"],
				},
				{
					roster_id: 120,
					owner_id: "user_120",
					starters: ["8138"],
					players: ["8138"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.teamName).toContain("Team 12");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});

	it("maps Sleeper league HTTP 414 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-outer-slot-league")) {
				return new Response("URI Too Long", { status: 414 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-outer-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (414)",
		});
	});
});

describe("Grok leftover XXV recId boundary, Kittle lookup, and numeric content", () => {
	it("uses first name for leftover 3-char suffix XXV and the 5-char leftover XXVII as the rec key", () => {
		expect(recId(namedPlayer("Patrick Mahomes XXV"))).toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XXV"))).not.toBe("XXV");
		expect(recId(namedPlayer("Patrick Mahomes XXV"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Patrick Mahomes XXVII"))).toBe("XXVII");
		expect(recId(namedPlayer("Patrick Mahomes XXVII"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XXVII"))).not.toBe("Mahomes");
	});

	it("resolves substring ittl to George Kittle via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "ittl");

		expect(player?.id).toBe("p_kittle");
		expect(player?.name).toBe("George Kittle");
	});

	it("matches last-token rec id Kittle and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const kittle = resolvePlayer(state, "p_kittle")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Kittle",
					act: "START",
					vs: "Ferguson",
					delta: 2.4,
					conf: 0.71,
					why: "red zone focus",
					src: "grok",
					flags: ["SPLIT"],
				},
				kittle,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "ittl",
					act: "START",
					vs: "Ferguson",
					delta: 2.4,
					conf: 0.71,
					why: "partial",
					src: "grok",
					flags: ["SPLIT"],
				},
				kittle,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a leading-padded SIT", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: " SIT",
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
							act: " SIT",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 13 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 13 } }],
						usage: { total_tokens: 13 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard roster/swap and espn/sync routes", () => {
	it("returns 400 Expected WebSocket for DELETE /api/fantasy/roster/swap", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${uniqueId("swap-delete")}`,
			{ method: "DELETE" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket with a text body for OPTIONS /api/fantasy/roster/swap", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${uniqueId("swap-options")}`,
			{ method: "OPTIONS" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket for PATCH /api/fantasy/espn/sync", async () => {
		const res = await fetchWorker(
			`/api/fantasy/espn/sync?teamId=${uniqueId("espn-patch")}`,
			{ method: "PATCH" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
