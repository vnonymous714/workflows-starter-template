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

describe("ESPN leftover punter/HC slots, unused ids, and padded IR", () => {
	it("benches leftover numeric unknown slots 18/19 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1601, [
				{
					lineupSlotId: 18,
					playerPoolEntry: {
						player: {
							id: 16011,
							fullName: "Unknown Numeric Slot Eighteen",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 19,
					playerPoolEntry: {
						player: {
							id: 16012,
							fullName: "Unknown Numeric Slot Nineteen",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Eighteen", pos: "QB" },
			{ name: "Unknown Numeric Slot Nineteen", pos: "K" },
		]);
	});

	it("falls unused leftover string defaultPositionId 15/17 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1602, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 16021,
							fullName: "Unknown Default String Fifteen",
							defaultPositionId: "15" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 16022,
							fullName: "Unknown Default String Seventeen",
							defaultPositionId: "17" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 3 to CHI and 4 to CIN", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1603, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 16031,
							fullName: "String Team CHI",
							defaultPositionId: 3,
							proTeamId: "3" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 16032,
							fullName: "String Team CIN",
							defaultPositionId: 2,
							proTeamId: "4" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team CHI", team: "CHI" },
				{ name: "String Team CIN", team: "CIN" },
			],
		);
	});

	it("keeps leftover padded all-caps IR as ACTIVE (leftover of leftover padded Ir)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1604, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 16041,
							fullName: "Padded Caps IR",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "IR ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 408 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "408408",
				fetchImpl: async () => new Response("Request Timeout", { status: 408 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 408,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, scientific query, and Chase K override", () => {
	const league = {
		league_id: "leftover-punter-slot-league",
		name: "Leftover Punter Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-punter-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-punter-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-punter-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("keeps leftover known WR metadata when that player occupies the hardcoded K slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-punter-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183", "8138", "8136", "9221", "4035", "9226", "7564"],
					players: ["4984", "8183", "8138", "8136", "9221", "4035", "9226", "7564"],
				},
			]),
		);

		expect(roster.starters[7]?.name).toBe("Ja'Marr Chase");
		expect(roster.starters[7]?.pos).toBe("K");
		expect(roster.starters[7]?.team).toBe("CIN");
		expect(roster.starters[7]?.opp).toBe("@ DAL");
		expect(roster.starters[7]?.projPts).toBe(20.2);
		expect(roster.starters[7]?.tags).toEqual(["Elite WR1", "Target Share 32%"]);
		expect(roster.starters[7]?.pos).not.toBe("WR");
		expect(roster.starters[7]?.name).not.toBe("Player #7564");
	});

	it("treats leftover 3-letter DEN and DET as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-punter-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "DEN", "DET"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "DEN Defense", pos: "DST", team: "DEN" },
				{ name: "DET Defense", pos: "DST", team: "DET" },
			],
		);
	});

	it("treats mixed-case Den as FLEX Player #Den rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-punter-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Den"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Den");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Den Defense");
	});

	it("parses leftover query 6e1 as roster 6 rather than 60", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-punter-slot-league", userOrRosterId: "6e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
				},
				{
					roster_id: 6,
					owner_id: "user_6",
					starters: ["7564"],
					players: ["7564"],
				},
				{
					roster_id: 60,
					owner_id: "user_60",
					starters: ["8138"],
					players: ["8138"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.teamName).toContain("Team 6");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});

	it("maps Sleeper league HTTP 408 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-punter-slot-league")) {
				return new Response("Request Timeout", { status: 408 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-punter-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (408)",
		});
	});
});

describe("Grok leftover XIV recId boundary, Josh lookup, and numeric content", () => {
	it("uses first name for leftover 3-char suffix XIV and the 4-char leftover XVII as the rec key", () => {
		expect(recId(namedPlayer("Patrick Mahomes XIV"))).toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XIV"))).not.toBe("XIV");
		expect(recId(namedPlayer("Patrick Mahomes XIV"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Patrick Mahomes XVII"))).toBe("XVII");
		expect(recId(namedPlayer("Patrick Mahomes XVII"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XVII"))).not.toBe("Mahomes");
	});

	it("resolves substring llen to Josh Allen via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "llen");

		expect(player?.id).toBe("p_jallen");
		expect(player?.name).toBe("Josh Allen");
	});

	it("matches first-token rec id Josh to Allen and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const allen = resolvePlayer(state, "p_jallen")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Josh",
					act: "START",
					vs: "Mahomes",
					delta: 1,
					conf: 0.8,
					why: "rushing floor",
					src: "grok",
					flags: [],
				},
				allen,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "osh",
					act: "START",
					vs: "Mahomes",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				allen,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded DROP", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "DROP ",
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
							act: "DROP ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 7 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 7 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard status, event, and espn sync routes", () => {
	it("returns 200 for DELETE /api/workflow/status/:id because the route has no method guard", async () => {
		const instanceId = uniqueId("status-delete");
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
			method: "DELETE",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toEqual(expect.any(String));
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("returns JSON Not Found for HEAD /api/workflow/event/:id because the route is POST-only", async () => {
		const res = await fetchWorker("/api/workflow/event/abc", { method: "HEAD" });

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("returns 400 Expected WebSocket for HEAD /api/fantasy/espn/sync", async () => {
		const res = await fetchWorker(
			`/api/fantasy/espn/sync?teamId=${uniqueId("espn-head")}`,
			{ method: "HEAD" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("");
	});
});
