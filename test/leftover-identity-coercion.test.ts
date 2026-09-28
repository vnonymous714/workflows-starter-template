import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	type EspnRawLeagueResponse,
	type EspnRawPlayerEntry,
} from "../src/espn-client";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	extractTokenUsage,
	GrokRequestError,
	resolvePlayer,
} from "../src/grok-client";
import { importSleeperRoster } from "../src/sleeper-client";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function uniqueName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function espnEntry(
	overrides: {
		lineupSlotId?: number;
		id?: number;
		fullName?: string;
		defaultPositionId?: number;
		proTeamId?: number;
	} = {},
): EspnRawPlayerEntry {
	return {
		lineupSlotId: overrides.lineupSlotId ?? 2,
		playerPoolEntry: {
			appliedStatTotal: 12,
			player: {
				id: overrides.id ?? 4426515,
				fullName: overrides.fullName ?? "Kyren Williams",
				defaultPositionId: overrides.defaultPositionId ?? 2,
				proTeamId: overrides.proTeamId ?? 14,
			},
		},
	};
}

function espnLeague(
	overrides: Partial<EspnRawLeagueResponse> = {},
): EspnRawLeagueResponse {
	return {
		id: 12345678,
		seasonId: 2024,
		scoringPeriodId: 9,
		teams: [
			{
				id: 1,
				name: "Week Nine Club",
				roster: {
					entries: [
						espnEntry({
							lineupSlotId: 2,
							id: 4426515,
							fullName: "Kyren Williams",
						}),
					],
				},
			},
		],
		...overrides,
	};
}

function sleeperFetch(payload: {
	league?: Record<string, unknown>;
	rosters: Array<Record<string, unknown>>;
	users?: unknown;
	leagueId?: string;
}): typeof fetch {
	const leagueId = payload.leagueId ?? "1122334455";
	return async (input) => {
		const url = String(input);
		if (url.endsWith(`/league/${leagueId}`)) {
			return Response.json(
				payload.league ?? { league_id: leagueId, name: "Coercion League" },
			);
		}
		if (url.endsWith("/rosters")) {
			return Response.json(payload.rosters);
		}
		if (url.endsWith("/users")) {
			return Response.json(payload.users ?? []);
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("Sleeper identity leftover coercions", () => {
	it("throws when starter ids are JSON numbers (startsWith is string-only)", async () => {
		await expect(
			importSleeperRoster(
				{ leagueId: "1122334455", userOrRosterId: "1" },
				sleeperFetch({
					rosters: [
						{
							roster_id: 1,
							owner_id: "user_101",
							starters: [4984],
							players: [4984],
							settings: { wins: 1, losses: 0, ties: 0 },
						},
					],
				}),
			),
		).rejects.toThrow(/startsWith/);
	});

	it("leaves the seed roster in place when numeric starter ids crash import", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("sleeper-numeric-ids")),
		);

		await expect(
			runInDurableObject(stub, (instance: WorkflowStatusDO) =>
				instance.importSleeper(
					"1122334455",
					"1",
					sleeperFetch({
						rosters: [
							{
								roster_id: 1,
								starters: [4984],
								players: [4984],
							},
						],
					}),
				),
			),
		).rejects.toThrow(/startsWith/);

		const leftover = await stub.getFantasyState();
		expect(leftover.activeRoster.teamName).toBe("Neural Gridiron Pulse");
		expect(leftover.activeRoster.starters.map((p) => p.id)).toContain("p_kyren");
		expect(leftover.liveAlerts[0]?.message).not.toMatch(/Sleeper Roster Imported/);
	});

	it("does not treat string roster_id as the numeric query (===), so team 2 is missed", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "2" },
			sleeperFetch({
				league: { league_id: "1122334455", name: "String Ids" },
				rosters: [
					{
						roster_id: "1",
						owner_id: "user_101",
						starters: ["4984"],
						players: ["4984"],
						settings: { wins: 8, losses: 1, ties: 0 },
					},
					{
						roster_id: "2",
						owner_id: "user_102",
						starters: ["8138"],
						players: ["8138", "9221"],
						settings: { wins: 2, losses: 7, ties: 0 },
					},
				],
				users: [
					{
						user_id: "user_101",
						display_name: "First Owner",
						metadata: { team_name: "Team One" },
					},
					{
						user_id: "user_102",
						display_name: "Second Owner",
						metadata: { team_name: "Team Two" },
					},
				],
			}),
		);

		expect(roster.teamId).toBe("sleeper_1122334455_1");
		expect(roster.teamName).toContain("Team One");
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters.map((p) => p.name)).not.toContain("Kyren Williams");
	});

	it("ignores league.roster_positions, so a Superflex 2nd QB is labeled RB", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "1" },
			sleeperFetch({
				league: {
					league_id: "1122334455",
					name: "Superflex",
					roster_positions: [
						"QB",
						"QB",
						"RB",
						"RB",
						"WR",
						"WR",
						"TE",
						"FLEX",
						"FLEX",
					],
				},
				rosters: [
					{
						roster_id: 1,
						starters: ["4984", "4984"],
						players: ["4984"],
						settings: { wins: 5, losses: 5, ties: 0 },
					},
				],
			}),
		);

		expect(roster.starters).toHaveLength(2);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[0]?.pos).toBe("QB");
		expect(roster.starters[1]?.name).toBe("Josh Allen");
		expect(roster.starters[1]?.pos).toBe("RB");
	});
});

