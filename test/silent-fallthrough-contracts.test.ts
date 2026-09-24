import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
	type EspnRawTeam,
} from "../src/espn-client";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	parseGrokVerdict,
	resolvePlayer,
} from "../src/grok-client";
import { importSleeperRoster } from "../src/sleeper-client";
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
							lineupSlotId: 0,
							playerPoolEntry: {
								appliedStatTotal: 24.5,
								player: {
									id: 1,
									fullName: "Josh Allen",
									defaultPositionId: 1,
									proTeamId: 2,
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

function createSleeperFetch(): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}`)) {
			return Response.json({
				league_id: SLEEPER_LEAGUE_ID,
				name: "Champions League",
			});
		}
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}/rosters`)) {
			return Response.json([
				{
					roster_id: 1,
					owner_id: "user_101",
					starters: ["4984"],
					players: ["4984"],
					settings: { wins: 8, losses: 5, ties: 0 },
				},
				{
					roster_id: 2,
					owner_id: "user_102",
					starters: ["8138"],
					players: ["8138", "0", "7553"],
					settings: { wins: 6, losses: 7, ties: 0 },
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
				{
					user_id: "user_102",
					username: "rival_boss",
					display_name: "Rival Boss",
				},
			]);
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("ESPN leftover silent fallthroughs", () => {
	it("prefers scoringPeriodId when every week field is present", () => {
		const { week } = sanitizeEspnTeamRoster(
			league({
				scoringPeriodId: 11,
				currentPeriodId: 12,
				status: {
					latestScoringPeriod: 13,
					currentMatchupPeriod: 14,
				},
			}),
		);
		expect(week).toBe(11);
	});

	it("does not treat an abbrev-only team as named", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				teams: [{ id: 4, abbrev: "GD" }],
			}),
		);
		expect(roster.teamName).toBe("ESPN Team 4");
		expect(roster.teamName).not.toBe("GD");
	});

	it("treats string leagueId 0 as a real league and keeps season -1", async () => {
		let capturedUrl = "";
		await fetchEspnLeagueData({
			leagueId: "0",
			season: -1,
			fetchImpl: async (input) => {
				capturedUrl = String(input);
				return espnFetch(league())();
			},
		});
		expect(capturedUrl).toContain("/seasons/-1/");
		expect(capturedUrl).toContain("/leagues/0?");
	});

	it("maps unparseable ESPN_SEASON to 2024 and keeps a negative env season", async () => {
		const nanStub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-season-nan-${crypto.randomUUID()}`),
		);
		let nanUrl = "";
		const nanState = await runInDurableObject(
			nanStub,
			async (instance: WorkflowStatusDO) => {
				instance.env.ESPN_SEASON = "abc";
				return instance.syncEspnRoster(
					{ leagueId: "12345678" },
					async (input) => {
						nanUrl = String(input);
						return espnFetch(league())();
					},
				);
			},
		);
		expect(nanUrl).toContain("/seasons/2024/");
		expect(nanState.espnSyncMeta?.season).toBe(2024);

		const negStub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-season-neg-${crypto.randomUUID()}`),
		);
		let negUrl = "";
		const negState = await runInDurableObject(
			negStub,
			async (instance: WorkflowStatusDO) => {
				instance.env.ESPN_SEASON = "-1";
				return instance.syncEspnRoster(
					{ leagueId: "12345678" },
					async (input) => {
						negUrl = String(input);
						return espnFetch(league())();
					},
				);
			},
		);
		expect(negUrl).toContain("/seasons/-1/");
		expect(negState.espnSyncMeta?.season).toBe(-1);
	});
});

