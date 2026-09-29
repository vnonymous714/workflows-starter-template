import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	executeGrokDecision,
	parseGrokVerdict,
	recId,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
} from "../src/sleeper-client";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

const MOCK_USAGE = {
	prompt_tokens: 100,
	completion_tokens: 40,
	total_tokens: 140,
};

function mockXaiFetch(body: unknown, model = "grok-4-fast"): typeof fetch {
	return async (input, init) => {
		const url = String(input);
		if (!url.includes("api.x.ai")) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		expect(init?.method).toBe("POST");
		return Response.json({
			model,
			choices: [
				{
					message: {
						content: JSON.stringify(body),
					},
				},
			],
			usage: MOCK_USAGE,
		});
	};
}

function sleeperLeagueMocks(overrides?: {
	rosterId?: number;
	ties?: number;
	wins?: number;
	losses?: number;
	fpts?: number;
	settings?: null;
}): {
	league: Record<string, unknown>;
	rosters: Array<Record<string, unknown>>;
	users: Array<Record<string, unknown>>;
} {
	const settings =
		overrides?.settings === null
			? undefined
			: {
					wins: overrides?.wins ?? 8,
					losses: overrides?.losses ?? 5,
					ties: overrides?.ties ?? 0,
					fpts: overrides?.fpts ?? 1420,
				};
	return {
		league: {
			league_id: "1122334455",
			name: "Champions League",
			total_rosters: 12,
			season: "2024",
		},
		rosters: [
			{
				roster_id: 1,
				owner_id: "user_101",
				starters: ["4984"],
				players: ["4984", "8136"],
				settings: {
					wins: 10,
					losses: 3,
					ties: 0,
					fpts: 100,
				},
			},
			{
				roster_id: overrides?.rosterId ?? 2,
				owner_id: "user_102",
				starters: ["8138", "9221"],
				players: ["8138", "9221", "NYJ"],
				settings,
			},
		],
		users: [
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
		],
	};
}

function createSleeperFetch(
	mocks = sleeperLeagueMocks(),
	captured: { urls: string[] } = { urls: [] },
): typeof fetch {
	return async (input) => {
		const url = String(input);
		captured.urls.push(url);
		if (url.endsWith("/league/1122334455")) {
			return Response.json(mocks.league);
		}
		if (url.endsWith("/league/1122334455/rosters")) {
			return Response.json(mocks.rosters);
		}
		if (url.endsWith("/league/1122334455/users")) {
			return Response.json(mocks.users);
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("hyphenated rec ids vs seed JSN recs", () => {
	it("keys Jaxon Smith-Njigba as Smith-Njigba, not JSN or Njigba", () => {
		const state = buildCommandCenterState();
		const jsn = resolvePlayer(state, "p_jsn");
		const waddle = resolvePlayer(state, "p_waddle");
		const chase = resolvePlayer(state, "p_jchase");
		expect(jsn && waddle && chase).toBeTruthy();

		expect(recId(jsn!)).toBe("Smith-Njigba");
		expect(recId(jsn!)).not.toBe("JSN");
		expect(recId(jsn!)).not.toBe("Jaxon");
		expect(recId(jsn!)).not.toBe("Njigba");
		expect(recId(waddle!)).toBe("Waddle");
		expect(recId(chase!)).toBe("Chase");

		const packet = buildCsspPacket(state, jsn!, waddle!);
		expect(packet).toContain("Q: Smith-Njigba vs Waddle");
		expect(packet).not.toContain("Q: JSN vs Waddle");
	});

	it("does not highlight the seed JSN rec on Jaxon Smith-Njigba", () => {
		const state = buildCommandCenterState();
		const jsn = resolvePlayer(state, "p_jsn")!;
		const seedJsn = state.recommendations.find((r) => r.id === "JSN");
		expect(seedJsn).toBeDefined();

		expect(recommendationMatchesPlayer(seedJsn!, jsn)).toBe(false);
		expect(
			recommendationMatchesPlayer({ ...seedJsn!, id: "Smith-Njigba" }, jsn),
		).toBe(true);
		expect(
			recommendationMatchesPlayer({ ...seedJsn!, id: "p_jsn" }, jsn),
		).toBe(true);
		expect(
			recommendationMatchesPlayer({ ...seedJsn!, id: "SMITH-NJIGBA" }, jsn),
		).toBe(true);
	});

	it("keeps the seed JSN rec after a live Smith-Njigba verdict (dual recs)", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName(
			`jsn-merge-${crypto.randomUUID()}`,
		);
		const stub = env.WORKFLOW_STATUS.get(doId);

		const decision = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				return instance.decide("p_jsn", "p_waddle", false, {
					apiKey: "test-xai-key",
					fetchImpl: mockXaiFetch({
						act: "SIT",
						delta: -1.5,
						conf: 0.66,
						why: "Slot share already priced in",
						flags: ["NEWS"],
					}),
				});
			},
		);

		expect(decision.recs.map((r) => r.id)).toEqual([
			"Smith-Njigba",
			"Waddle",
		]);
		expect(decision.recs[0]?.act).toBe("SIT");

		const state = await stub.getFantasyState();
		const recIds = state.recommendations.map((r) => r.id);
		expect(recIds).toContain("Smith-Njigba");
		expect(recIds).toContain("JSN");
		expect(recIds).toContain("Waddle");
		expect(recIds.filter((id) => id === "Waddle")).toHaveLength(1);

		const seedJsn = state.recommendations.find((r) => r.id === "JSN");
		const liveJsn = state.recommendations.find(
			(r) => r.id === "Smith-Njigba",
		);
		expect(seedJsn?.act).toBe("START");
		expect(liveJsn?.act).toBe("SIT");
	});
});

