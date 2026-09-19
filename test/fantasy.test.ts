import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	clipWhy,
	executeGrokDecision,
	extractTokenUsage,
	GrokRequestError,
	MissingXaiApiKeyError,
	parseGrokVerdict,
	recommendationMatchesPlayer,
	resolvePlayer,
	XAI_CHAT_COMPLETIONS_URL,
} from "../src/grok-client";
import {
	buildEspnApiUrl,
	buildEspnCookieHeader,
	fetchEspnLeagueData,
	MissingEspnCredentialsError,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import type { WorkflowStatusDO } from "../worker/durable-object";

const MOCK_USAGE = {
	prompt_tokens: 142,
	completion_tokens: 67,
	total_tokens: 209,
};

const MOCK_VERDICT = {
	act: "SIT",
	delta: -4.2,
	conf: 0.81,
	why: "Ankle DNP in 28mph Buffalo wind",
	flags: ["INJ", "WX"],
};

function mockXaiFetch(
	overrides: {
		status?: number;
		body?: unknown;
		usage?: typeof MOCK_USAGE | null;
	} = {},
): typeof fetch {
	return async (input, init) => {
		const url = String(input);
		if (!url.includes("api.x.ai")) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		expect(init?.method).toBe("POST");
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer test-xai-key");

		if (overrides.status && overrides.status >= 400) {
			return new Response("upstream error", { status: overrides.status });
		}

		return Response.json({
			model: "grok-4",
			choices: [
				{
					message: {
						content: JSON.stringify(overrides.body ?? MOCK_VERDICT),
					},
				},
			],
			usage: overrides.usage === null ? undefined : (overrides.usage ?? MOCK_USAGE),
		});
	};
}

describe("CSSP packet + Grok verdict parsing", () => {
	it("builds a compact Kyren vs Charbonnet packet instead of a 16-player dump", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren");
		const charbonnet = resolvePlayer(state, "p_charbonnet");
		expect(kyren && charbonnet).toBeTruthy();

		const packet = buildCsspPacket(state, kyren!, charbonnet!, false);
		expect(packet).toContain("WK:14");
		expect(packet).toContain("Q: Williams vs Charbonnet");
		expect(packet).toContain("INJ:");
		expect(packet).toContain("WX:");
		expect(packet).not.toContain("Ja'Marr Chase");
		expect(packet).not.toContain("Josh Allen");
		expect(packet.length).toBeLessThan(1800);

		const verbose = buildCsspPacket(state, kyren!, charbonnet!, true);
		expect(verbose).toContain("Ja'Marr Chase");
		expect(verbose.length).toBeGreaterThan(packet.length);
	});

	it("parses structured Grok JSON, clips why to 12 words, and maps both players", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				act: "SIT",
				delta: -4.2,
				conf: 0.81,
				why: "Ankle DNP in 28mph Buffalo wind with extra leftover words here",
				flags: ["INJ", "WX", "NOPE"],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(2);
		expect(recs[0].id).toBe("Williams");
		expect(recs[0].act).toBe("SIT");
		expect(recs[0].delta).toBe(-4.2);
		expect(recs[0].why.split(" ").length).toBeLessThanOrEqual(12);
		expect(recs[0].flags).toEqual(["INJ", "WX"]);
		expect(recs[1].id).toBe("Charbonnet");
		expect(recs[1].act).toBe("START");
		expect(recs[1].delta).toBe(4.2);
		expect(recommendationMatchesPlayer(recs[0], kyren)).toBe(true);
		expect(recommendationMatchesPlayer(recs[1], charbonnet)).toBe(true);
		expect(clipWhy("one two three")).toBe("one two three");
	});

	it("reads actual token usage from prompt+completion when total is omitted", () => {
		expect(extractTokenUsage(MOCK_USAGE)).toBe(209);
		expect(
			extractTokenUsage({ prompt_tokens: 100, completion_tokens: 40 }),
		).toBe(140);
		expect(extractTokenUsage({ input_tokens: 80, output_tokens: 12 })).toBe(92);
		expect(() => extractTokenUsage(undefined)).toThrow(GrokRequestError);
	});
});

