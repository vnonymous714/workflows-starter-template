import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { CommandCenterState } from "../src/types/fantasy";
import worker from "../worker/index";

function uniqueTeamId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

async function getFantasyState(teamId: string): Promise<CommandCenterState> {
	const response = await fetchWorker(`/api/fantasy/state?teamId=${teamId}`);
	expect(response.status).toBe(200);
	return (await response.json()) as CommandCenterState;
}

describe("Fantasy Command Center worker routes", () => {
	it("loads command-center state for the UI GET /api/fantasy/state contract", async () => {
		const teamId = uniqueTeamId("state");
		const state = await getFantasyState(teamId);

		expect(state.selectedWeek).toBe(14);
		expect(state.activeRoster.teamId).toBe("tm_gridiron_pulse");
		expect(state.activeRoster.starters.map((p) => p.id)).toContain("p_kyren");
		expect(state.activeRoster.bench.map((p) => p.id)).toContain(
			"p_charbonnet",
		);
		expect(state.lastDecision).toBeNull();
	});

	it("defaults omitted teamId to default_team, matching the Command Center client", async () => {
		const response = await fetchWorker("/api/fantasy/state");
		expect(response.status).toBe(200);
		const state = (await response.json()) as CommandCenterState;
		expect(state.activeRoster.starters.length).toBeGreaterThan(0);

		const named = await fetchWorker("/api/fantasy/state?teamId=default_team");
		expect(named.status).toBe(200);
		const namedState = (await named.json()) as CommandCenterState;
		expect(namedState.activeRoster.teamName).toBe(state.activeRoster.teamName);
	});

	it("isolates roster swaps by teamId so one league cannot clobber another", async () => {
		const teamA = uniqueTeamId("iso-a");
		const teamB = uniqueTeamId("iso-b");

		const swap = await fetchWorker(`/api/fantasy/roster/swap?teamId=${teamA}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				starterId: "p_kyren",
				benchId: "p_charbonnet",
			}),
		});
		expect(swap.status).toBe(200);
		const swapped = (await swap.json()) as CommandCenterState;
		expect(swapped.activeRoster.starters.map((p) => p.id)).toContain(
			"p_charbonnet",
		);
		expect(swapped.activeRoster.starters.map((p) => p.id)).not.toContain(
			"p_kyren",
		);
		expect(swapped.liveAlerts[0]?.type).toBe("LINEUP");

		const other = await getFantasyState(teamB);
		expect(other.activeRoster.starters.map((p) => p.id)).toContain("p_kyren");
		expect(other.activeRoster.starters.map((p) => p.id)).not.toContain(
			"p_charbonnet",
		);
	});

	it("returns a missing-key error through the worker decide proxy, not canned copy", async () => {
		const teamId = uniqueTeamId("decide");
		const response = await fetchWorker(`/api/fantasy/decide?teamId=${teamId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				playerA: "p_kyren",
				playerB: "p_charbonnet",
			}),
		});

		expect(response.status).toBe(503);
		const body = (await response.json()) as { code: string; error: string };
		expect(body.code).toBe("XAI_API_KEY_MISSING");
		expect(body.error).toContain("XAI_API_KEY");
	});

	it("refreshes intel through the worker and marks the packet fresh", async () => {
		const teamId = uniqueTeamId("intel");
		const response = await fetchWorker(
			`/api/fantasy/intel/refresh?teamId=${teamId}`,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		const state = (await response.json()) as CommandCenterState;
		expect(state.intelPacket.fresh).toBe(true);
		expect(state.liveAlerts[0]?.type).toBe("GROK");
		expect(state.intelPacket.hash).toMatch(/^intel_wk14_/);
	});

	it("does not treat /api/fantasy as a fantasy route (requires /api/fantasy/ prefix)", async () => {
		const response = await fetchWorker("/api/fantasy");
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not found");
	});

	it("rejects /ws without a websocket upgrade (used by both workflow and fantasy UIs)", async () => {
		const response = await fetchWorker("/ws?teamId=default_team");
		expect(response.status).toBe(426);
		expect(await response.text()).toBe("Expected Upgrade: websocket");
	});

	it("routes /ws?teamId= to the matching Durable Object used by the Command Center", async () => {
		const teamId = uniqueTeamId("ws");
		await fetchWorker(`/api/fantasy/roster/swap?teamId=${teamId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				starterId: "p_kyren",
				benchId: "p_charbonnet",
			}),
		});

		const response = await fetchWorker(`/ws?teamId=${teamId}`, {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(101);
		const socket = response.webSocket;
		expect(socket).toBeTruthy();

		const messages: Array<{ type?: string; payload?: CommandCenterState }> =
			[];
		const gotFantasy = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for fantasy_update")),
				3000,
			);
			socket!.addEventListener("message", (event) => {
				const data = JSON.parse(String(event.data)) as {
					type?: string;
					payload?: CommandCenterState;
				};
				messages.push(data);
				if (data.type === "fantasy_update") {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		socket!.accept();
		await gotFantasy;
		socket!.close(1000, "done");

		const fantasy = messages.find((m) => m.type === "fantasy_update");
		expect(fantasy?.payload?.activeRoster.starters.map((p) => p.id)).toContain(
			"p_charbonnet",
		);
	});
});
