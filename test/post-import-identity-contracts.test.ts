import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
	type EspnRawTeam,
} from "../src/espn-client";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	resolvePlayer,
} from "../src/grok-client";
import { importSleeperRoster, SleeperApiError } from "../src/sleeper-client";
import type { CommandCenterState } from "../src/types/fantasy";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function league(
	overrides: Partial<EspnRawLeagueResponse> & { teams?: EspnRawTeam[] } = {},
): EspnRawLeagueResponse {
	return {
		id: 12345678,
		seasonId: 2024,
		scoringPeriodId: 14,
		...overrides,
		teams: overrides.teams ?? [
			{
				id: 1,
				name: "Gridiron Dynasty",
				roster: {
					entries: [
						{
							lineupSlotId: 2,
							playerPoolEntry: {
								appliedStatTotal: 17.8,
								player: {
									id: 4426515,
									fullName: "Kyren Williams",
									defaultPositionId: 2,
									proTeamId: 14,
									injuryStatus: "QUESTIONABLE",
								},
							},
						},
						{
							lineupSlotId: 20,
							playerPoolEntry: {
								appliedStatTotal: 14.2,
								player: {
									id: 4567890,
									fullName: "Zach Charbonnet",
									defaultPositionId: 2,
									proTeamId: 26,
								},
							},
						},
					],
				},
			},
		],
	};
}

