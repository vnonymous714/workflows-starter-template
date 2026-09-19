import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("MyWorkflow", () => {
	it("completes and returns expected step result", async () => {
		const instanceId = `test-${Date.now()}`;

		await using instance = await introspectWorkflowInstance(
			env.MY_WORKFLOW,
			instanceId,
		);

		await instance.modify(async (m) => {
			await m.disableSleeps();
			await m.mockEvent({
				type: "user-approval",
				payload: { approved: true },
			});
		});

		await env.MY_WORKFLOW.create({ id: instanceId });

		const result = await instance.waitForStepResult({ name: "process data" });

		expect(result).toMatchObject({
			processed: true,
		});
		expect(result).toHaveProperty("timestamp");

		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("notifies the status durable object as steps complete", async () => {
		const instanceId = `test-${crypto.randomUUID()}`;

		await using instance = await introspectWorkflowInstance(
			env.MY_WORKFLOW,
			instanceId,
		);

		await instance.modify(async (m) => {
			await m.disableSleeps();
			await m.mockEvent({
				type: "user-approval",
				payload: { approved: true, comment: "lgtm" },
			});
		});

		await env.MY_WORKFLOW.create({ id: instanceId });
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();

		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(instanceId),
		);
		const response = await stub.fetch("https://example.com/", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const state = await new Promise<{
			currentStep: string | null;
			stepStatuses: Record<string, string>;
			workflowStatus: string;
		}>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for DO state")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				clearTimeout(timer);
				resolve(JSON.parse(event.data as string));
			});
			socket.accept();
		});
		socket.close(1000, "done");

		expect(state.workflowStatus).toBe("completed");
		expect(state.currentStep).toBeNull();
		expect(state.stepStatuses).toEqual({
			"process data": "completed",
			"wait 2 seconds": "completed",
			"wait for approval": "completed",
			final: "completed",
		});
	});

	it("errors when approval event times out", async () => {
		const instanceId = `test-${Date.now()}`;

		await using instance = await introspectWorkflowInstance(
			env.MY_WORKFLOW,
			instanceId,
		);

		await instance.modify(async (m) => {
			await m.disableSleeps();
			await m.forceEventTimeout({ name: "wait for approval" });
		});

		await env.MY_WORKFLOW.create({ id: instanceId });

		await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
	});
});
