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
	recId,
	recommendationMatchesPlayer,
	resolvePlayer,
	XAI_CHAT_COMPLETIONS_URL,
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
	it("returns isolated command-center snapshots so roster mutations do not leak across teams", () => {
		const a = buildCommandCenterState();
		const b = buildCommandCenterState();
		a.activeRoster.starters[0].id = "mutated";
		a.intelPacket.fresh = false;
		expect(b.activeRoster.starters[0].id).toBe("p_jallen");
		expect(b.intelPacket.fresh).toBe(true);
	});
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

describe("Grok verdict validation and player resolution", () => {
	it("resolves players by id, case-insensitive name, and rejects unknowns", async () => {
		const state = buildCommandCenterState();
		expect(resolvePlayer(state, "p_kyren")?.name).toBe("Kyren Williams");
		expect(resolvePlayer(state, "KYREN")?.id).toBe("p_kyren");
		expect(resolvePlayer(state, "Charbonnet")?.id).toBe("p_charbonnet");
		expect(resolvePlayer(state, "no-such-player")).toBeUndefined();

		await expect(
			executeGrokDecision(state, "p_missing", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch(),
			}),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			message: "Unknown player in start/sit query.",
			code: "XAI_INVALID_RESPONSE",
		});
	});

	it("uses last names longer than 3 characters as rec ids", () => {
		const state = buildCommandCenterState();
		const chase = resolvePlayer(state, "p_jchase")!;
		const ravens = resolvePlayer(state, "p_baldst")!;
		expect(recId(chase)).toBe("Chase");
		expect(recId(ravens)).toBe("Ravens");
	});

	it("treats whitespace-only API keys as missing", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{ apiKey: "   " },
			),
		).rejects.toBeInstanceOf(MissingXaiApiKeyError);
	});

	it("rejects empty verdicts, invalid acts, and recs missing required fields", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() => parseGrokVerdict(null, kyren, charbonnet)).toThrow(
			GrokRequestError,
		);
		expect(() => parseGrokVerdict({}, kyren, charbonnet)).toThrow(
			/missing act, delta, or conf/,
		);
		expect(() =>
			parseGrokVerdict(
				{ act: "YEET", delta: 1, conf: 0.5, why: "nope", flags: [] },
				kyren,
				charbonnet,
			),
		).toThrow(/invalid act/);
		expect(() =>
			parseGrokVerdict(
				{ recs: [{ id: "Williams", act: "SIT" }] },
				kyren,
				charbonnet,
			),
		).toThrow(/missing required fields/);
	});

	it("maps recs[] payloads and inverts HOLD/SMASH/DROP for the opposing player", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const fromRecs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "HOLD",
						vs: "Charbonnet",
						delta: 0,
						conf: 0.4,
						why: "Too close to call",
						flags: ["SPLIT", "BOGUS"],
					},
				],
			},
			kyren,
			charbonnet,
		);
		expect(fromRecs).toHaveLength(1);
		expect(fromRecs[0].act).toBe("HOLD");
		expect(fromRecs[0].flags).toEqual(["SPLIT"]);

		const hold = parseGrokVerdict(
			{ act: "HOLD", delta: 0, conf: 0.5, why: "Coin flip", flags: [] },
			kyren,
			charbonnet,
		);
		expect(hold[0].act).toBe("HOLD");
		expect(hold[1].act).toBe("HOLD");
		expect(hold[1].delta).toBe(0);

		const smash = parseGrokVerdict(
			{
				act: "SMASH",
				delta: 6.1,
				conf: 0.91,
				why: "Goal line work",
				flags: "not-an-array",
			},
			charbonnet,
			kyren,
		);
		expect(smash[0].act).toBe("SMASH");
		expect(smash[1].act).toBe("SIT");
		expect(smash[1].delta).toBe(-6.1);
		expect(smash[0].flags).toEqual([]);

		const drop = parseGrokVerdict(
			{ act: "DROP", delta: -3, conf: 0.6, why: "Ankle", flags: [] },
			kyren,
			charbonnet,
		);
		expect(drop[0].act).toBe("DROP");
		expect(drop[1].act).toBe("START");
	});

	it("parses JSON buried in markdown and rejects missing usage or content", async () => {
		const state = buildCommandCenterState();

		const wrapped = await executeGrokDecision(
			state,
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [
							{
								message: {
									content: `Here you go:\n\`\`\`json\n${JSON.stringify(MOCK_VERDICT)}\n\`\`\``,
								},
							},
						],
						usage: MOCK_USAGE,
					}),
			},
		);
		expect(wrapped.recs[0].act).toBe("SIT");
		expect(wrapped.recs[1].act).toBe("START");

		await expect(
			executeGrokDecision(state, "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [{ message: { content: "not json at all" } }],
						usage: MOCK_USAGE,
					}),
			}),
		).rejects.toMatchObject({ code: "XAI_INVALID_RESPONSE" });

		await expect(
			executeGrokDecision(state, "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [{ message: { content: JSON.stringify(MOCK_VERDICT) } }],
					}),
			}),
		).rejects.toThrow(/did not include token usage/);

		await expect(
			executeGrokDecision(state, "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [{ message: { content: JSON.stringify(MOCK_VERDICT) } }],
						usage: { prompt_tokens: 10 },
					}),
			}),
		).rejects.toThrow(/missing prompt\/completion token counts/);

		await expect(
			executeGrokDecision(state, "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [{ message: {} }],
						usage: MOCK_USAGE,
					}),
			}),
		).rejects.toThrow(/missing message content/);
	});

	it("clips related beat claims and omits unrelated roster intel from the compact packet", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;
		state.intelPacket = {
			...state.intelPacket,
			beatReports: [
				{
					...state.intelPacket.beatReports[0],
					claim: `${"x".repeat(141)} leftover`,
				},
				...state.intelPacket.beatReports.slice(1),
			],
		};

		const packet = buildCsspPacket(state, kyren, charbonnet, false);
		expect(packet).toContain("BEAT @RapSheet:");
		expect(packet).toContain("...");
		expect(packet).not.toContain("leftover");
		expect(packet).not.toContain("@AdamSchefter");
		expect(packet).toContain("Wed-LP");
		expect(packet).toContain("Thu-DNP");
	});
});