describe("xAI model echo leftover", () => {
	it("persists the xAI payload model even when a different model was requested", async () => {
		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				model: "grok-4",
				fetchImpl: mockXaiFetch(
					{
						act: "SIT",
						delta: -4.2,
						conf: 0.8,
						why: "Ankle DNP in Buffalo wind",
						flags: ["INJ", "WX"],
					},
					"grok-4-fast",
				),
			},
		);

		expect(decision.model).toBe("grok-4-fast");
		expect(decision.model).not.toBe("grok-4");
	});
});

describe("Sleeper record, rank, DST, and leagueId leftovers", () => {
	it("formats ties as W-L-T and omitted settings as 0-0", async () => {
		const tied = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "2" },
			createSleeperFetch(sleeperLeagueMocks({ ties: 2, wins: 8, losses: 5 })),
		);
		expect(tied.record).toBe("8-5-2");
		expect(tied.record).not.toBe("8-5");

		const missingSettings = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "2" },
			createSleeperFetch(sleeperLeagueMocks({ settings: null })),
		);
		expect(missingSettings.record).toBe("0-0");
	});

	it("uses roster_id as rank even when fpts/wins say otherwise", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "2" },
			createSleeperFetch(
				sleeperLeagueMocks({
					rosterId: 2,
					wins: 0,
					losses: 13,
					fpts: 9999,
				}),
			),
		);

		expect(roster.rank).toBe(2);
		expect(roster.teamId).toBe("sleeper_1122334455_2");
		const dst = roster.bench.find((p) => p.id === "p_NYJ");
		expect(dst?.name).toBe("NYJ Defense");
		expect(dst?.pos).toBe("DST");
		expect(dst?.team).toBe("NYJ");
	});

	it("maps unknown 3-letter codes as DST Defense, not FLEX Player #", () => {
		const nyj = mapSleeperPlayerIdToPlayer("NYJ");
		expect(nyj).toMatchObject({
			id: "p_NYJ",
			name: "NYJ Defense",
			pos: "DST",
			team: "NYJ",
		});
		expect(nyj.name).not.toBe("Player #NYJ");

		const knownBal = mapSleeperPlayerIdToPlayer("BAL");
		expect(knownBal.name).toBe("Baltimore Ravens");
		expect(knownBal.pos).toBe("DST");
	});

	it("rejects whitespace-only leagueId before fetch", async () => {
		let called = false;
		await expect(
			importSleeperRoster(
				{ leagueId: "   " },
				async () => {
					called = true;
					throw new Error("should not fetch");
				},
			),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 400,
			message: "Sleeper leagueId is required",
		});
		expect(called).toBe(false);
	});

	it("trims padded leagueId in Sleeper request paths", async () => {
		const captured = { urls: [] as string[] };
		const roster = await importSleeperRoster(
			{ leagueId: "  1122334455  ", userOrRosterId: "rival_boss" },
			createSleeperFetch(sleeperLeagueMocks(), captured),
		);

		expect(captured.urls).toContain(
			"https://api.sleeper.app/v1/league/1122334455",
		);
		expect(captured.urls.some((u) => u.includes("  1122334455  "))).toBe(
			false,
		);
		expect(roster.teamId).toBe("sleeper_1122334455_2");
	});

	it("maps whitespace-only leagueId through the Durable Object as HTTP 400", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName(
			`sleeper-blank-${crypto.randomUUID()}`,
		);
		const stub = env.WORKFLOW_STATUS.get(doId);

		const res = await stub.fetch("https://do/roster/sleeper-import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ leagueId: "   " }),
		});

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toEqual({
			error: "Sleeper leagueId is required",
		});
	});

	it("persists a tied Sleeper record on the Durable Object", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName(
			`sleeper-ties-${crypto.randomUUID()}`,
		);
		const stub = env.WORKFLOW_STATUS.get(doId);

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.importSleeper(
				"1122334455",
				"2",
				createSleeperFetch(sleeperLeagueMocks({ ties: 1 })),
			);
		});

		const state = await stub.getFantasyState();
		expect(state.activeRoster.record).toBe("8-5-1");
		expect(state.activeRoster.rank).toBe(2);
	});
});

describe("worker leftover on intel refresh", () => {
	it("rejects GET /api/fantasy/intel/refresh (UI posts)", async () => {
		const res = await worker.fetch(
			new Request("https://example.com/api/fantasy/intel/refresh"),
			env,
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
