import { describe, expect, it } from "vitest";
import { buildCommandCenterState, INITIAL_ROSTER } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	clipWhy,
	executeGrokDecision,
	parseGrokVerdict,
	recId,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import type { FantasyPlayer, GrokRecommendation } from "../src/types/fantasy";

const MOCK_USAGE = {
	prompt_tokens: 10,
	completion_tokens: 5,
	total_tokens: 15,
};

function player(overrides: Partial<FantasyPlayer> & Pick<FantasyPlayer, "name">): FantasyPlayer {
	return {
		id: "p_stub",
		pos: "RB",
		team: "SEA",
		opp: "@ ARI",
		projPts: 10,
		status: "ACTIVE",
		...overrides,
	};
}

function rec(overrides: Partial<GrokRecommendation>): GrokRecommendation {
	return {
		id: "Williams",
		act: "SIT",
		vs: "Charbonnet",
		delta: -1,
		conf: 0.5,
		why: "test",
		src: "grok",
		flags: [],
		...overrides,
	};
}

describe("buildCommandCenterState isolation", () => {
	it("clones roster and intel so mutations cannot leak across team instances", () => {
		const a = buildCommandCenterState();
		const b = buildCommandCenterState();
		a.activeRoster.starters[0].name = "MUTATED";
		a.intelPacket.fresh = false;
		a.recommendations[0].act = "DROP";

		expect(b.activeRoster.starters[0].name).toBe("Josh Allen");
		expect(INITIAL_ROSTER.starters[0].name).toBe("Josh Allen");
		expect(b.intelPacket.fresh).toBe(true);
		expect(b.recommendations[0].act).toBe("SIT");
	});
});

describe("recId, matching, and inverse actions", () => {
	it("uses the first name when the last token is 3 characters or shorter, and the whole name when there is only one token", () => {
		expect(recId(player({ name: "Bo Nix" }))).toBe("Bo");
		expect(recId(player({ name: "Amon-Ra" }))).toBe("Amon-Ra");
		expect(recId(player({ name: "Kyren Williams" }))).toBe("Williams");
	});

	it("matches recommendations by player id, first name, or last name", () => {
		const kyren = resolvePlayer(buildCommandCenterState(), "p_kyren")!;
		expect(recommendationMatchesPlayer(rec({ id: "p_kyren" }), kyren)).toBe(
			true,
		);
		expect(recommendationMatchesPlayer(rec({ id: "Kyren" }), kyren)).toBe(true);
		expect(recommendationMatchesPlayer(rec({ id: "Williams" }), kyren)).toBe(
			true,
		);
		expect(recommendationMatchesPlayer(rec({ id: "Chase" }), kyren)).toBe(
			false,
		);
	});

	it("inverts ADD to SIT and TRADE_* to HOLD for the opposing player", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const add = parseGrokVerdict(
			{ act: "ADD", delta: 2.25, conf: 0.7, why: "Upside", flags: [] },
			kyren,
			charbonnet,
		);
		expect(add[0].act).toBe("ADD");
		expect(add[1].act).toBe("SIT");
		expect(add[1].delta).toBe(-2.25);

		const tradeYes = parseGrokVerdict(
			{ act: "TRADE_Y", delta: 1, conf: 0.6, why: "Sell high", flags: [] },
			kyren,
			charbonnet,
		);
		expect(tradeYes[0].act).toBe("TRADE_Y");
		expect(tradeYes[1].act).toBe("HOLD");

		const tradeNo = parseGrokVerdict(
			{ act: "TRADE_N", delta: -1, conf: 0.6, why: "Keep", flags: [] },
			kyren,
			charbonnet,
		);
		expect(tradeNo[0].act).toBe("TRADE_N");
		expect(tradeNo[1].act).toBe("HOLD");
	});

	it("clips why to 12 words and collapses extra whitespace", () => {
		expect(clipWhy("  one   two  three ")).toBe("one two three");
		expect(clipWhy("")).toBe("");
		expect(
			clipWhy("one two three four five six seven eight nine ten eleven twelve thirteen").split(
				" ",
			),
		).toHaveLength(12);
	});
});

