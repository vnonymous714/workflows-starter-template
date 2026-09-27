import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	extractTokenUsage,
	GrokRequestError,
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

function uniqueTeam(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function xaiSuccess(): Response {
	return Response.json({
		model: "grok-4",
		choices: [{ message: { content: JSON.stringify(MOCK_VERDICT) } }],
		usage: MOCK_USAGE,
	});
}

describe("extractTokenUsage incomplete payloads", () => {
	it("rejects usage that has only prompt or only completion counts", () => {
		expect(() => extractTokenUsage({ prompt_tokens: 10 })).toThrow(
			GrokRequestError,
		);
		expect(() => extractTokenUsage({ completion_tokens: 5 })).toThrow(
			GrokRequestError,
		);
		expect(() => extractTokenUsage({ input_tokens: 8 })).toThrow(
			GrokRequestError,
		);
		expect(() => extractTokenUsage({ output_tokens: 3 })).toThrow(
			GrokRequestError,
		);
		expect(() => extractTokenUsage({})).toThrow(/prompt\/completion token counts/);
	});
});

describe("executeGrokDecision transport", () => {
	it("trims padded API keys before sending the Bearer header", async () => {
		let authorization = "";

		await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "  test-xai-key  ",
				fetchImpl: async (_input, init) => {
					authorization = new Headers(init?.headers).get("Authorization") ?? "";
					return xaiSuccess();
				},
			},
		);

		expect(authorization).toBe("Bearer test-xai-key");
	});

	it("does not wrap a 200 non-JSON xAI body as GrokRequestError", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: async () =>
						new Response("<html>ok</html>", {
							status: 200,
							headers: { "Content-Type": "text/html" },
						}),
				},
			),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).not.toBeInstanceOf(GrokRequestError);
			expect(error).toBeInstanceOf(SyntaxError);
			return true;
		});
	});
});

describe("Grok HTTP /decide transport contracts", () => {
	it("maps a 200 non-JSON xAI body to 500 XAI_REQUEST_FAILED, not 502", async () => {
		const teamId = uniqueTeam("decide-html");
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(teamId),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			if (String(input).includes("api.x.ai")) {
				return new Response("not-json", { status: 200 });
			}
			return originalFetch(input, init);
		};

		try {
			const response = await runInDurableObject(
				stub,
				async (instance: WorkflowStatusDO) => {
					(instance.env as Env & { XAI_API_KEY?: string }).XAI_API_KEY =
						"test-xai-key";
					return instance.fetch(
						new Request("https://do/decide", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								playerA: "p_kyren",
								playerB: "p_charbonnet",
							}),
						}),
					);
				},
			);

			expect(response.status).toBe(500);
			await expect(response.json()).resolves.toMatchObject({
				code: "XAI_REQUEST_FAILED",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("posts the verbose CSSP packet when HTTP /decide sets useLegacy true", async () => {
		const teamId = uniqueTeam("decide-legacy");
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(teamId),
		);
		let capturedUrl = "";
		let userPacket = "";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			capturedUrl = String(input);
			const body = JSON.parse(String(init?.body)) as {
				messages?: Array<{ content?: string }>;
			};
			userPacket = body.messages?.[1]?.content ?? "";
			return xaiSuccess();
		};

		try {
			const response = await runInDurableObject(
				stub,
				async (instance: WorkflowStatusDO) => {
					(instance.env as Env & { XAI_API_KEY?: string }).XAI_API_KEY =
						"test-xai-key";
					return instance.fetch(
						new Request("https://do/decide", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								playerA: "p_kyren",
								playerB: "p_charbonnet",
								useLegacy: true,
							}),
						}),
					);
				},
			);

			expect(response.status).toBe(200);
			expect(capturedUrl).toBe(XAI_CHAT_COMPLETIONS_URL);
			expect(userPacket).toContain("full roster dump");
			expect(userPacket).toContain("Ja'Marr Chase");
			expect(userPacket).toContain("STARTER");
			expect(userPacket).not.toContain("WK:14 PPR:0.5");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