describe("executeGrokDecision (mocked xAI)", () => {
	it("throws a clear error when XAI_API_KEY is missing", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{ apiKey: "" },
			),
		).rejects.toBeInstanceOf(MissingXaiApiKeyError);
	});

	it("parses a mocked Grok response and returns usage from the API payload", async () => {
		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch(),
			},
		);

		expect(decision.task).toBe("WK14_DECISION");
		expect(decision.cacheHit).toBe(false);
		expect(decision.tokensUsed).toBe(209);
		expect(decision.tokensUsed).not.toBe(380);
		expect(decision.tokensUsed).not.toBe(4250);
		expect(decision.legacyTokensEquivalent).toBe(4250);
		expect(decision.recs[0].act).toBe("SIT");
		expect(decision.recs[1].act).toBe("START");
		expect(decision.model).toBe("grok-4");
	});

	it("does not silently fall back to canned copy on xAI failure", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: mockXaiFetch({ status: 401 }),
				},
			),
		).rejects.toBeInstanceOf(GrokRequestError);
	});
});

describe("WorkflowStatusDO Grok evaluate path", () => {
	it("returns a missing-key error instead of canned Grok copy", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_fantasy_missing_key");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const res = await stub.fetch("https://do/decide", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				playerA: "p_kyren",
				playerB: "p_charbonnet",
			}),
		});

		expect(res.status).toBe(503);
		const body = (await res.json()) as { code: string; error: string };
		expect(body.code).toBe("XAI_API_KEY_MISSING");
		expect(body.error).toContain("XAI_API_KEY");
	});

	it("parses a mocked Grok response, persists recs + tokensUsed, and returns them", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_fantasy_live_grok");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const decision = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				return instance.decide("p_kyren", "p_charbonnet", false, {
					apiKey: "test-xai-key",
					fetchImpl: mockXaiFetch(),
				});
			},
		);

		expect(decision.tokensUsed).toBe(209);
		expect(decision.recs).toHaveLength(2);
		expect(decision.recs[0].act).toBe("SIT");
		expect(decision.cacheHit).toBe(false);

		const state = await stub.getFantasyState();
		expect(state.lastDecision?.tokensUsed).toBe(209);
		expect(state.lastDecision?.tokensUsed).not.toBe(380);
		const persisted = state.recommendations.find((r) => r.id === "Charbonnet");
		expect(persisted?.act).toBe("START");
		expect(persisted?.delta).toBeGreaterThan(0);
	});

	it("still swaps roster and refreshes intel without Grok", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_fantasy_roster");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const state = await stub.getFantasyState();
		expect(state.selectedWeek).toBe(14);
		expect(state.activeRoster.starters.length).toBeGreaterThan(0);
		expect(state.intelPacket.beatReports.length).toBeGreaterThan(0);

		const swappedState = await stub.swapRoster("p_kyren", "p_charbonnet");
		const starterNames = swappedState.activeRoster.starters.map((s) => s.name);
		expect(starterNames).toContain("Zach Charbonnet");

		const refreshedState = await stub.refreshIntel();
		expect(refreshedState.intelPacket.fresh).toBe(true);
		expect(refreshedState.liveAlerts[0].type).toBe("GROK");
	});
});

describe("xAI request shape", () => {
	it("posts compact JSON schema to the xAI chat completions URL", async () => {
		let capturedUrl = "";
		let capturedBody: {
			model?: string;
			response_format?: { type?: string; json_schema?: { name?: string } };
			messages?: Array<{ content?: string }>;
		} = {};

		await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: async (input, init) => {
					capturedUrl = String(input);
					capturedBody = JSON.parse(String(init?.body)) as typeof capturedBody;
					return mockXaiFetch()(input, init);
				},
			},
		);

		expect(capturedUrl).toBe(XAI_CHAT_COMPLETIONS_URL);
		expect(capturedBody.model).toBe("grok-4");
		expect(capturedBody.response_format?.type).toBe("json_schema");
		expect(capturedBody.response_format?.json_schema?.name).toBe(
			"start_sit_verdict",
		);
		expect(capturedBody.messages?.[1]?.content).toContain("Q: Williams vs Charbonnet");
		expect(capturedBody.messages?.[1]?.content).not.toContain("Ja'Marr Chase");
	});
});