describe("CSSP compact vs legacy packets", () => {
	it("emits - none and skips dash practice days when related intel is empty or unused", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;
		state.intelPacket.injuries = [
			{
				...state.intelPacket.injuries[0],
				practiceReport: { wed: "-", thu: "DNP", fri: "-" },
			},
		];
		state.intelPacket.weather = [];
		state.intelPacket.beatReports = [];

		const packet = buildCsspPacket(state, kyren, charbonnet, false);
		expect(packet).toContain("Thu-DNP");
		expect(packet).not.toContain("Wed-");
		expect(packet).not.toContain("Fri-");

		state.intelPacket.injuries = [];
		const empty = buildCsspPacket(state, kyren, charbonnet, false);
		expect(empty).toContain("- none");
	});

	it("legacy dump includes every starter/bench line, weather location, and beat author", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;
		const legacy = buildCsspPacket(state, kyren, charbonnet, true);

		expect(legacy).toContain("full roster dump");
		expect(legacy).toContain("STARTER");
		expect(legacy).toContain("BENCH");
		expect(legacy).toContain("Ja'Marr Chase");
		expect(legacy).toContain("Highmark Stadium");
		expect(legacy).toContain("precip45");
		expect(legacy).toContain("Ian Rapoport");
		expect(legacy).toContain("@RapSheet");
	});
});

describe("executeGrokDecision request and parse edges", () => {
	it("posts the legacy packet and a custom model when requested", async () => {
		let captured: { model?: string; messages?: Array<{ content?: string }> } =
			{};

		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				useLegacy: true,
				model: "grok-custom",
				fetchImpl: async (_input, init) => {
					captured = JSON.parse(String(init?.body)) as typeof captured;
					return Response.json({
						choices: [
							{
								message: {
									content: JSON.stringify({
										act: "SIT",
										delta: -1,
										conf: 0.5,
										why: "Test",
										flags: [],
									}),
								},
							},
						],
						usage: MOCK_USAGE,
					});
				},
			},
		);

		expect(captured.model).toBe("grok-custom");
		expect(captured.messages?.[1]?.content).toContain("full roster dump");
		expect(captured.messages?.[1]?.content).toContain("Ja'Marr Chase");
		expect(decision.model).toBe("grok-custom");
		expect(decision.tokensUsed).toBe(15);
	});

	it("falls back to the requested model when the xAI payload omits model", async () => {
		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [
							{
								message: {
									content: JSON.stringify({
										act: "HOLD",
										delta: 0,
										conf: 0.4,
										why: "Toss up",
										flags: [],
									}),
								},
							},
						],
						usage: MOCK_USAGE,
					}),
			},
		);

		expect(decision.model).toBe("grok-4");
		expect(decision.recs[0].act).toBe("HOLD");
		expect(decision.recs[1].act).toBe("HOLD");
	});

	it("includes truncated upstream detail on HTTP failure and rejects unparsable JSON braces", async () => {
		const state = buildCommandCenterState();
		const detail = "x".repeat(200);

		await expect(
			executeGrokDecision(state, "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () => new Response(detail, { status: 429 }),
			}),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_REQUEST_FAILED",
			message: expect.stringMatching(/^xAI request failed \(429\): x{180}$/),
		});

		await expect(
			executeGrokDecision(state, "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [{ message: { content: "prefix {not json} suffix" } }],
						usage: MOCK_USAGE,
					}),
			}),
		).rejects.toMatchObject({
			code: "XAI_INVALID_RESPONSE",
			message: "Grok JSON verdict could not be parsed.",
		});

		expect(() =>
			parseGrokVerdict("not-an-object", resolvePlayer(state, "p_kyren")!, resolvePlayer(state, "p_charbonnet")!),
		).toThrow(/empty/);
	});
});
