import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CommandCenterState } from "../src/types/fantasy";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function uniqueName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

async function connectFantasySocket(
	stub: DurableObjectStub<WorkflowStatusDO>,
): Promise<{
	socket: WebSocket;
	messages: Array<{ type?: string; payload?: CommandCenterState }>;
}> {
	const response = await stub.fetch("https://do/", {
		headers: { Upgrade: "websocket" },
	});
	const socket = response.webSocket;
	if (!socket) {
		throw new Error("Expected WebSocket");
	}

	const messages: Array<{ type?: string; payload?: CommandCenterState }> = [];
	socket.addEventListener("message", (event) => {
		messages.push(
			JSON.parse(String(event.data)) as {
				type?: string;
				payload?: CommandCenterState;
			},
		);
	});
	socket.accept();
	return { socket, messages };
}

function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 3000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - start > timeoutMs) {
				reject(new Error(`Timed out waiting for ${label}`));
				return;
			}
			setTimeout(tick, 10);
		};
		tick();
	});
}

describe("WorkflowStatusDO fantasy persistence and HTTP contracts", () => {
	it("preserves the starter slot position when swapping a WR onto an RB line", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("swap-pos")),
		);

		const swapped = await stub.swapRoster("p_kyren", "p_jsn");
		const starter = swapped.activeRoster.starters.find((p) => p.id === "p_jsn");
		const bench = swapped.activeRoster.bench.find((p) => p.id === "p_kyren");

		expect(starter?.name).toBe("Jaxon Smith-Njigba");
		expect(starter?.pos).toBe("RB");
		expect(bench?.name).toBe("Kyren Williams");
		expect(bench?.pos).toBe("WR");
		expect(swapped.liveAlerts[0]?.type).toBe("LINEUP");
	});

	it("restores swapped roster and lastDecision after Durable Object eviction", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("evict")),
		);

		await stub.swapRoster("p_kyren", "p_charbonnet");
		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.decide("p_charbonnet", "p_kyren", false, {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [
							{
								message: {
									content: JSON.stringify({
										act: "START",
										delta: 3.1,
										conf: 0.8,
										why: "Dome smash",
										flags: ["INJ"],
									}),
								},
							},
						],
						usage: { total_tokens: 88 },
					}),
			});
		});

		await evictDurableObject(stub);

		const restored = await stub.getFantasyState();
		expect(restored.activeRoster.starters.map((p) => p.id)).toContain(
			"p_charbonnet",
		);
		expect(restored.activeRoster.starters.map((p) => p.id)).not.toContain(
			"p_kyren",
		);
		expect(restored.lastDecision?.tokensUsed).toBe(88);
		expect(restored.lastDecision?.recs[0]?.act).toBe("START");
	});

	it("broadcasts fantasy_update to an already-connected client after a swap", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("broadcast")),
		);
		const { socket, messages } = await connectFantasySocket(stub);

		await waitFor(
			() => messages.some((m) => m.type === "fantasy_update"),
			"initial fantasy_update",
		);

		await stub.swapRoster("p_kyren", "p_charbonnet");
		await waitFor(
			() =>
				messages.some(
					(m) =>
						m.type === "fantasy_update" &&
						m.payload?.activeRoster.starters.some((p) => p.id === "p_charbonnet"),
				),
			"swap fantasy_update",
		);

		socket.close(1000, "done");
	});

	it("echoes workflow state for non-JSON and unknown websocket frames", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("ws-fallback")),
		);
		const { socket, messages } = await connectFantasySocket(stub);

		await waitFor(
			() => messages.some((m) => m.type === "workflow_update"),
			"initial workflow_update",
		);
		const before = messages.filter((m) => m.type === "workflow_update").length;

		socket.send("not-json");
		socket.send(JSON.stringify({ type: "nope" }));

		await waitFor(
			() => messages.filter((m) => m.type === "workflow_update").length >= before + 2,
			"fallback workflow_update frames",
		);

		socket.close(1000, "done");
	});

	it("maps GrokRequestError from HTTP /decide to 502 XAI_REQUEST_FAILED", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("decide-502")),
		);

		const response = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				const envWithKey = instance.env as Env & { XAI_API_KEY?: string };
				envWithKey.XAI_API_KEY = "test-xai-key";
				const originalFetch = globalThis.fetch;
				globalThis.fetch = (async (input, init) => {
					if (String(input).includes("api.x.ai")) {
						return new Response("quota", { status: 429 });
					}
					return originalFetch(input, init);
				}) as typeof fetch;
				try {
					return await instance.fetch(
						new Request("https://do/decide", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								playerA: "p_kyren",
								playerB: "p_charbonnet",
							}),
						}),
					);
				} finally {
					globalThis.fetch = originalFetch;
				}
			},
		);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({
			code: "XAI_REQUEST_FAILED",
		});
	});

	it("rejects unknown Durable Object paths and wrong HTTP methods with 400", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("methods")),
		);

		const unknown = await stub.fetch("https://do/nope");
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toBe("Expected WebSocket or API route");

		const getDecide = await stub.fetch("https://do/decide");
		expect(getDecide.status).toBe(400);

		const postState = await stub.fetch("https://do/state", { method: "POST" });
		expect(postState.status).toBe(400);

		const getRefresh = await stub.fetch("https://do/intel/refresh");
		expect(getRefresh.status).toBe(400);
	});
});