function espnFetch(body: unknown, status = 200): typeof fetch {
	return async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

const SLEEPER_LEAGUE_ID = "1122334455";

function sleeperFetch(
	overrides: {
		league?: unknown;
		rosters?: Response;
		starters?: string[];
		players?: string[];
	} = {},
): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}`)) {
			return Response.json(
				overrides.league ?? {
					league_id: SLEEPER_LEAGUE_ID,
					name: "Champions League",
				},
			);
		}
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}/rosters`)) {
			if (overrides.rosters) return overrides.rosters;
			return Response.json([
				{
					roster_id: 1,
					owner_id: "user_101",
					starters: overrides.starters ?? ["4984", "8138"],
					players: overrides.players ?? ["4984", "8138", "9221"],
					settings: { wins: 8, losses: 5, ties: 0 },
				},
			]);
		}
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}/users`)) {
			return Response.json([
				{
					user_id: "user_101",
					username: "gridiron_king",
					display_name: "Gridiron King",
				},
			]);
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("post-import identity and CSSP leftovers", () => {
	it("stops resolving seed ids after ESPN sync but still attaches weather via team", () => {
		const { roster } = sanitizeEspnTeamRoster(league(), 1);
		const state = buildCommandCenterState();
		state.activeRoster = roster;

		expect(resolvePlayer(state, "p_kyren")).toBeUndefined();
		expect(resolvePlayer(state, "p_charbonnet")).toBeUndefined();

		const kyren = resolvePlayer(state, "kyren");
		const charbonnet = resolvePlayer(state, "charbonnet");
		expect(kyren?.id).toBe("espn_4426515");
		expect(kyren?.opp).toBe("vs NFL");
		expect(charbonnet?.id).toBe("espn_4567890");

		const packet = buildCsspPacket(state, kyren!, charbonnet!, false);
		expect(packet).toContain("LAR @ BUF");
		expect(packet).toContain("SEA @ ARI");
		expect(packet).toContain("PASS-FADE");
	});

	it("includes the injury handcuff token and dome weather in the compact packet", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const packet = buildCsspPacket(state, kyren, charbonnet, false);
		expect(packet).toContain("hc:Zach Charbonnet");
		expect(packet).toContain("DOME");
		expect(packet).toContain("SEA @ ARI");
		expect(packet).toMatch(/FRESH:1 HASH:intel_wk14_/);
	});

	it("keeps the seed Kyren rec after a live Williams verdict because merge is exact id", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`merge-kyren-${crypto.randomUUID()}`),
		);

		const before = await stub.getFantasyState();
		expect(before.recommendations.some((r) => r.id === "Kyren")).toBe(true);

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) =>
			instance.decide("p_kyren", "p_charbonnet", false, {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [
							{
								message: {
									content: JSON.stringify({
										act: "SIT",
										delta: -4.2,
										conf: 0.81,
										why: "Ankle DNP",
										flags: ["INJ"],
									}),
								},
							},
						],
						usage: { total_tokens: 88 },
					}),
			}),
		);

		const after = await stub.getFantasyState();
		expect(after.recommendations.find((r) => r.id === "Williams")?.act).toBe(
			"SIT",
		);
		expect(after.recommendations.some((r) => r.id === "Kyren")).toBe(true);
	});
});

describe("ESPN leftover identity and HTTP contracts", () => {
	it("does not trim targetTeamId, so padded 2 falls through to the first team", () => {
		const raw = league({
			teams: [
				{
					id: 1,
					name: "First Club",
					roster: { entries: [] },
				},
				{
					id: 2,
					name: "Second Club",
					roster: { entries: [] },
				},
			],
		});

		const padded = sanitizeEspnTeamRoster(raw, "  2  ");
		expect(padded.roster.teamName).toBe("First Club");
		expect(padded.roster.teamId).toBe("espn_team_1");

		const exact = sanitizeEspnTeamRoster(raw, "2");
		expect(exact.roster.teamName).toBe("Second Club");
	});

	it("unshifts a second ESPN alert on resync while replacing the roster metric", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-resync-${crypto.randomUUID()}`),
		);

		const first = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{ leagueId: "12345678" },
					espnFetch(league()),
				),
		);
		const second = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{ leagueId: "12345678" },
					espnFetch(league()),
				),
		);

		expect(
			second.tokenMetrics.filter(
				(m) =>
					m.queryType.includes("ESPN") || m.queryType.includes("Roster"),
			),
		).toHaveLength(1);
		expect(second.liveAlerts.filter((a) => a.type === "ESPN")).toHaveLength(2);
		expect(first.liveAlerts.filter((a) => a.type === "ESPN")).toHaveLength(1);
	});

	it("maps a thrown ESPN fetch on the HTTP sync path to 502 without a status", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-throw-${crypto.randomUUID()}`),
		);

		const response = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				const originalFetch = globalThis.fetch;
				globalThis.fetch = (async () => {
					throw new Error("dns failed");
				}) as typeof fetch;
				try {
					return instance.fetch(
						new Request("https://do/espn/sync", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ leagueId: "12345678" }),
						}),
					);
				} finally {
					globalThis.fetch = originalFetch;
				}
			},
		);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({
			code: "ESPN_REQUEST_FAILED",
			error: expect.stringContaining("dns failed"),
		});
	});
});

describe("Sleeper leftover identity contracts", () => {
	it("maps a roster HTTP 404 to 502 instead of the league-not-found 404", async () => {
		await expect(
			importSleeperRoster(
				{ leagueId: SLEEPER_LEAGUE_ID },
				sleeperFetch({
					rosters: new Response("gone", { status: 404 }),
				}),
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Failed to fetch rosters (404)",
		} satisfies Partial<SleeperApiError>);
	});

	it("treats an empty league name as unnamed and keeps whitespace starter ids", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: SLEEPER_LEAGUE_ID },
			sleeperFetch({
				league: { league_id: SLEEPER_LEAGUE_ID, name: "" },
				starters: ["4984", "   ", "0"],
				players: ["4984", "   ", "0", "9221"],
			}),
		);

		expect(roster.teamName).toBe("Gridiron King (Sleeper League)");
		expect(roster.starters.map((p) => p.id)).toEqual(["p_4984", "p_   "]);
		expect(roster.starters[1]?.name).toBe("Player #   ");
		expect(roster.bench.map((p) => p.id)).toEqual(["p_9221"]);
	});
});

describe("Worker leftover HTTP contracts", () => {
	it("swaps the Command Center roster through POST /api/fantasy/roster/swap", async () => {
		const teamId = `swap-http-${crypto.randomUUID()}`;
		const response = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${teamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					starterId: "p_kyren",
					benchId: "p_charbonnet",
				}),
			},
		);

		expect(response.status).toBe(200);
		const state = (await response.json()) as CommandCenterState;
		expect(state.activeRoster.starters.map((p) => p.id)).toContain(
			"p_charbonnet",
		);
		expect(state.activeRoster.starters.map((p) => p.id)).not.toContain(
			"p_kyren",
		);
		expect(state.liveAlerts[0]?.type).toBe("LINEUP");
	});

	it("returns text Not found for unknown non-API pages", async () => {
		const response = await fetchWorker("/missing-page");
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not found");
	});
});
