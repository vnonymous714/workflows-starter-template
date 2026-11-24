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

describe("ESPN leftover extra slots, unused ids, and padded QUESTIONABLE", () => {
	it("benches leftover numeric unknown slots 25/26 using defaultPositionId (QB/K)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1801, [
				{
					lineupSlotId: 25,
					playerPoolEntry: {
						player: {
							id: 18011,
							fullName: "Unknown Numeric Slot Twenty Five",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 26,
					playerPoolEntry: {
						player: {
							id: 18012,
							fullName: "Unknown Numeric Slot Twenty Six",
							defaultPositionId: 5,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "Unknown Numeric Slot Twenty Five", pos: "QB" },
			{ name: "Unknown Numeric Slot Twenty Six", pos: "K" },
		]);
	});

	it("falls unused leftover string defaultPositionId 20/21 back to RB on the bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1802, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 18021,
							fullName: "Unknown Default String Twenty",
							defaultPositionId: "20" as unknown as number,
							proTeamId: 2,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 18022,
							fullName: "Unknown Default String Twenty One",
							defaultPositionId: "21" as unknown as number,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "RB"]);
	});

	it("maps leftover string proTeamId 7 to DEN and 8 to DET", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1803, [
				{
					lineupSlotId: 4,
					playerPoolEntry: {
						player: {
							id: 18031,
							fullName: "String Team DEN",
							defaultPositionId: 3,
							proTeamId: "7" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 18032,
							fullName: "String Team DET",
							defaultPositionId: 2,
							proTeamId: "8" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team DEN", team: "DEN" },
				{ name: "String Team DET", team: "DET" },
			],
		);
	});

	it("keeps leftover padded all-caps QUESTIONABLE as ACTIVE (leftover of leftover padded OUT)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(1804, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 18041,
							fullName: "Padded Caps QUESTIONABLE",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "QUESTIONABLE ",
						},
					},
				},
			]),
		);

		expect(roster.bench[0]?.status).toBe("ACTIVE");
		expect(roster.bench[0]?.tags).toBeUndefined();
		expect(roster.bench[0]?.injuryDesc).toBeUndefined();
	});

	it("maps ESPN HTTP 410 to ESPN_REQUEST_FAILED rather than AUTH", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "410410",
				fetchImpl: async () => new Response("Gone", { status: 410 }),
			}),
		).rejects.toMatchObject({
			name: "EspnRequestError",
			code: "ESPN_REQUEST_FAILED",
			status: 410,
		} satisfies Partial<EspnRequestError>);
	});
});

describe("Sleeper leftover DST letters, scientific query, and Waddle DST override", () => {
	const league = {
		league_id: "leftover-extra-slot-league",
		name: "Leftover Extra Slot League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-extra-slot-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-extra-slot-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-extra-slot-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("keeps leftover known WR metadata when that player occupies the hardcoded DST slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-extra-slot-league" },
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
						"7553",
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
						"7553",
					],
				},
			]),
		);

		expect(roster.starters[8]?.name).toBe("Jaylen Waddle");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[8]?.team).toBe("MIA");
		expect(roster.starters[8]?.opp).toBe("@ NYJ");
		expect(roster.starters[8]?.projPts).toBe(13.8);
		expect(roster.starters[8]?.tags).toEqual([
			"Shadow Coverage",
			"Deep Threat",
		]);
		expect(roster.starters[8]?.pos).not.toBe("WR");
		expect(roster.starters[8]?.name).not.toBe("Player #7553");
	});

	it("treats leftover 3-letter JAX and TEN as defenses", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-extra-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "JAX", "TEN"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(2);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos, team: p.team }))).toEqual(
			[
				{ name: "JAX Defense", pos: "DST", team: "JAX" },
				{ name: "TEN Defense", pos: "DST", team: "TEN" },
			],
		);
	});

	it("treats mixed-case Jax as FLEX Player #Jax rather than a DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-extra-slot-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "Jax"],
				},
			]),
		);

		expect(roster.bench[0]?.name).toBe("Player #Jax");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Jax Defense");
	});

	it("parses leftover query 8e1 as roster 8 rather than 80", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-extra-slot-league", userOrRosterId: "8e1" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_1",
					starters: ["4984"],
					players: ["4984"],
				},
				{
					roster_id: 8,
					owner_id: "user_8",
					starters: ["7564"],
					players: ["7564"],
				},
				{
					roster_id: 80,
					owner_id: "user_80",
					starters: ["8138"],
					players: ["8138"],
				},
			]),
		);

		expect(roster.starters[0]?.name).toBe("Ja'Marr Chase");
		expect(roster.teamName).toContain("Team 8");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});

	it("maps Sleeper league HTTP 410 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-extra-slot-league")) {
				return new Response("Gone", { status: 410 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster(
				{ leagueId: "leftover-extra-slot-league" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (410)",
		});
	});
});

describe("Grok leftover XVI recId boundary, Ravens lookup, and numeric content", () => {
	it("uses first name for leftover 3-char suffix XVI and the 4-char leftover XXII as the rec key", () => {
		expect(recId(namedPlayer("Patrick Mahomes XVI"))).toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XVI"))).not.toBe("XVI");
		expect(recId(namedPlayer("Patrick Mahomes XVI"))).not.toBe("Mahomes");
		expect(recId(namedPlayer("Patrick Mahomes XXII"))).toBe("XXII");
		expect(recId(namedPlayer("Patrick Mahomes XXII"))).not.toBe("Patrick");
		expect(recId(namedPlayer("Patrick Mahomes XXII"))).not.toBe("Mahomes");
	});

	it("resolves substring rave to Baltimore Ravens via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "rave");

		expect(player?.id).toBe("p_baldst");
		expect(player?.name).toBe("Baltimore Ravens");
	});

	it("matches last-token rec id Ravens and rejects a partial token", () => {
		const state = buildCommandCenterState();
		const ravens = resolvePlayer(state, "p_baldst")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Ravens",
					act: "START",
					vs: "Giants",
					delta: 1,
					conf: 0.8,
					why: "pressure rate",
					src: "grok",
					flags: [],
				},
				ravens,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "rave",
					act: "START",
					vs: "Giants",
					delta: 1,
					conf: 0.8,
					why: "partial",
					src: "grok",
					flags: [],
				},
				ravens,
			),
		).toBe(false);
	});

	it("throws invalid act when leftover recs[].act is a padded SMASH", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "SMASH ",
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
							act: "SMASH ",
							delta: 0,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow("Grok verdict had an invalid act.");
	});

	it("throws TypeError when leftover xAI content is number 9 (trim is not called on 0/false)", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [{ message: { content: 9 } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toThrow(TypeError);
	});
});

describe("Worker leftover method-guard status and sleeper-import routes", () => {
	it("returns 200 for PATCH /api/workflow/status/:id because the route has no method guard", async () => {
		const instanceId = uniqueId("status-patch");
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
			method: "PATCH",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toEqual(expect.any(String));
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("returns 200 with a JSON body for HEAD /api/workflow/status/:id (worker Response.json is not stripped)", async () => {
		const instanceId = uniqueId("status-head");
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
			method: "HEAD",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toEqual(expect.any(String));
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("returns 400 Expected WebSocket for HEAD /api/fantasy/roster/sleeper-import", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/sleeper-import?teamId=${uniqueId("sleeper-head")}`,
			{ method: "HEAD" },
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("");
	});
});
