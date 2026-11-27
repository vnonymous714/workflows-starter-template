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

describe("ESPN leftover far slots, unused ids, and leading-padded QUESTIONABLE", () => {
	it("benches leftover numeric unknown slots 31/32 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2101, [
				{
					lineupSlotId: 31,
					playerPoolEntry: {
						player: {
							id: 21011,
							fullName: "Unknown Numeric Slot Thirty One",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 32,
					playerPoolEntry: {
						player: {
							id: 21012,
							fullName: "Unknown Numeric Slot Thirty Two",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Thirty One", pos: "QB" },
			{ name: "Unknown Numeric Slot Thirty Two", pos: "K" },
		]);
	});

	it("falls unused leftover string defaultPositionId 26/27 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2102, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 21021,
							fullName: "Unknown Default String Twenty Six",
							defaultPositionId: "26" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 21022,
							fullName: "Unknown Default String Twenty Seven",
							defaultPositionId: "27" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 24 to LAC and 25 to SF", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2103, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 21031,
							fullName: "String Team LAC",
							defaultPositionId: 3,
							proTeamId: "24" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 21032,
							fullName: "String Team SF",
							defaultPositionId: 2,
							proTeamId: "25" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team LAC", team: "LAC" },
				{ name: "String Team SF", team: "SF" },
			],
		);
	});

	it("keeps leftover leading-padded all-caps QUESTIONABLE as ACTIVE (leftover of leading padded DOUBTFUL)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2104, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 21041,
							fullName: "Leading Padded Caps QUESTIONABLE",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: " QUESTIONABLE",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 413 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "413413",
				fetchImpl: async () =>
					new Response("Payload Too Large", { status: 413 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 413,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, scientific query, and LaPorta DST override", () => {
	const league = {
		league_id: "leftover-far-slot-league",
		name: "Leftover Far Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-far-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-far-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-far-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("keeps leftover known TE metadata when that player occupies the hardcoded DST slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-far-slot-league" },
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
						"9226",
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
						"9226",
					],
				},
			]),
		);

		expect(roster.starters[8]?.name).toBe("Sam LaPorta");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[8]?.team).toBe("DET");
		expect(roster.starters[8]?.opp).toBe("vs GB");
		expect(roster.starters[8]?.projPts).toBe(13.5);
		expect(roster.starters[8]?.tags).toEqual(["Red Zone Weapon"]);
		expect(roster.starters[8]?.pos).not.toBe("TE");
		expect(roster.starters[8]?.name).not.toBe("Player #9226");
	});

	it("treats leftover 3-letter MIN and MIA as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-far-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "MIN", "MIA"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "MIN Defense", pos: "DST", team: "MIN" },
				{ name: "MIA Defense", pos: "DST", team: "MIA" },
			],
		);
	});

	it("treats mixed-case Min as FLEX Player #Min rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-far-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Min"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Min");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Min Defense");
	});

	it("parses leftover query 11e1 as roster 11 rather than 110", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-far-slot-league", userOrRosterId: "11e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
				},
				{
					roster_id: 11,
					owner_id: "user_11",
					starters: ["7564"],
					players: ["7564"],
				},
				{
					roster_id: 110,
					owner_id: "user_110",
					starters: ["8138"],
					players: ["8138"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.teamName).toContain("Team 11");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});

	it("maps Sleeper league HTTP 413 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-far-slot-league")) {
				return new Response("Payload Too Large", { status: 413 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-far-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (413)",
		});
	});
});

describe("Grok leftover XXI recId boundary, Waddle lookup, and numeric content", () => {
	it("uses first name for leftover 3-char suffix XXI and the 4-char leftover XXVI as the rec key", () => {
		expect(recId(namedPlayer("Patrick Mahomes XXI"))).toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XXI"))).not.toBe("XXI");
		expect(recId(namedPlayer("Patrick Mahomes XXI"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Patrick Mahomes XXVI"))).toBe("XXVI");
		expect(recId(namedPlayer("Patrick Mahomes XXVI"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XXVI"))).not.toBe("Mahomes");
	});

	it("resolves substring wadd to Jaylen Waddle via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "wadd");

		expect(player?.id).toBe("p_waddle");
		expect(player?.name).toBe("Jaylen Waddle");
	});

	it("matches last-token rec id Waddle and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const waddle = resolvePlayer(state, "p_waddle")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Waddle",
					act: "SIT",
					vs: "JSN",
					delta: -2.1,
					conf: 0.68,
					why: "shadow coverage",
					src: "grok",
					flags: ["SPLIT"],
				},
				waddle,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "wadd",
					act: "SIT",
					vs: "JSN",
					delta: -2.1,
					conf: 0.68,
					why: "partial",
					src: "grok",
					flags: ["SPLIT"],
				},
				waddle,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a leading-padded START", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: " START",
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
							act: " START",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 12 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 12 } }],
						usage: { total_tokens: 12 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard intel/refresh and roster/swap routes", () => {
	it("returns 400 Expected WebSocket for DELETE /api/fantasy/intel/refresh", async () => {
		const res = await fetchWorker(
			`/api/fantasy/intel/refresh?teamId=${uniqueId("intel-delete")}`,
			{ method: "DELETE" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket with a text body for OPTIONS /api/fantasy/intel/refresh", async () => {
		const res = await fetchWorker(
			`/api/fantasy/intel/refresh?teamId=${uniqueId("intel-options")}`,
			{ method: "OPTIONS" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket for PUT /api/fantasy/roster/swap", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${uniqueId("swap-put")}`,
			{ method: "PUT" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