describe("Worker fantasy routing", () => {
	it("prefers instanceId over teamId on /ws, and empty instanceId falls through to teamId", async () => {
		const teamId = uniqueName("ws-team");
		const otherId = uniqueName("ws-other");

		await fetchWorker(`/api/fantasy/roster/swap?teamId=${teamId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				starterId: "p_kyren",
				benchId: "p_charbonnet",
			}),
		});

		const preferred = await fetchWorker(
			`/ws?instanceId=${teamId}&teamId=${otherId}`,
			{ headers: { Upgrade: "websocket" } },
		);
		expect(preferred.status).toBe(101);
		const preferredSocket = preferred.webSocket!;
		const preferredMessages: Array<{
			type?: string;
			payload?: CommandCenterState;
		}> = [];
		const gotPreferred = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for preferred fantasy_update")),
				3000,
			);
			preferredSocket.addEventListener("message", (event) => {
				const data = JSON.parse(String(event.data)) as {
					type?: string;
					payload?: CommandCenterState;
				};
				preferredMessages.push(data);
				if (data.type === "fantasy_update") {
					clearTimeout(timer);
					resolve();
				}
			});
		});
		preferredSocket.accept();
		await gotPreferred;
		preferredSocket.close(1000, "done");
		expect(
			preferredMessages
				.find((m) => m.type === "fantasy_update")
				?.payload?.activeRoster.starters.map((p) => p.id),
		).toContain("p_charbonnet");

		const fallback = await fetchWorker(`/ws?instanceId=&teamId=${teamId}`, {
			headers: { Upgrade: "websocket" },
		});
		expect(fallback.status).toBe(101);
		const fallbackSocket = fallback.webSocket!;
		const fallbackMessages: Array<{
			type?: string;
			payload?: CommandCenterState;
		}> = [];
		const gotFallback = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for fallback fantasy_update")),
				3000,
			);
			fallbackSocket.addEventListener("message", (event) => {
				const data = JSON.parse(String(event.data)) as {
					type?: string;
					payload?: CommandCenterState;
				};
				fallbackMessages.push(data);
				if (data.type === "fantasy_update") {
					clearTimeout(timer);
					resolve();
				}
			});
		});
		fallbackSocket.accept();
		await gotFallback;
		fallbackSocket.close(1000, "done");
		expect(
			fallbackMessages
				.find((m) => m.type === "fantasy_update")
				?.payload?.activeRoster.starters.map((p) => p.id),
		).toContain("p_charbonnet");
	});

	it("forwards unknown fantasy subpaths and GET decide to the Durable Object 400", async () => {
		const unknown = await fetchWorker("/api/fantasy/nope?teamId=routing");
		expect(unknown.status).toBe(400);
		expect(await unknown.text()).toBe("Expected WebSocket or API route");

		const getDecide = await fetchWorker("/api/fantasy/decide?teamId=routing");
		expect(getDecide.status).toBe(400);
	});
});
