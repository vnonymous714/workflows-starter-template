import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WorkflowStatusDO } from "../worker/durable-object";

const INITIAL_STEPS = {
	"process data": "pending",
	"wait 2 seconds": "pending",
	"wait for approval": "pending",
	final: "pending",
};

interface WorkflowUpdateMessage {
	type: string;
	currentStep: string | null;
	stepStatuses: Record<string, string>;
	workflowStatus: "running" | "completed" | "error";
	timestamp: number;
}

function stubFor(name: string) {
	const id = env.WORKFLOW_STATUS.idFromName(name);
	return env.WORKFLOW_STATUS.get(id);
}

async function readState(
	stub: DurableObjectStub<WorkflowStatusDO>,
): Promise<WorkflowUpdateMessage> {
	const response = await stub.fetch("https://example.com/", {
		headers: { Upgrade: "websocket" },
	});
	const socket = response.webSocket;
	if (!socket) {
		throw new Error("Expected WebSocket response");
	}

	const message = new Promise<WorkflowUpdateMessage>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Timed out waiting for workflow_update")),
			3000,
		);
		socket.addEventListener("message", (event) => {
			clearTimeout(timer);
			resolve(JSON.parse(event.data as string) as WorkflowUpdateMessage);
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error("WebSocket error"));
		});
	});

	socket.accept();
	const data = await message;
	socket.close(1000, "done");
	return data;
}

describe("WorkflowStatusDO", () => {
	it("returns fantasy command center state on GET /state", async () => {
		const stub = stubFor(`http-${crypto.randomUUID()}`);
		const response = await stub.fetch("https://example.com/state");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			activeRoster: { teamName: string };
		};
		expect(body.activeRoster.teamName).toBe("Neural Gridiron Pulse");
	});

	it("rejects unknown HTTP paths", async () => {
		const stub = stubFor(`unknown-${crypto.randomUUID()}`);
		const response = await stub.fetch("https://example.com/nope");

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Expected WebSocket or API route");
	});

	it("sends pending step state on websocket connect", async () => {
		const stub = stubFor(`initial-${crypto.randomUUID()}`);
		const state = await readState(stub);

		expect(state.type).toBe("workflow_update");
		expect(state.currentStep).toBeNull();
		expect(state.workflowStatus).toBe("running");
		expect(state.stepStatuses).toEqual(INITIAL_STEPS);
		expect(state.timestamp).toEqual(expect.any(Number));
	});

	it("tracks the current step for running and waiting updates", async () => {
		const stub = stubFor(`current-${crypto.randomUUID()}`);

		await stub.updateStep("process data", "running");
		await stub.updateStep("process data", "completed");

		let state = await readState(stub);
		expect(state.currentStep).toBe("process data");
		expect(state.stepStatuses["process data"]).toBe("completed");
		expect(state.workflowStatus).toBe("running");

		await stub.updateStep("wait for approval", "waiting");
		state = await readState(stub);
		expect(state.currentStep).toBe("wait for approval");
		expect(state.stepStatuses["wait for approval"]).toBe("waiting");
	});

	it("marks the workflow completed only after every step finishes", async () => {
		const stub = stubFor(`complete-${crypto.randomUUID()}`);

		await stub.updateStep("process data", "running");
		await stub.updateStep("process data", "completed");
		await stub.updateStep("wait 2 seconds", "completed");
		await stub.updateStep("wait for approval", "completed");

		let state = await readState(stub);
		expect(state.workflowStatus).toBe("running");
		expect(state.currentStep).toBe("process data");

		await stub.updateStep("final", "completed");
		state = await readState(stub);

		expect(state.workflowStatus).toBe("completed");
		expect(state.currentStep).toBeNull();
		expect(Object.values(state.stepStatuses)).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
		]);
	});

	it("persists step state across durable object eviction", async () => {
		const stub = stubFor(`persist-${crypto.randomUUID()}`);

		await stub.updateStep("process data", "running");
		await runInDurableObject(stub, async (_instance, durableState) => {
			expect(await durableState.storage.get("currentStep")).toBe(
				"process data",
			);
			expect(await durableState.storage.get("workflowStatus")).toBe(
				"running",
			);
		});

		await evictDurableObject(stub);

		const state = await readState(stub);
		expect(state.currentStep).toBe("process data");
		expect(state.stepStatuses["process data"]).toBe("running");
		expect(state.workflowStatus).toBe("running");
	});

	it("broadcasts the current snapshot when a client sends a message", async () => {
		const stub = stubFor(`echo-${crypto.randomUUID()}`);
		await stub.updateStep("final", "running");

		const response = await stub.fetch("https://example.com/", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const messages: Array<WorkflowUpdateMessage & { type: string }> = [];
		const gotEcho = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for echo")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				messages.push(
					JSON.parse(event.data as string) as WorkflowUpdateMessage & {
						type: string;
					},
				);
				const workflowUpdates = messages.filter(
					(m) => m.type === "workflow_update",
				);
				if (workflowUpdates.length >= 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		socket.accept();
		socket.send("ping");
		await gotEcho;
		socket.close(1000, "done");

		const workflowUpdates = messages.filter(
			(m) => m.type === "workflow_update",
		);
		expect(workflowUpdates[0]?.currentStep).toBe("final");
		expect(workflowUpdates[1]?.currentStep).toBe("final");
		expect(workflowUpdates[1]?.stepStatuses.final).toBe("running");
	});
});
