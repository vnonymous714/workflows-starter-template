import {
	env,
	introspectWorkflow,
	introspectWorkflowInstance,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

function uniqueId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("Worker API", () => {
	it("starts a workflow and returns an instance id", async () => {
		await using introspector = await introspectWorkflow(env.MY_WORKFLOW);
		await introspector.modifyAll(async (m) => {
			await m.disableSleeps();
			await m.mockEvent({
				type: "user-approval",
				payload: { approved: true },
			});
		});

		const response = await fetchWorker("/api/workflow/start", {
			method: "POST",
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			instanceId: string;
			message: string;
		};
		expect(body.instanceId).toEqual(expect.any(String));
		expect(body.instanceId.length).toBeGreaterThan(0);
		expect(body.message).toBe("Workflow started successfully");

		const instances = await introspector.get();
		expect(instances.length).toBe(1);
		await expect(instances[0]?.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("returns workflow status for a created instance", async () => {
		const instanceId = uniqueId("status");
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

		const response = await fetchWorker(`/api/workflow/status/${instanceId}`);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string };
		expect(body.status).toEqual(expect.any(String));
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});

	it("rejects status and event routes that omit an instance id", async () => {
		const statusResponse = await fetchWorker("/api/workflow/status/");
		expect(statusResponse.status).toBe(400);
		await expect(statusResponse.json()).resolves.toEqual({
			error: "Instance ID required",
		});

		const eventResponse = await fetchWorker("/api/workflow/event/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ approved: true }),
		});
		expect(eventResponse.status).toBe(400);
		await expect(eventResponse.json()).resolves.toEqual({
			error: "Instance ID required",
		});
	});

	it("returns 500 when status or event targets a missing instance", async () => {
		const missingId = uniqueId("missing");

		const statusResponse = await fetchWorker(
			`/api/workflow/status/${missingId}`,
		);
		expect(statusResponse.status).toBe(500);
		await expect(statusResponse.json()).resolves.toEqual({
			error: "Failed to get workflow status",
		});

		const eventResponse = await fetchWorker(
			`/api/workflow/event/${missingId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ approved: true }),
			},
		);
		expect(eventResponse.status).toBe(500);
		await expect(eventResponse.json()).resolves.toEqual({
			error: "Failed to send event",
		});
	});

	it("returns 500 when the event body is not valid JSON", async () => {
		const instanceId = uniqueId("bad-json");

		const response = await fetchWorker(`/api/workflow/event/${instanceId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: "Failed to send event",
		});
	});

	it("requires an instanceId and websocket upgrade for /ws", async () => {
		const missingId = await fetchWorker("/ws");
		expect(missingId.status).toBe(400);
		expect(await missingId.text()).toBe(
			"instanceId query parameter required",
		);

		const noUpgrade = await fetchWorker("/ws?instanceId=demo");
		expect(noUpgrade.status).toBe(426);
		expect(await noUpgrade.text()).toBe("Expected Upgrade: websocket");
	});

	it("upgrades /ws to the workflow status durable object", async () => {
		const instanceId = uniqueId("ws");
		const response = await fetchWorker(`/ws?instanceId=${instanceId}`, {
			headers: { Upgrade: "websocket" },
		});

		expect(response.status).toBe(101);
		expect(response.webSocket).toBeDefined();
		response.webSocket?.accept();
		response.webSocket?.close(1000, "done");
	});

	it("returns 404 for unknown routes and disallowed methods", async () => {
		const unknown = await fetchWorker("/api/unknown");
		expect(unknown.status).toBe(404);
		await expect(unknown.json()).resolves.toEqual({ error: "Not Found" });

		const getStart = await fetchWorker("/api/workflow/start");
		expect(getStart.status).toBe(404);

		const getEvent = await fetchWorker("/api/workflow/event/abc");
		expect(getEvent.status).toBe(404);
	});

	it("delivers an HTTP approval event so the workflow can finish", async () => {
		const instanceId = uniqueId("http-event");

		await using instance = await introspectWorkflowInstance(
			env.MY_WORKFLOW,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.disableSleeps();
		});

		await env.MY_WORKFLOW.create({ id: instanceId });

		const response = await fetchWorker(`/api/workflow/event/${instanceId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				approved: true,
				comment: "Approved via API test",
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			message: "Event sent successfully",
		});
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});
});
