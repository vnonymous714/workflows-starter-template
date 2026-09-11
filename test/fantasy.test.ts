import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { executeGrokDecision } from "../src/fantasy-intel";

describe("Fantasy Command Center & Grok Token Optimization", () => {
	it("executes compact Grok decision with token reduction vs legacy", () => {
		const decision = executeGrokDecision("p_kyren", "p_charbonnet", false);

		expect(decision.task).toBe("WK14_DECISION");
		expect(decision.recs).toHaveLength(2);

		const kyrenRec = decision.recs.find((r) => r.id === "Kyren");
		expect(kyrenRec).toBeDefined();
		expect(kyrenRec?.act).toBe("SIT");
		expect(kyrenRec?.delta).toBeLessThan(0);
		expect(kyrenRec?.flags).toContain("INJ");
		expect(kyrenRec?.why.split(" ").length).toBeLessThanOrEqual(12);

		const charbonnetRec = decision.recs.find((r) => r.id === "Charbonnet");
		expect(charbonnetRec).toBeDefined();
		expect(charbonnetRec?.act).toBe("START");
		expect(charbonnetRec?.delta).toBeGreaterThan(0);

		// Verify token footprint optimization
		expect(decision.tokensUsed).toBeLessThan(500);
		expect(decision.tokensUsed).toBeLessThan(decision.legacyTokensEquivalent);
		expect(
			(decision.legacyTokensEquivalent - decision.tokensUsed) /
				decision.legacyTokensEquivalent,
		).toBeGreaterThan(0.85); // >85% token savings
	});

	it("handles player matchups and enforces concise reason lengths", () => {
		const decision = executeGrokDecision("p_waddle", "p_jsn", false);
		expect(decision.recs).toHaveLength(2);

		decision.recs.forEach((rec) => {
			expect(rec.why.split(" ").length).toBeLessThanOrEqual(12);
			expect(rec.conf).toBeGreaterThanOrEqual(0.5);
		});
	});

	it("persists state and handles RPC operations through WorkflowStatusDO", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_fantasy_team");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const state = await stub.getFantasyState();
		expect(state).toBeDefined();
		expect(state.selectedWeek).toBe(14);
		expect(state.activeRoster.starters.length).toBeGreaterThan(0);
		expect(state.intelPacket.beatReports.length).toBeGreaterThan(0);

		// Execute RPC decision
		const decision = await stub.decide("p_kyren", "p_charbonnet");
		expect(decision.recs.length).toBe(2);

		// Swap roster positions
		const swappedState = await stub.swapRoster("p_kyren", "p_charbonnet");
		const starterNames = swappedState.activeRoster.starters.map((s) => s.name);
		expect(starterNames).toContain("Zach Charbonnet");

		// Refresh intel
		const refreshedState = await stub.refreshIntel();
		expect(refreshedState.intelPacket.fresh).toBe(true);
		expect(refreshedState.liveAlerts[0].type).toBe("GROK");
	});
});
