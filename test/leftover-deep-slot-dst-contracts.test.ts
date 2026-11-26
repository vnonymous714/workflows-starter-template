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

describe("ESPN leftover deep slots, unused ids, and leading-padded DOUBTFUL", () => {
	it("benches leftover numeric unknown slots 29/30 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2001, [
				{
					lineupSlotId: 29,
					playerPoolEntry: {
						player: {
							id: 20011,
							fullName: "Unknown Numeric Slot Twenty Nine",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 30,
					playerPoolEntry: {
						player: {
							id: 20012,
							fullName: "Unknown Numeric Slot Thirty",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Twenty Nine", pos: "QB" },
			{ name: "Unknown Numeric Slot Thirty", pos: "K" },
		]);
	});

	it("falls unused leftover string defaultPositionId 24/25 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2002, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 20021,
							fullName: "Unknown Default String Twenty Four",
							defaultPositionId: "24" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 20022,
							fullName: "Unknown Default String Twenty Five",
							defaultPositionId: "25" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 18 to NO and 23 to PIT", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2003, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 20031,
							fullName: "String Team NO",
							defaultPositionId: 3,
							proTeamId: "18" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 20032,
							fullName: "String Team PIT",
							defaultPositionId: 2,
							proTeamId: "23" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team NO", team: "NO" },
				{ name: "String Team PIT", team: "PIT" },
			],
		);
	});

	it("keeps leftover leading-padded all-caps DOUBTFUL as ACTIVE (leftover of trailing padded DOUBTFUL)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(2004, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 20041,
							fullName: "Leading Padded Caps DOUBTFUL",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: " DOUBTFUL",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 412 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "412412",
				fetchImpl: async () =>
					new Response("Precondition Failed", { status: 412 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 412,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, scientific query, and Hall DST override", () => {
	const league = {
		league_id: "leftover-deep-slot-league",
		name: "Leftover Deep Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-deep-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-deep-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-deep-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("keeps leftover known RB metadata when that player occupies the hardcoded DST slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-deep-slot-league" },
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
						"9226",
						"7564",
						"8155",
					],
					players: [
						"4984",
						"8183",
						"8138",
						"8136",
						"9221",
						"4035",
						"9226",
						"7564",
						"8155",
					],
				},
			]),
		);

		expect(roster.starters[8]?.name).toBe("Breece Hall");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[8]?.team).toBe("NYJ");
		expect(roster.starters[8]?.opp).toBe("vs MIA");
		expect(roster.starters[8]?.projPts).toBe(17.1);
		expect(roster.starters[8]?.tags).toEqual(["Dual Threat", "High Floor"]);
		expect(roster.starters[8]?.pos).not.toBe("RB");
		expect(roster.starters[8]?.name).not.toBe("Player #8155");
	});

	it("treats leftover 3-letter ARI and LAC as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-deep-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "ARI", "LAC"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "ARI Defense", pos: "DST", team: "ARI" },
				{ name: "LAC Defense", pos: "DST", team: "LAC" },
			],
		);
	});

	it("treats mixed-case Ari as FLEX Player #Ari rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-deep-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Ari"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Ari");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Ari Defense");
	});

	it("parses leftover query 10e1 as roster 10 rather than 100", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-deep-slot-league", userOrRosterId: "10e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
				},
				{
					roster_id: 10,
					owner_id: "user_10",
					starters: ["7564"],
					players: ["7564"],
				},
				{
					roster_id: 100,
					owner_id: "user_100",
					starters: ["8138"],
					players: ["8138"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.teamName).toContain("Team 10");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});

	it("maps Sleeper league HTTP 412 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-deep-slot-league")) {
				return new Response("Precondition Failed", { status: 412 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-deep-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (412)",
		});
	});
});

describe("Grok leftover XX recId boundary, Bijan lookup, and numeric content", () => {
	it("uses first name for leftover 2-char suffix XX and the 4-char leftover XXIV as the rec key", () => {
		expect(recId(namedPlayer("Patrick Mahomes XX"))).toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XX"))).not.toBe("XX");
		expect(recId(namedPlayer("Patrick Mahomes XX"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Patrick Mahomes XXIV"))).toBe("XXIV");
		expect(recId(namedPlayer("Patrick Mahomes XXIV"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XXIV"))).not.toBe("Mahomes");
	});

	it("resolves substring obin to Bijan Robinson via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "obin");

		expect(player?.id).toBe("p_bijan");
		expect(player?.name).toBe("Bijan Robinson");
	});

	it("matches first-token rec id Bijan and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const bijan = resolvePlayer(state, "p_bijan")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Bijan",
					act: "START",
					vs: "Kyren",
					delta: 1,
					conf: 0.8,
					why: "bellcow volume",
					src: "grok",
					flags: ["NEWS"],
				},
				bijan,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "obin",
					act: "START",
					vs: "Kyren",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: ["NEWS"],
				},
				bijan,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded TRADE_N", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "TRADE_N ",
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
							act: "TRADE_N ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 11 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 11 } }],
						usage: { total_tokens: 11 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard espn/sync and intel/refresh routes", () => {
	it("returns 400 Expected WebSocket for DELETE /api/fantasy/espn/sync", async () => {
		const res = await fetchWorker(
			`/api/fantasy/espn/sync?teamId=${uniqueId("espn-delete")}`,
			{ method: "DELETE" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket with a text body for OPTIONS /api/fantasy/espn/sync", async () => {
		const res = await fetchWorker(
			`/api/fantasy/espn/sync?teamId=${uniqueId("espn-options")}`,
			{ method: "OPTIONS" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket for PUT /api/fantasy/intel/refresh", async () => {
		const res = await fetchWorker(
			`/api/fantasy/intel/refresh?teamId=${uniqueId("intel-put")}`,
			{ method: "PUT" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
