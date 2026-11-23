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

describe("ESPN leftover OP slots, unused ids, and padded OUT", () => {
	it("benches leftover numeric unknown slots 22/24 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1701, [
				{
					lineupSlotId: 22,
					playerPoolEntry: {
						player: {
							id: 17011,
							fullName: "Unknown Numeric Slot Twenty Two",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 24,
					playerPoolEntry: {
						player: {
							id: 17012,
							fullName: "Unknown Numeric Slot Twenty Four",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Twenty Two", pos: "QB" },
			{ name: "Unknown Numeric Slot Twenty Four", pos: "K" },
		]);
	});

	it("falls unused leftover string defaultPositionId 18/19 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1702, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 17021,
							fullName: "Unknown Default String Eighteen",
							defaultPositionId: "18" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 17022,
							fullName: "Unknown Default String Nineteen",
							defaultPositionId: "19" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 5 to CLE and 6 to DAL", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1703, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 17031,
							fullName: "String Team CLE",
							defaultPositionId: 3,
							proTeamId: "5" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 17032,
							fullName: "String Team DAL",
							defaultPositionId: 2,
							proTeamId: "6" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team CLE", team: "CLE" },
				{ name: "String Team DAL", team: "DAL" },
			],
		);
	});

	it("keeps leftover padded all-caps OUT as ACTIVE (leftover of leftover padded IR)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1704, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 17041,
							fullName: "Padded Caps OUT",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "OUT ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 409 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "409409",
				fetchImpl: async () => new Response("Conflict", { status: 409 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 409,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, scientific query, and Aubrey DST override", () => {
	const league = {
		league_id: "leftover-op-slot-league",
		name: "Leftover OP Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-op-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-op-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-op-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("keeps leftover known K metadata when that player occupies the hardcoded DST slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-op-slot-league" },
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
						"11439",
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
						"11439",
					],
				},
			]),
		);

		expect(roster.starters[8]?.name).toBe("Brandon Aubrey");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[8]?.team).toBe("DAL");
		expect(roster.starters[8]?.opp).toBe("vs CIN");
		expect(roster.starters[8]?.projPts).toBe(9.8);
		expect(roster.starters[8]?.weatherCondition).toBe("Dome");
		expect(roster.starters[8]?.pos).not.toBe("K");
		expect(roster.starters[8]?.name).not.toBe("Player #11439");
	});

	it("treats leftover 3-letter HOU and IND as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-op-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "HOU", "IND"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "HOU Defense", pos: "DST", team: "HOU" },
				{ name: "IND Defense", pos: "DST", team: "IND" },
			],
		);
	});

	it("treats mixed-case Hou as FLEX Player #Hou rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-op-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Hou"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Hou");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Hou Defense");
	});

	it("parses leftover query 7e1 as roster 7 rather than 70", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-op-slot-league", userOrRosterId: "7e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
				},
				{
					roster_id: 7,
					owner_id: "user_7",
					starters: ["7564"],
					players: ["7564"],
				},
				{
					roster_id: 70,
					owner_id: "user_70",
					starters: ["8138"],
					players: ["8138"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.teamName).toContain("Team 7");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});

	it("maps Sleeper league HTTP 409 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-op-slot-league")) {
				return new Response("Conflict", { status: 409 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-op-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (409)",
		});
	});
});

describe("Grok leftover XV recId boundary, Chase lookup, and numeric content", () => {
	it("uses first name for leftover 2-char suffix XV and the 5-char leftover XVIII as the rec key", () => {
		expect(recId(namedPlayer("Patrick Mahomes XV"))).toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XV"))).not.toBe("XV");
		expect(recId(namedPlayer("Patrick Mahomes XV"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Patrick Mahomes XVIII"))).toBe("XVIII");
		expect(recId(namedPlayer("Patrick Mahomes XVIII"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XVIII"))).not.toBe("Mahomes");
	});

	it("resolves substring hase to Ja'Marr Chase via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "hase");

		expect(player?.id).toBe("p_jchase");
		expect(player?.name).toBe("Ja'Marr Chase");
	});

	it("matches last-token rec id Chase and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const chase = resolvePlayer(state, "p_jchase")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Chase",
					act: "START",
					vs: "Lamb",
					delta: 1,
					conf: 0.8,
					why: "target share",
					src: "grok",
					flags: [],
				},
				chase,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "hase",
					act: "START",
					vs: "Lamb",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				chase,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded START", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "START ",
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
							act: "START ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 8 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 8 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard status, event, and intel refresh routes", () => {
	it("returns 200 for PUT /api/workflow/status/:id because the route has no method guard", async () => {
		const instanceId = uniqueId("status-put");
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
			method: "PUT",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toEqual(expect.any(String));
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("returns JSON Not Found for DELETE /api/workflow/event/:id because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/event/abc", {
			method: "DELETE",
		});

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for HEAD /api/fantasy/intel/refresh", async () => {
		const res = await fetchWorker(
			`/api/fantasy/intel/refresh?teamId=${uniqueId("intel-head")}`,
			{ method: "HEAD" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("");
	});
});