const MOCK_ESPN_RAW_LEAGUE: EspnRawLeagueResponse = {
	id: 12345678,
	seasonId: 2024,
	scoringPeriodId: 14,
	status: {
		latestScoringPeriod: 14,
	},
	members: [
		{
			id: "{A8726312-3214-5432-B812-9876543210AB}",
			displayName: "Commissioner Dave",
		},
	],
	teams: [
		{
			id: 1,
			location: "Gridiron",
			nickname: "Dynasty",
			primaryOwner: "{A8726312-3214-5432-B812-9876543210AB}",
			record: {
				overall: {
					wins: 10,
					losses: 3,
					ties: 0,
				},
			},
			playoffSeed: 1,
			roster: {
				entries: [
					{
						lineupSlotId: 0, // QB Starter
						playerPoolEntry: {
							appliedStatTotal: 24.5,
							player: {
								id: 3918298,
								fullName: "Josh Allen",
								defaultPositionId: 1,
								proTeamId: 2, // BUF
								injuryStatus: "ACTIVE",
							},
						},
					},
					{
						lineupSlotId: 2, // RB Starter
						playerPoolEntry: {
							appliedStatTotal: 17.8,
							player: {
								id: 4426515,
								fullName: "Kyren Williams",
								defaultPositionId: 2,
								proTeamId: 14, // LAR
								injuryStatus: "QUESTIONABLE",
							},
						},
					},
					{
						lineupSlotId: 20, // Bench
						playerPoolEntry: {
							appliedStatTotal: 14.2,
							player: {
								id: 4567890,
								fullName: "Zach Charbonnet",
								defaultPositionId: 2,
								proTeamId: 26, // SEA
								injuryStatus: "ACTIVE",
							},
						},
					},
				],
			},
		},
	],
};

describe("ESPN Fantasy Ingestion Client & Sanitizer", () => {
	it("correctly formats URL and Cookie headers", () => {
		const url = buildEspnApiUrl(2024, "87654321");
		expect(url).toBe(
			"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2024/segments/0/leagues/87654321?view=mRoster&view=mTeam",
		);

		const cookies = buildEspnCookieHeader("sample_s2_token", "{SAMPLE_SWID}");
		expect(cookies).toBe("espn_s2=sample_s2_token; SWID={SAMPLE_SWID}");

		const emptyCookies = buildEspnCookieHeader("", "");
		expect(emptyCookies).toBe("");
	});

	it("throws MissingEspnCredentialsError when leagueId is missing", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "",
			}),
		).rejects.toBeInstanceOf(MissingEspnCredentialsError);
	});

	it("fetches and parses raw ESPN league response with Cookie headers", async () => {
		let capturedHeaders: Record<string, string> = {};
		let capturedUrl = "";

		const mockFetch: typeof fetch = async (input, init) => {
			capturedUrl = String(input);
			const headers = new Headers(init?.headers);
			capturedHeaders = Object.fromEntries(headers.entries());
			return new Response(JSON.stringify(MOCK_ESPN_RAW_LEAGUE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const { rawJson, rawBytes } = await fetchEspnLeagueData({
			leagueId: "12345678",
			season: 2024,
			espnS2: "secret_s2_val",
			swid: "{SWID_VAL}",
			fetchImpl: mockFetch,
		});

		expect(capturedUrl).toContain("12345678");
		expect(capturedHeaders.cookie).toBe("espn_s2=secret_s2_val; SWID={SWID_VAL}");
		expect(rawJson.id).toBe(12345678);
		expect(rawBytes).toBeGreaterThan(100);
	});

	it("throws EspnRequestError with ESPN_AUTH_UNAUTHORIZED on 401/403", async () => {
		const mockFetch: typeof fetch = async () => {
			return new Response("Unauthorized", { status: 401 });
		};

		await expect(
			fetchEspnLeagueData({
				leagueId: "12345678",
				fetchImpl: mockFetch,
			}),
		).rejects.toMatchObject({
			code: "ESPN_AUTH_UNAUTHORIZED",
		});
	});

	it("sanitizes raw ESPN JSON into compact CSSP LeagueRoster and computes token savings", () => {
		const { roster, week, sanitizedTokensEstimate } = sanitizeEspnTeamRoster(
			MOCK_ESPN_RAW_LEAGUE,
			1,
		);

		expect(week).toBe(14);
		expect(roster.teamName).toBe("Gridiron Dynasty");
		expect(roster.owner).toBe("Commissioner Dave");
		expect(roster.record).toBe("10-3");
		expect(roster.starters).toHaveLength(2);
		expect(roster.bench).toHaveLength(1);

		// Check starter mapping
		const qb = roster.starters.find((p) => p.name === "Josh Allen");
		expect(qb).toBeDefined();
		expect(qb?.pos).toBe("QB");
		expect(qb?.team).toBe("BUF");
		expect(qb?.projPts).toBe(24.5);

		const rb = roster.starters.find((p) => p.name === "Kyren Williams");
		expect(rb?.status).toBe("QUESTIONABLE");
		expect(rb?.injuryDesc).toContain("QUESTIONABLE");

		// Check bench mapping
		const benchRb = roster.bench.find((p) => p.name === "Zach Charbonnet");
		expect(benchRb).toBeDefined();
		expect(benchRb?.pos).toBe("RB");

		// Token compression verification
		expect(sanitizedTokensEstimate).toBeLessThan(150);
	});
});

describe("WorkflowStatusDO ESPN sync API path", () => {
	it("returns 400 when leagueId is missing in request and env", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_espn_missing_id");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const res = await stub.fetch("https://do/espn/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; error: string };
		expect(body.code).toBe("ESPN_CREDENTIALS_MISSING");
	});

	it("syncs ESPN roster into Durable Object state, updates token metrics and broadcasts", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_espn_live_sync");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const mockFetch: typeof fetch = async () => {
			return new Response(JSON.stringify(MOCK_ESPN_RAW_LEAGUE), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const updatedState = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				return instance.syncEspnRoster(
					{
						leagueId: "12345678",
						season: 2024,
						espnS2: "test_s2",
						swid: "{TEST_SWID}",
					},
					mockFetch,
				);
			},
		);

		expect(updatedState.activeRoster.teamName).toBe("Gridiron Dynasty");
		expect(updatedState.activeRoster.starters).toHaveLength(2);
		expect(updatedState.espnSyncMeta?.leagueId).toBe("12345678");
		expect(updatedState.espnSyncMeta?.savingsPercent).toBeGreaterThan(0);
		expect(updatedState.liveAlerts[0].type).toBe("ESPN");

		// Confirm persisted in DO storage
		const persisted = await stub.getFantasyState();
		expect(persisted.activeRoster.teamName).toBe("Gridiron Dynasty");
		expect(persisted.espnSyncMeta?.leagueId).toBe("12345678");
	});
});

