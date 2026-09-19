import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("MyWorkflow event handling", () => {
	it("completes even when the approval payload is rejected", async () => {
		const instanceId = `reject-${crypto.randomUUID()}`;

		await using instance = await introspectWorkflowInstance(
			env.MY_WORKFLOW,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.disableSleeps();
			await m.mockEvent({
				type: "user-approval",
				payload: { approved: false, comment: "Rejected via test" },
			});
		});

		await env.MY_WORKFLOW.create({ id: instanceId });

		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("ignores a mismatched event type and still waits for user-approval", async () => {
		const instanceId = `wrong-type-${crypto.randomUUID()}`;

		await using instance = await introspectWorkflowInstance(
			env.MY_WORKFLOW,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.disableSleeps();
		});

		await env.MY_WORKFLOW.create({ id: instanceId });
		await instance.waitForStepResult({ name: "process data" });

		const handle = await env.MY_WORKFLOW.get(instanceId);
		await handle.sendEvent({
			type: "not-user-approval",
			payload: { approved: true },
		});

		const statusAfterMismatch = await handle.status();
		expect(statusAfterMismatch.status).not.toBe("complete");
		expect(statusAfterMismatch.status).not.toBe("errored");

		await handle.sendEvent({
			type: "user-approval",
			payload: { approved: true, comment: "late approval" },
		});

		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});
});