describe("Grok token usage leftover coercions", () => {
	it("prefers total_tokens even when it is 0, but null falls through to prompt+completion", () => {
		expect(
			extractTokenUsage({
				total_tokens: 0,
				prompt_tokens: 100,
				completion_tokens: 40,
			}),
		).toBe(0);
		expect(
			extractTokenUsage({
				total_tokens: null as unknown as number,
				prompt_tokens: 100,
				completion_tokens: 40,
			}),
		).toBe(140);
	});

	it("does not wrap a thrown xAI fetch as GrokRequestError", async () => {
		const thrownFetch: typeof fetch = async () => {
			throw new Error("dns failed");
		};

		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: thrownFetch,
			}),
		).rejects.toThrow("dns failed");

		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: thrownFetch,
			}),
		).rejects.not.toBeInstanceOf(GrokRequestError);

		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("grok-thrown-fetch")),
		);

		await expect(
			runInDurableObject(stub, (instance: WorkflowStatusDO) =>
				instance.decide("p_kyren", "p_charbonnet", false, {
					apiKey: "test-xai-key",
					fetchImpl: thrownFetch,
				}),
			),
		).rejects.toThrow("dns failed");

		const leftover = await stub.getFantasyState();
		expect(leftover.lastDecision).toBeNull();
		expect(leftover.recommendations.find((r) => r.id === "Kyren")?.src).toBe(
			"@RapSheet",
		);
	});
});

describe("Swap vs evaluate identity leftover", () => {
	it("resolves start/sit tokens case-insensitively but swap requires exact ids", async () => {
		const state = buildCommandCenterState();
		expect(resolvePlayer(state, "P_KYREN")?.id).toBe("p_kyren");
		expect(resolvePlayer(state, "P_CHARBONNET")?.id).toBe("p_charbonnet");

		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("swap-case")),
		);

		const swapped = await stub.swapRoster("P_KYREN", "P_CHARBONNET");
		expect(swapped.activeRoster.starters.map((p) => p.id)).toContain("p_kyren");
		expect(swapped.activeRoster.bench.map((p) => p.id)).toContain(
			"p_charbonnet",
		);
		expect(swapped.liveAlerts[0]?.type).not.toBe("LINEUP");
	});
});

describe("Intel hash leftover after ESPN week change", () => {
	it("keeps intelPacket.week at 14 and hashes intel_wk14_ after a week-9 ESPN sync", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("intel-wk-hash")),
		);

		const synced = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster({ leagueId: "12345678" }, async () => {
					return new Response(JSON.stringify(espnLeague()), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}),
		);

		expect(synced.selectedWeek).toBe(9);
		expect(synced.intelPacket.week).toBe(14);

		const refreshed = await stub.refreshIntel();
		expect(refreshed.selectedWeek).toBe(9);
		expect(refreshed.intelPacket.week).toBe(14);
		expect(refreshed.intelPacket.hash).toMatch(/^intel_wk14_/);
		expect(refreshed.activeRoster.teamName).toBe("Week Nine Club");
	});
});

describe("Workflow step error leftover", () => {
	it("does not flip workflowStatus to error when a step is marked error", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("step-error")),
		);

		await stub.updateStep("process data", "error");

		const response = await stub.fetch("https://example.com/", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const state = await new Promise<{
			currentStep: string | null;
			stepStatuses: Record<string, string>;
			workflowStatus: string;
		}>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for workflow_update")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				clearTimeout(timer);
				resolve(
					JSON.parse(event.data as string) as {
						currentStep: string | null;
						stepStatuses: Record<string, string>;
						workflowStatus: string;
					},
				);
			});
			socket.accept();
		});
		socket.close(1000, "done");

		expect(state.workflowStatus).toBe("running");
		expect(state.currentStep).toBeNull();
		expect(state.stepStatuses["process data"]).toBe("error");
	});
});

describe("Worker fantasy method leftovers", () => {
	it("returns 400 Expected WebSocket for POST /api/fantasy/state (GET is the UI path)", async () => {
		const teamId = uniqueName("post-state");
		const response = await worker.fetch(
			new Request(
				`https://example.com/api/fantasy/state?teamId=${teamId}`,
				{ method: "POST" },
			),
			env,
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Expected WebSocket");
	});
});
