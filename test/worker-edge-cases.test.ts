import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("Worker API edge cases", () => {
	it("rejects an empty instanceId query parameter on /ws", async () => {
		const response = await fetchWorker("/ws?instanceId=");

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("instanceId query parameter required");
	});

	it("does not treat /api/workflow/status as a status lookup", async () => {
		const response = await fetchWorker("/api/workflow/status");

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("does not treat /api/workflow/event as an event delivery route", async () => {
		const response = await fetchWorker("/api/workflow/event", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ approved: true }),
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("uses the last path segment as the workflow instance id", async () => {
		const response = await fetchWorker("/api/workflow/status/foo/missing-id");

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: "Failed to get workflow status",
		});
	});
});
