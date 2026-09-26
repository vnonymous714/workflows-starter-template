import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WorkflowStatusDO } from "../worker/durable-object";

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

function nextMessage(
	socket: WebSocket,
	timeoutMs = 3000,
): Promise<WorkflowUpdateMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.removeEventListener("message", onMessage);
			reject(new Error("Timed out waiting for workflow_update"));
		}, timeoutMs);

		const onMessage = (event: MessageEvent) => {
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
			resolve(JSON.parse(event.data as string) as WorkflowUpdateMessage);
		};

		socket.addEventListener("message", onMessage);
	});
}

async function connect(
	stub: DurableObjectStub<WorkflowStatusDO>,
): Promise<{ socket: WebSocket; snapshot: Promise<WorkflowUpdateMessage> }> {
	const response = await stub.fetch("https://example.com/", {
		headers: { Upgrade: "websocket" },
	});
	const socket = response.webSocket;
	if (!socket) {
		throw new Error("Expected WebSocket response");
	}

	// Listen before accept() so the immediate snapshot is not dropped.
	const snapshot = nextMessage(socket);
	socket.accept();
	return { socket, snapshot };
}

async function drainSnapshot(
	stub: DurableObjectStub<WorkflowStatusDO>,
): Promise<WorkflowUpdateMessage> {
	const { socket, snapshot } = await connect(stub);
	const state = await snapshot;
	socket.close(1000, "done");
	return state;
}

describe("WorkflowStatusDO realtime and isolation", () => {
	it("broadcasts updateStep to an already-connected client", async () => {
		const stub = stubFor(`live-${crypto.randomUUID()}`);
		const { socket, snapshot } = await connect(stub);
		await snapshot;

		const pending = nextMessage(socket);
		await stub.updateStep("process data", "running");
		const update = await pending;

		expect(update.type).toBe("workflow_update");
		expect(update.currentStep).toBe("process data");
		expect(update.stepStatuses["process data"]).toBe("running");
		expect(update.workflowStatus).toBe("running");
		socket.close(1000, "done");
	});

	it("fans out the same snapshot to every connected client", async () => {
		const stub = stubFor(`fanout-${crypto.randomUUID()}`);
		const first = await connect(stub);
		const second = await connect(stub);
		await Promise.all([first.snapshot, second.snapshot]);

		const pending = Promise.all([
			nextMessage(first.socket),
			nextMessage(second.socket),
		]);
		await stub.updateStep("wait for approval", "waiting");
		const [a, b] = await pending;

		expect(a.currentStep).toBe("wait for approval");
		expect(b.currentStep).toBe("wait for approval");
		expect(a.stepStatuses["wait for approval"]).toBe("waiting");
		expect(b.stepStatuses["wait for approval"]).toBe("waiting");
		expect(a.workflowStatus).toBe(b.workflowStatus);

		first.socket.close(1000, "done");
		second.socket.close(1000, "done");
	});

	it("keeps currentStep on completed until every known step finishes", async () => {
		const stub = stubFor(`current-${crypto.randomUUID()}`);

		await stub.updateStep("process data", "running");
		await stub.updateStep("process data", "completed");

		let state = await drainSnapshot(stub);
		expect(state.currentStep).toBe("process data");
		expect(state.workflowStatus).toBe("running");

		await stub.updateStep("wait 2 seconds", "completed");
		await stub.updateStep("wait for approval", "completed");
		state = await drainSnapshot(stub);
		expect(state.currentStep).toBe("process data");
		expect(state.workflowStatus).toBe("running");

		await stub.updateStep("final", "completed");
		state = await drainSnapshot(stub);
		expect(state.currentStep).toBeNull();
		expect(state.workflowStatus).toBe("completed");
	});

	it("does not mark the workflow complete while an extra step is still open", async () => {
		const stub = stubFor(`extra-${crypto.randomUUID()}`);

		await stub.updateStep("typo-step", "running");
		await stub.updateStep("process data", "completed");
		await stub.updateStep("wait 2 seconds", "completed");
		await stub.updateStep("wait for approval", "completed");
		await stub.updateStep("final", "completed");

		const state = await drainSnapshot(stub);
		expect(state.workflowStatus).toBe("running");
		expect(state.currentStep).toBe("typo-step");
		expect(state.stepStatuses["typo-step"]).toBe("running");
	});

	it("isolates step state between durable object names", async () => {
		const suffix = crypto.randomUUID();
		const first = stubFor(`iso-a-${suffix}`);
		const second = stubFor(`iso-b-${suffix}`);

		await first.updateStep("process data", "running");

		const other = await drainSnapshot(second);
		expect(other.currentStep).toBeNull();
		expect(other.stepStatuses["process data"]).toBe("pending");
		expect(other.workflowStatus).toBe("running");
	});

	it("restores a completed workflow after eviction", async () => {
		const stub = stubFor(`done-${crypto.randomUUID()}`);

		for (const step of [
			"process data",
			"wait 2 seconds",
			"wait for approval",
			"final",
		]) {
			await stub.updateStep(step, "completed");
		}

		await evictDurableObject(stub);

		const state = await drainSnapshot(stub);
		expect(state.workflowStatus).toBe("completed");
		expect(state.currentStep).toBeNull();
		expect(state.stepStatuses).toEqual({
			"process data": "completed",
			"wait 2 seconds": "completed",
			"wait for approval": "completed",
			final: "completed",
		});
	});
});