describe("WorkflowStatusDO fantasy persistence edges", () => {
	it("leaves the roster unchanged when a swap id does not match both sides", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName(
			`test_fantasy_swap_noop_${crypto.randomUUID()}`,
		);
		const stub = env.WORKFLOW_STATUS.get(doId);

		const before = await stub.getFantasyState();
		const starterIds = before.activeRoster.starters.map((p) => p.id);
		const unchanged = await stub.swapRoster("p_kyren", "p_missing");
		expect(unchanged.activeRoster.starters.map((p) => p.id)).toEqual(
			starterIds,
		);
		expect(unchanged.liveAlerts[0]?.type).not.toBe("LINEUP");
	});

	it("merges new Grok recs without dropping unrelated recommendations", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName(
			`test_fantasy_merge_${crypto.randomUUID()}`,
		);
		const stub = env.WORKFLOW_STATUS.get(doId);

		const before = await stub.getFantasyState();
		expect(before.recommendations.some((r) => r.id === "Waddle")).toBe(true);

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.decide("p_kyren", "p_charbonnet", false, {
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch(),
			});
		});

		const after = await stub.getFantasyState();
		expect(after.recommendations.find((r) => r.id === "Williams")?.act).toBe(
			"SIT",
		);
		expect(after.recommendations.find((r) => r.id === "Charbonnet")?.act).toBe(
			"START",
		);
		expect(after.recommendations.some((r) => r.id === "Waddle")).toBe(true);
		expect(after.recommendations.some((r) => r.id === "JSN")).toBe(true);
	});

	it("answers ping and get_fantasy_state websocket frames used by live clients", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName(
			`test_fantasy_ws_${crypto.randomUUID()}`,
		);
		const stub = env.WORKFLOW_STATUS.get(doId);

		const response = await stub.fetch("https://do/", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		expect(socket).toBeTruthy();

		const messages: Array<{ type?: string; payload?: unknown }> = [];
		const gotPong = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for pong")),
				3000,
			);
			socket!.addEventListener("message", (event) => {
				const data = JSON.parse(String(event.data)) as {
					type?: string;
				};
				messages.push(data);
				if (data.type === "pong") {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		socket!.accept();
		socket!.send(JSON.stringify({ type: "get_fantasy_state" }));
		socket!.send(JSON.stringify({ type: "ping" }));
		await gotPong;
		socket!.close(1000, "done");

		expect(messages.some((m) => m.type === "workflow_update")).toBe(true);
		expect(messages.some((m) => m.type === "fantasy_update")).toBe(true);
		expect(messages.filter((m) => m.type === "fantasy_update").length).toBeGreaterThanOrEqual(
			2,
		);
		expect(messages.some((m) => m.type === "pong")).toBe(true);
	});
});

