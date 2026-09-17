import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	extractTokenUsage,
	parseGrokVerdict,
	resolvePlayer,
} from "../src/grok-client";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function uniqueTeam(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function decideWithKey(
	teamId: string,
	body: unknown,
): Promise<Response> {
	const stub = env.WORKFLOW_STATUS.get(env.WORKFLOW_STATUS.idFromName(teamId));
	return runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
		const envWithKey = instance.env as Env & { XAI_API_KEY?: string };
		envWithKey.XAI_API_KEY = "test-xai-key";
		return instance.fetch(
			new Request("https://do/decide", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	});
}

describe("Grok HTTP error mapping", () => {
	it("maps unknown players to 502 XAI_INVALID_RESPONSE, not a 400", async () => {
		const response = await decideWithKey(uniqueTeam("decide-unknown"), {
			playerA: "p_missing",
			playerB: "p_charbonnet",
		});

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: "Unknown player in start/sit query.",
			code: "XAI_INVALID_RESPONSE",
		});
	});

	it("maps the same unknown-player contract through the worker fantasy proxy", async () => {
		const teamId = uniqueTeam("decide-unknown-worker");
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(teamId),
		);
		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			(instance.env as Env & { XAI_API_KEY?: string }).XAI_API_KEY =
				"test-xai-key";
		});

		const response = await worker.fetch(
			new Request(
				`https://example.com/api/fantasy/decide?teamId=${teamId}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						playerA: "p_missing",
						playerB: "p_kyren",
					}),
				},
			),
			env,
		);

		expect(response.status).toBe(502);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("XAI_INVALID_RESPONSE");
	});

	it("maps missing decide fields to 500 XAI_REQUEST_FAILED instead of hanging", async () => {
		const response = await decideWithKey(uniqueTeam("decide-empty"), {});

		expect(response.status).toBe(500);
		const body = (await response.json()) as { code: string; error: string };
		expect(body.code).toBe("XAI_REQUEST_FAILED");
		expect(body.error.length).toBeGreaterThan(0);
	});
});

describe("Grok verdict and player-match edges", () => {
	it("treats an empty recs array as absent and uses compact act/delta/conf", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{ recs: [], act: "SIT", delta: -1.25, conf: 0.5, why: "Close" },
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(2);
		expect(recs[0]?.act).toBe("SIT");
		expect(recs[1]?.act).toBe("START");
		expect(recs[1]?.delta).toBe(1.25);
	});

	it("coerces recs numeric strings and fills missing vs/src/why/flags", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						delta: "-4.20",
						conf: "0.81",
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toEqual([
			{
				id: "Williams",
				act: "SIT",
				vs: "",
				delta: -4.2,
				conf: 0.81,
				why: "",
				src: "grok",
				flags: [],
			},
		]);
	});

	it("keeps exact id matches ahead of prefix collisions used by Grok queries", () => {
		const state = buildCommandCenterState();

		expect(resolvePlayer(state, "p_j")?.id).toBe("p_jallen");
		expect(resolvePlayer(state, "p_jsn")?.id).toBe("p_jsn");
		expect(resolvePlayer(state, "p_jchase")?.id).toBe("p_jchase");
	});

	it("counts total_tokens of 0 as real usage instead of falling through", () => {
		expect(extractTokenUsage({ total_tokens: 0 })).toBe(0);
		expect(
			extractTokenUsage({
				total_tokens: 0,
				prompt_tokens: 12,
				completion_tokens: 8,
			}),
		).toBe(0);
	});
});

describe("CSSP related-intel team bleed", () => {
	it("includes same-team beats and omits the other conference's weather", () => {
		const state = buildCommandCenterState();
		const jsn = resolvePlayer(state, "p_jsn")!;
		const waddle = resolvePlayer(state, "p_waddle")!;

		const packet = buildCsspPacket(state, jsn, waddle, false);

		expect(packet).toContain("Q: Smith-Njigba vs Waddle");
		expect(packet).toContain("BEAT @bcondotta:");
		expect(packet).toContain("BEAT @AdamSchefter:");
		// JSN is SEA, so Charbonnet's SEA goal-line beat is pulled in by team.
		expect(packet).toContain("BEAT @JFowlerNFL:");
		expect(packet).not.toContain("BEAT @RapSheet:");
		expect(packet).toContain("SEA @ ARI");
		expect(packet).toContain("MIA @ NYJ");
		expect(packet).not.toContain("LAR @ BUF");
	});
});
