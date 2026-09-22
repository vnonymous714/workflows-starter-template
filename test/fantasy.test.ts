import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	GrokRequestError,
	MissingXaiApiKeyError,
	recommendationMatchesPlayer,
} from "../src/grok-client";
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
		usage?: Record<string, number> | null;
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
	it("builds a compact Kyren vs Charbonnet packet instead of a 16-player dump", async () => {
		let compact = "";
		await executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
			apiKey: "test-xai-key",
			fetchImpl: async (input, init) => {
				const payload = JSON.parse(String(init?.body)) as {
					messages?: Array<{ content?: string }>;
				};
				compact = payload.messages?.[1]?.content ?? "";
				return mockXaiFetch()(input, init);
			},
		});
		expect(compact).toContain("WK:14");
		expect(compact).toContain("Q: Williams vs Charbonnet");
		expect(compact).toContain("INJ:");
		expect(compact).toContain("WX:");
		expect(compact).not.toContain("Ja'Marr Chase");
		expect(compact).not.toContain("Josh Allen");
		expect(compact.length).toBeLessThan(1800);

		let verbose = "";
		await executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
			apiKey: "test-xai-key",
			useLegacy: true,
			fetchImpl: async (input, init) => {
				const payload = JSON.parse(String(init?.body)) as {
					messages?: Array<{ content?: string }>;
				};
				verbose = payload.messages?.[1]?.content ?? "";
				return mockXaiFetch()(input, init);
			},
		});
		expect(verbose).toContain("Ja'Marr Chase");
		expect(verbose.length).toBeGreaterThan(compact.length);
	});

	it("parses structured Grok JSON, clips why to 12 words, and maps both players", async () => {
		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch({
					body: {
						act: "SIT",
						delta: -4.2,
						conf: 0.81,
						why: "Ankle DNP in 28mph Buffalo wind with extra leftover words here",
						flags: ["INJ", "WX", "NOPE"],
					},
				}),
			},
		);
		const recs = decision.recs;
		const state = buildCommandCenterState();
		const kyren = state.activeRoster.starters.find((p) => p.id === "p_kyren")!;
		const charbonnet = state.activeRoster.bench.find((p) => p.id === "p_charbonnet")!;

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
	});

	it("reads actual token usage from prompt+completion when total is omitted", async () => {
		const withTotal = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{ apiKey: "test-xai-key", fetchImpl: mockXaiFetch() },
		);
		expect(withTotal.tokensUsed).toBe(209);

		const promptCompletion = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch({
					usage: { prompt_tokens: 100, completion_tokens: 40 },
				}),
			},
		);
		expect(promptCompletion.tokensUsed).toBe(140);

		const inputOutput = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch({
					usage: { input_tokens: 80, output_tokens: 12 },
				}),
			},
		);
		expect(inputOutput.tokensUsed).toBe(92);

		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch({ usage: null }),
			}),
		).rejects.toBeInstanceOf(GrokRequestError);
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

		expect(capturedUrl).toBe("https://api.x.ai/v1/chat/completions");
		expect(capturedBody.model).toBe("grok-4");
		expect(capturedBody.response_format?.type).toBe("json_schema");
		expect(capturedBody.response_format?.json_schema?.name).toBe(
			"start_sit_verdict",
		);
		expect(capturedBody.messages?.[1]?.content).toContain("Q: Williams vs Charbonnet");
		expect(capturedBody.messages?.[1]?.content).not.toContain("Ja'Marr Chase");
	});
});
