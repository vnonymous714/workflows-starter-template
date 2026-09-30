import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	GrokRequestError,
	parseGrokVerdict,
	resolvePlayer,
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

describe("parseGrokVerdict recs coercion", () => {
	it("treats a null recs delta as 0 instead of a missing-field error", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "HOLD",
						delta: null,
						conf: 0.4,
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(recs[0]?.delta).toBe(0);
		expect(recs[0]?.act).toBe("HOLD");
	});

	it("rejects recs with an invalid act and non-object items", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{
					recs: [
						{
							id: "Williams",
							act: "YEET",
							delta: 1,
						},
					],
				},
				kyren,
				charbonnet,
			),
		).toThrow(/invalid act/);

		expect(() =>
			parseGrokVerdict({ recs: ["not-a-rec"] }, kyren, charbonnet),
		).toThrow(/missing required fields/);
	});

	it("coerces compact delta/conf numeric strings", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{ act: "SIT", delta: "-4.20", conf: "0.81", why: "Wind" },
			kyren,
			charbonnet,
		);

		expect(recs[0]?.delta).toBe(-4.2);
		expect(recs[0]?.conf).toBe(0.81);
		expect(recs[1]?.delta).toBe(4.2);
	});
});

describe("resolvePlayer empty tokens", () => {
	it("matches the first rostered player when the query is an empty string", () => {
		const state = buildCommandCenterState();
		const firstStarter = state.activeRoster.starters[0];

		expect(resolvePlayer(state, "")?.id).toBe(firstStarter?.id);
		expect(resolvePlayer(state, "")?.name).toBe("Josh Allen");
	});
});

describe("executeGrokDecision payload edges", () => {
	it("treats empty message content as missing, not as parseable JSON", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: async () =>
						Response.json({
							choices: [{ message: { content: "" } }],
							usage: MOCK_USAGE,
						}),
				},
			),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(GrokRequestError);
			expect((error as GrokRequestError).code).toBe("XAI_INVALID_RESPONSE");
			expect((error as Error).message).toMatch(/missing message content/);
			return true;
		});
	});

	it("omits a detail suffix when the xAI error body is empty", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: async () => new Response("", { status: 401 }),
				},
			),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(GrokRequestError);
			expect((error as GrokRequestError).code).toBe("XAI_REQUEST_FAILED");
			expect((error as Error).message).toBe("xAI request failed (401)");
			return true;
		});
	});

	it("still evaluates when playerA is empty because resolvePlayer first-matches", async () => {
		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [
							{
								message: {
									content: JSON.stringify(MOCK_VERDICT),
								},
							},
						],
						usage: MOCK_USAGE,
					}),
			},
		);

		expect(decision.recs[0]?.id).toBe("Allen");
		expect(decision.recs[1]?.id).toBe("Charbonnet");
	});
});

describe("HTTP /decide malformed bodies", () => {
	it("does not map invalid JSON through grokErrorResponse because request.json is outside the try", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(
				`decide-bad-json-${crypto.randomUUID()}`,
			),
		);

		await expect(
			runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
				return instance.fetch(
					new Request("https://do/decide", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: "{not-json",
					}),
				);
			}),
		).rejects.toThrow(SyntaxError);
	});
});