describe("Sleeper Roster Import", () => {
	const mockSleeperLeague = {
		league_id: "1122334455",
		name: "Champions League",
		total_rosters: 12,
		season: "2024",
	};

	const mockSleeperRosters = [
		{
			roster_id: 1,
			owner_id: "user_101",
			league_id: "1122334455",
			starters: ["4984", "8183", "7564", "4035", "11439", "BAL"],
			players: ["4984", "8183", "7564", "4035", "11439", "BAL", "9221", "9493", "8136"],
			settings: { wins: 8, losses: 5, ties: 0, fpts: 1420 },
		},
		{
			roster_id: 2,
			owner_id: "user_102",
			league_id: "1122334455",
			starters: ["8138", "7553"],
			players: ["8138", "7553", "7543"],
			settings: { wins: 6, losses: 7, ties: 0, fpts: 1310 },
		},
	];

	const mockSleeperUsers = [
		{
			user_id: "user_101",
			username: "gridiron_king",
			display_name: "Gridiron King",
			metadata: { team_name: "Apex Predators" },
		},
		{
			user_id: "user_102",
			username: "rival_boss",
			display_name: "Rival Boss",
		},
	];

	function createMockSleeperFetch(): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/1122334455")) {
				return Response.json(mockSleeperLeague);
			}
			if (url.endsWith("/league/1122334455/rosters")) {
				return Response.json(mockSleeperRosters);
			}
			if (url.endsWith("/league/1122334455/users")) {
				return Response.json(mockSleeperUsers);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("imports real Sleeper roster and maps players, metadata, and record", async () => {
		const { importSleeperRoster } = await import("../src/sleeper-client");
		const roster = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "gridiron_king" },
			createMockSleeperFetch(),
		);

		expect(roster.teamName).toContain("Apex Predators");
		expect(roster.owner).toContain("Gridiron King");
		expect(roster.record).toBe("8-5");
		expect(roster.starters.length).toBe(6);
		expect(roster.bench.length).toBe(3);

		const starterNames = roster.starters.map((s) => s.name);
		expect(starterNames).toContain("Josh Allen");
		expect(starterNames).toContain("Bijan Robinson");
		expect(starterNames).toContain("Ja'Marr Chase");

		const benchNames = roster.bench.map((b) => b.name);
		expect(benchNames).toContain("Zach Charbonnet");
	});

	it("updates Durable Object activeRoster on /roster/sleeper-import", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_sleeper_do");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const stateBefore = await stub.getFantasyState();
		expect(stateBefore.activeRoster.teamName).toBe("Neural Gridiron Pulse");

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.importSleeper(
				"1122334455",
				"gridiron_king",
				createMockSleeperFetch(),
			);
		});

		const stateAfter = await stub.getFantasyState();
		expect(stateAfter.activeRoster.teamName).toContain("Apex Predators");
		expect(stateAfter.activeRoster.starters.length).toBe(6);
		expect(stateAfter.liveAlerts[0].type).toBe("LINEUP");
		expect(stateAfter.liveAlerts[0].message).toContain("Sleeper Roster Imported");
	});
});
