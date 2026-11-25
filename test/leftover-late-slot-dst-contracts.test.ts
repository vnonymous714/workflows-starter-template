import { env, introspectWorkflowInstance } from "cloudflare:test";
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

describe("ESPN leftover late slots, unused ids, and padded DOUBTFUL", () => {
	it("benches leftover numeric unknown slots 27/28 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1901, [
				{
					lineupSlotId: 27,
					playerPoolEntry: {
						player: {
							id: 19011,
							fullName: "Unknown Numeric Slot Twenty Seven",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 28,
					playerPoolEntry: {
						player: {
							id: 19012,
							fullName: "Unknown Numeric Slot Twenty Eight",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Twenty Seven", pos: "QB" },
			{ name: "Unknown Numeric Slot Twenty Eight", pos: "K" },
		]);
	});

	it("falls unused leftover string defaultPositionId 22/23 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1902, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 19021,
							fullName: "Unknown Default String Twenty Two",
							defaultPositionId: "22" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 19022,
							fullName: "Unknown Default String Twenty Three",
							defaultPositionId: "23" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 10 to TEN and 11 to IND", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1903, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 19031,
							fullName: "String Team TEN",
							defaultPositionId: 3,
							proTeamId: "10" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 19032,
							fullName: "String Team IND",
							defaultPositionId: 2,
							proTeamId: "11" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team TEN", team: "TEN" },
				{ name: "String Team IND", team: "IND" },
			],
		);
	});

	it("keeps leftover padded all-caps DOUBTFUL as ACTIVE (leftover of leftover padded QUESTIONABLE)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1904, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 19041,
							fullName: "Padded Caps DOUBTFUL",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "DOUBTFUL ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 411 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "411411",
				fetchImpl: async () => new Response("Length Required", { status: 411 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 411,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, scientific query, and Lamb DST override", () => {
	const league = {
		league_id: "leftover-late-slot-league",
		name: "Leftover Late Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-late-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-late-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-late-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("keeps leftover known WR metadata when that player occupies the hardcoded DST slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-late-slot-league" },
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
						"6801",
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
						"6801",
					],
				},
			]),
		);

		expect(roster.starters[8]?.name).toBe("CeeDee Lamb");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[8]?.team).toBe("DAL");
		expect(roster.starters[8]?.opp).toBe("vs CIN");
		expect(roster.starters[8]?.projPts).toBe(19.1);
		expect(roster.starters[8]?.tags).toEqual(["Alpha WR", "High Volume"]);
		expect(roster.starters[8]?.pos).not.toBe("WR");
		expect(roster.starters[8]?.name).not.toBe("Player #6801");
	});

	it("treats leftover 3-letter WAS and CAR as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-late-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "WAS", "CAR"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "WAS Defense", pos: "DST", team: "WAS" },
				{ name: "CAR Defense", pos: "DST", team: "CAR" },
			],
		);
	});

	it("treats mixed-case Was as FLEX Player #Was rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-late-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Was"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Was");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Was Defense");
	});

	it("parses leftover query 9e1 as roster 9 rather than 90", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-late-slot-league", userOrRosterId: "9e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
				},
				{
					roster_id: 9,
					owner_id: "user_9",
					starters: ["7564"],
					players: ["7564"],
				},
				{
					roster_id: 90,
					owner_id: "user_90",
					starters: ["8138"],
					players: ["8138"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.teamName).toContain("Team 9");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});

	it("maps Sleeper league HTTP 411 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-late-slot-league")) {
				return new Response("Length Required", { status: 411 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-late-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (411)",
		});
	});
});

describe("Grok leftover XIX recId boundary, Kyren lookup, and numeric content", () => {
	it("uses first name for leftover 3-char suffix XIX and the 5-char leftover XXIII as the rec key", () => {
		expect(recId(namedPlayer("Patrick Mahomes XIX"))).toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XIX"))).not.toBe("XIX");
		expect(recId(namedPlayer("Patrick Mahomes XIX"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Patrick Mahomes XXIII"))).toBe("XXIII");
		expect(recId(namedPlayer("Patrick Mahomes XXIII"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XXIII"))).not.toBe("Mahomes");
	});

	it("resolves substring yren to Kyren Williams via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "yren");

		expect(player?.id).toBe("p_kyren");
		expect(player?.name).toBe("Kyren Williams");
	});

	it("matches first-token rec id Kyren and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Kyren",
					act: "SIT",
					vs: "Charbonnet",
					delta: -1,
					conf: 0.8,
					why: "game-time tag",
					src: "grok",
					flags: ["INJ"],
				},
				kyren,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "yren",
					act: "SIT",
					vs: "Charbonnet",
					delta: -1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: ["INJ"],
				},
				kyren,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded TRADE_Y", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "TRADE_Y ",
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
							act: "TRADE_Y ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 10 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 10 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard status and sleeper-import routes", () => {
	it("returns 200 for OPTIONS /api/workflow/status/:id because the route has no method guard", async () => {
		const instanceId = uniqueId("status-options");
		await using instance = await introspectWorkflowInstance(
			env.MY_WORKFLOW,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.disableSleeps();
			await m.mockEvent({
				type: "user-approval",
				payload: { approved: true },
			});
		});
		await env.MY_WORKFLOW.create({ id: instanceId });

		const res = await fetchWorker(`/api/workflow/status/${instanceId}`, {
			method: "OPTIONS",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toEqual(expect.any(String));
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("returns 400 Expected WebSocket with a text body for OPTIONS /api/fantasy/roster/sleeper-import", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/sleeper-import?teamId=${uniqueId("sleeper-options")}`,
			{ method: "OPTIONS" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket for PUT /api/fantasy/espn/sync", async () => {
		const res = await fetchWorker(
			`/api/fantasy/espn/sync?teamId=${uniqueId("espn-put")}`,
			{ method: "PUT" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
