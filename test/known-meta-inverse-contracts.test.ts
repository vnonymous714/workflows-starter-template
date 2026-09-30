import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	executeGrokDecision,
	MissingXaiApiKeyError,
	parseGrokVerdict,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
} from "../src/sleeper-client";
import type { CommandCenterState, GrokRecommendation } from "../src/types/fantasy";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

const SLEEPER_LEAGUE_ID = "1122334455";

const MOCK_USAGE = {
	prompt_tokens: 100,
	completion_tokens: 40,
	total_tokens: 140,
};

const MOCK_VERDICT = {
	act: "SIT",
	delta: -4.2,
	conf: 0.81,
	why: "Ankle DNP in Buffalo wind",
	flags: ["INJ", "WX"],
};

function uniqueName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function mockXaiFetch(): typeof fetch {
	return async (input, init) => {
		const url = String(input);
		if (!url.includes("api.x.ai")) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		expect(init?.method).toBe("POST");
		return Response.json({
			model: "grok-4",
			choices: [
				{
					message: {
						content: JSON.stringify(MOCK_VERDICT),
					},
				},
			],
			usage: MOCK_USAGE,
		});
	};
}

function sleeperFetch(): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}`)) {
			return Response.json({
				league_id: SLEEPER_LEAGUE_ID,
				name: "Champions League",
			});
		}
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}/rosters`)) {
			return Response.json([
				{
					roster_id: 2,
					owner_id: "user_102",
					starters: ["8138", "9221"],
					players: ["8138", "9221", "7543", "BAL"],
					settings: { wins: 6, losses: 7, ties: 0, fpts: 1310 },
				},
			]);
		}
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}/users`)) {
			return Response.json([
				{
					user_id: "user_102",
					username: "rival_boss",
					display_name: "Rival Boss",
				},
			]);
		}
		return new Response("Not found", { status: 404 });
	};
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("Sleeper known-player metadata leftovers", () => {
	it("copies injury, weather, tags, opp, and projPts from the known dictionary", () => {
		const kyren = mapSleeperPlayerIdToPlayer("8138");
		expect(kyren).toMatchObject({
			id: "p_8138",
			name: "Kyren Williams",
			pos: "RB",
			team: "LAR",
			opp: "@ BUF",
			projPts: 15.4,
			status: "QUESTIONABLE",
			injuryDesc: "Ankle - Did Not Practice (Thu), Limited (Wed)",
			weatherCondition: "Wind 18-28mph Gusts, Lake Effect",
			tags: ["Game-time Decision", "High Risk"],
		});

		const watson = mapSleeperPlayerIdToPlayer("7543");
		expect(watson.status).toBe("QUESTIONABLE");
		expect(watson.injuryDesc).toBe("Hamstring - Limited Fri");
		expect(watson.tags).toContain("Deep Play Upside");

		const aubrey = mapSleeperPlayerIdToPlayer("11439");
		expect(aubrey.weatherCondition).toBe("Dome");
	});

	it("keeps known metadata when a lineup slot overrides position", () => {
		const flexKyren = mapSleeperPlayerIdToPlayer("8138", "FLEX");
		expect(flexKyren.pos).toBe("FLEX");
		expect(flexKyren.status).toBe("QUESTIONABLE");
		expect(flexKyren.injuryDesc).toContain("Ankle");
		expect(flexKyren.weatherCondition).toContain("Wind");
		expect(flexKyren.tags).toEqual(["Game-time Decision", "High Risk"]);
	});

	it("does not stamp the generic Sleeper Import tag on known DST, unlike unknown codes", () => {
		const ravens = mapSleeperPlayerIdToPlayer("BAL");
		expect(ravens.tags).toEqual(["Top 3 Pressure Rate"]);
		expect(ravens.tags).not.toContain("Sleeper Import");

		const unknownDst = mapSleeperPlayerIdToPlayer("NYJ");
		expect(unknownDst.tags).toEqual(["Sleeper Import"]);
	});

	it("persists known Kyren injury/weather onto the Durable Object after import", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("sleeper-known-meta")),
		);

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.importSleeper(
				SLEEPER_LEAGUE_ID,
				"rival_boss",
				sleeperFetch(),
			);
		});

		const state = await stub.getFantasyState();
		const kyren = state.activeRoster.starters.find((p) => p.id === "p_8138");
		expect(kyren?.status).toBe("QUESTIONABLE");
		expect(kyren?.injuryDesc).toContain("Ankle");
		expect(kyren?.weatherCondition).toContain("Lake Effect");
		expect(kyren?.tags).toEqual(["Game-time Decision", "High Risk"]);
		expect(kyren?.opp).toBe("@ BUF");
		expect(kyren?.projPts).toBe(15.4);

		const watson = state.activeRoster.bench.find((p) => p.id === "p_7543");
		expect(watson?.status).toBe("QUESTIONABLE");
		expect(watson?.injuryDesc).toContain("Hamstring");
	});

	it("puts imported injury and weather on the compact CSSP player line", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: SLEEPER_LEAGUE_ID, userOrRosterId: "2" },
			sleeperFetch(),
		);
		const state = buildCommandCenterState();
		state.activeRoster = roster;

		const kyren = resolvePlayer(state, "p_8138");
		const charbonnet = resolvePlayer(state, "p_9221");
		expect(kyren && charbonnet).toBeTruthy();

		const packet = buildCsspPacket(state, kyren!, charbonnet!, false);
		expect(packet).toContain(
			"inj:Ankle - Did Not Practice (Thu), Limited (Wed)",
		);
		expect(packet).toContain("wx:Wind 18-28mph Gusts, Lake Effect");
		expect(packet).toContain("QUESTIONABLE");
	});
});

describe("Grok inverse and identity leftovers", () => {
	it("inverts SMASH to SIT and DROP to START for the opposing player", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const smash = parseGrokVerdict(
			{ act: "SMASH", delta: 3.5, conf: 0.9, why: "Smash spot", flags: [] },
			kyren,
			charbonnet,
		);
		expect(smash[0]?.act).toBe("SMASH");
		expect(smash[1]?.act).toBe("SIT");
		expect(smash[1]?.delta).toBe(-3.5);

		const drop = parseGrokVerdict(
			{ act: "DROP", delta: -2, conf: 0.6, why: "Cut", flags: [] },
			kyren,
			charbonnet,
		);
		expect(drop[0]?.act).toBe("DROP");
		expect(drop[1]?.act).toBe("START");
		expect(drop[1]?.delta).toBe(2);
	});

	it("rounds the inverse compact delta with toFixed(2)", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{ act: "START", delta: 1.119, conf: 0.5, why: "Edge", flags: [] },
			kyren,
			charbonnet,
		);
		expect(recs[0]?.delta).toBe(1.119);
		expect(recs[1]?.delta).toBe(-1.12);
	});

	it("does not treat a last-name prefix as a recommendation match", () => {
		const kyren = resolvePlayer(buildCommandCenterState(), "p_kyren")!;
		const rec = (id: string): GrokRecommendation => ({
			id,
			act: "SIT",
			vs: "Charbonnet",
			delta: -4.2,
			conf: 0.7,
			why: "Ankle",
			src: "grok",
			flags: ["INJ"],
		});
		expect(recommendationMatchesPlayer(rec("Will"), kyren)).toBe(false);
		expect(recommendationMatchesPlayer(rec("Williams"), kyren)).toBe(true);
		expect(recommendationMatchesPlayer(rec("Kyren"), kyren)).toBe(true);
	});

	it("emits two Williams recs with inverse acts when both query ids are the same player", () => {
		const kyren = resolvePlayer(buildCommandCenterState(), "p_kyren")!;
		const recs = parseGrokVerdict(
			{ act: "START", delta: 3, conf: 0.8, why: "Same player", flags: [] },
			kyren,
			kyren,
		);
		expect(recs.map((r) => r.id)).toEqual(["Williams", "Williams"]);
		expect(recs[0]?.act).toBe("START");
		expect(recs[1]?.act).toBe("SIT");
		expect(recs[0]?.vs).toBe("Williams");
		expect(recs[1]?.vs).toBe("Williams");
	});

	it("treats a whitespace-only xAI key as missing, not as a Bearer of spaces", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{ apiKey: "   " },
			),
		).rejects.toBeInstanceOf(MissingXaiApiKeyError);
	});
});

describe("import and UI HTTP leftovers", () => {
	it("keeps lastDecision after a Sleeper import replaces the roster", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("sleeper-keeps-decision")),
		);

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.decide("p_kyren", "p_charbonnet", false, {
				apiKey: "test-xai-key",
				fetchImpl: mockXaiFetch(),
			});
		});

		const afterDecide = await stub.getFantasyState();
		expect(afterDecide.lastDecision?.tokensUsed).toBe(140);
		expect(afterDecide.lastDecision?.recs[0]?.act).toBe("SIT");

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.importSleeper(
				SLEEPER_LEAGUE_ID,
				"2",
				sleeperFetch(),
			);
		});

		const afterImport = await stub.getFantasyState();
		expect(afterImport.activeRoster.starters.map((p) => p.id)).toEqual([
			"p_8138",
			"p_9221",
		]);
		expect(afterImport.lastDecision?.tokensUsed).toBe(140);
		expect(afterImport.lastDecision?.recs[0]?.id).toBe("Williams");
		expect(afterImport.recommendations.find((r) => r.id === "Williams")?.act).toBe(
			"SIT",
		);
	});

	it("rejects GET /api/fantasy/roster/swap (the Command Center POSTs)", async () => {
		const response = await fetchWorker("/api/fantasy/roster/swap");
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Expected WebSocket");
	});

	it("rejects a trailing slash on GET /api/fantasy/state/", async () => {
		const exact = await fetchWorker("/api/fantasy/state");
		expect(exact.status).toBe(200);
		const seed = (await exact.json()) as CommandCenterState;
		expect(seed.activeRoster.teamId).toBe("tm_gridiron_pulse");

		const trailing = await fetchWorker("/api/fantasy/state/");
		expect(trailing.status).toBe(400);
		expect(await trailing.text()).toBe("Expected WebSocket");
	});
});