describe("Grok leftover silent fallthroughs", () => {
	it("emits FRESH:0 when the intel packet is stale", () => {
		const state = structuredClone(buildCommandCenterState());
		state.intelPacket.fresh = false;
		const kyren = resolvePlayer(state, "p_kyren");
		const charbonnet = resolvePlayer(state, "p_charbonnet");
		expect(kyren && charbonnet).toBeTruthy();

		const packet = buildCsspPacket(state, kyren!, charbonnet!, false);
		expect(packet).toContain("FRESH:0");
		expect(packet).toContain(`HASH:${state.intelPacket.hash}`);
		expect(packet).not.toContain("FRESH:1");
	});

	it("accepts a null compact conf as 0, drops non-array flags, and keeps STALE", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const nullConf = parseGrokVerdict(
			{
				act: "SIT",
				delta: -1.5,
				conf: null,
				why: "Wind",
				flags: "INJ",
			},
			kyren,
			charbonnet,
		);
		expect(nullConf[0]?.conf).toBe(0);
		expect(nullConf[0]?.flags).toEqual([]);
		expect(nullConf[1]?.act).toBe("START");
		expect(nullConf[1]?.delta).toBe(1.5);

		const stale = parseGrokVerdict(
			{
				act: "HOLD",
				delta: 0,
				conf: 0.4,
				why: "Stale beat",
				flags: ["STALE", "NOPE", "INJ"],
			},
			kyren,
			charbonnet,
		);
		expect(stale[0]?.act).toBe("HOLD");
		expect(stale[1]?.act).toBe("HOLD");
		expect(stale[0]?.flags).toEqual(["STALE", "INJ"]);
	});
});

describe("Sleeper leftover silent fallthroughs", () => {
	it("matches usernames case-insensitively but user ids exactly", async () => {
		const byUsername = await importSleeperRoster(
			{ leagueId: SLEEPER_LEAGUE_ID, userOrRosterId: "RIVAL_BOSS" },
			createSleeperFetch(),
		);
		expect(byUsername.teamId).toBe(`sleeper_${SLEEPER_LEAGUE_ID}_2`);
		expect(byUsername.owner).toContain("Rival Boss");

		const byWrongCaseUserId = await importSleeperRoster(
			{ leagueId: SLEEPER_LEAGUE_ID, userOrRosterId: "USER_102" },
			createSleeperFetch(),
		);
		expect(byWrongCaseUserId.teamId).toBe(`sleeper_${SLEEPER_LEAGUE_ID}_1`);
		expect(byWrongCaseUserId.owner).toContain("Gridiron King");
	});

	it("drops a bench player id of 0 after import", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: SLEEPER_LEAGUE_ID, userOrRosterId: "2" },
			createSleeperFetch(),
		);
		expect(roster.starters.map((p) => p.name)).toEqual(["Kyren Williams"]);
		expect(roster.bench.map((p) => p.name)).toEqual(["Jaylen Waddle"]);
		expect(roster.bench.find((p) => p.id === "p_0")).toBeUndefined();
	});
});

describe("HTTP leftover silent fallthroughs", () => {
	it("rejects GET sleeper-import on the DO and worker as Expected WebSocket", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`sleeper-get-${crypto.randomUUID()}`),
		);
		const doRes = await stub.fetch("https://do/roster/sleeper-import");
		expect(doRes.status).toBe(400);
		expect(await doRes.text()).toBe("Expected WebSocket");

		const workerRes = await fetchWorker(
			"/api/fantasy/roster/sleeper-import?teamId=sleeper-get",
		);
		expect(workerRes.status).toBe(400);
		expect(await workerRes.text()).toBe("Expected WebSocket");
	});

	it("sends fantasy_update when the DO websocket path contains fantasy", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`ws-fantasy-${crypto.randomUUID()}`),
		);
		const response = await stub.fetch("https://example.com/fantasy", {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(101);
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const message = new Promise<{ type: string }>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for fantasy_update")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				clearTimeout(timer);
				resolve(JSON.parse(event.data as string) as { type: string });
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("WebSocket error"));
			});
		});
		socket.accept();
		const data = await message;
		socket.close(1000, "done");

		expect(data.type).toBe("fantasy_update");
	});
});
