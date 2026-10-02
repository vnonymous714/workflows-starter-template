import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	extractTokenUsage,
	parseGrokVerdict,
	resolvePlayer,
} from "../src/grok-client";
import {
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
} from "../src/sleeper-client";
import worker from "../worker/index";

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

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("Worker leftover header and path contracts", () => {
	it("rejects RFC-capitalized Upgrade: WebSocket (exact websocket match only)", async () => {
		const response = await fetchWorker("/ws?instanceId=demo", {
			headers: { Upgrade: "WebSocket" },
		});
		expect(response.status).toBe(426);
		expect(await response.text()).toBe("Expected Upgrade: websocket");
		expect(response.webSocket).toBeNull();
	});

	it("treats instanceId=0 as present and upgrades instead of 400", async () => {
		const response = await fetchWorker("/ws?instanceId=0", {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(101);
		expect(response.webSocket).toBeDefined();
		response.webSocket?.accept();
		response.webSocket?.close(1000, "done");
	});

	it("maps GET /api/fantasy/ (empty subpath) to Expected WebSocket", async () => {
		const response = await fetchWorker("/api/fantasy/");
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Expected WebSocket");
	});
});

describe("ESPN leftover null entries and case-folded injury", () => {
	it("treats roster.entries null as an empty roster instead of throwing", () => {
		const raw = {
			id: 77,
			seasonId: 2024,
			teams: [
				{
					id: 4,
					name: "Null Bench",
					roster: {
						entries: null,
					},
				},
			],
		} as unknown as EspnRawLeagueResponse;

		const { roster, sanitizedTokensEstimate } = sanitizeEspnTeamRoster(raw, 4);

		expect(roster.starters).toEqual([]);
		expect(roster.bench).toEqual([]);
		expect(roster.teamName).toBe("Null Bench");
		expect(sanitizedTokensEstimate).toBe(60);
	});

	it("maps unpadded lowercase questionable to QUESTIONABLE (inverse of padded codes)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			{
				id: 88,
				seasonId: 2024,
				teams: [
					{
						id: 1,
						name: "Q Wire",
						roster: {
							entries: [
								{
									lineupSlotId: 2,
									playerPoolEntry: {
										appliedStatTotal: 15.4,
										player: {
											id: 4426515,
											fullName: "Kyren Williams",
											defaultPositionId: 2,
											proTeamId: 14,
											injuryStatus: "questionable",
										},
									},
								},
							],
						},
					},
				],
			},
			1,
		);

		expect(roster.starters[0]).toMatchObject({
			id: "espn_4426515",
			name: "Kyren Williams",
			status: "QUESTIONABLE",
			injuryDesc: "questionable on ESPN injury wire",
			tags: ["QUESTIONABLE"],
		});
	});

	it("formats an omitted ESPN record as 0-0", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 1,
			seasonId: 2024,
			teams: [
				{
					id: 2,
					name: "No Record FC",
				},
			],
		});

		expect(roster.record).toBe("0-0");
		expect(roster.rank).toBe(1);
	});
});

describe("Grok leftover coercions", () => {
	it("ignores a recs object and uses compact act/delta/conf instead", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				act: "SIT",
				delta: -3.5,
				conf: 0.7,
				why: "Wind and ankle",
				flags: ["WX"],
				recs: {
					id: "Williams",
					act: "START",
					delta: 9,
					conf: 0.99,
				},
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(2);
		expect(recs[0]).toMatchObject({
			id: "Williams",
			act: "SIT",
			delta: -3.5,
			conf: 0.7,
		});
		expect(recs[1].act).toBe("START");
		expect(recs[1].delta).toBe(3.5);
	});

	it("rejects lowercase start as an invalid act (enum is case-sensitive)", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				{ act: "start", delta: 1, conf: 0.5, why: "Smash spot", flags: [] },
				kyren,
				charbonnet,
			),
		).toThrow(/invalid act/);
	});

	it("drops lowercase intel flags instead of normalizing them", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				act: "SIT",
				delta: -1,
				conf: 0.6,
				why: "Game-time tag",
				flags: ["inj", "wx", "INJ"],
			},
			kyren,
			charbonnet,
		);

		expect(recs[0].flags).toEqual(["INJ"]);
		expect(recs[0].flags).not.toContain("inj");
		expect(recs[0].flags).not.toContain("wx");
	});

	it("ignores string total_tokens and sums prompt+completion instead", () => {
		expect(
			extractTokenUsage({
				total_tokens: "209" as unknown as number,
				prompt_tokens: 100,
				completion_tokens: 50,
			}),
		).toBe(150);
	});

	it("accepts zero prompt and completion counts when total is omitted", () => {
		expect(
			extractTokenUsage({ prompt_tokens: 0, completion_tokens: 0 }),
		).toBe(0);
	});

	it("still posts compact JSON when usage is a zero-token xAI body", async () => {
		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: async (input, init) => {
					const url = String(input);
					if (!url.includes("api.x.ai")) {
						throw new Error(`Unexpected fetch: ${url}`);
					}
					return Response.json({
						model: "grok-4",
						choices: [
							{ message: { content: JSON.stringify(MOCK_VERDICT) } },
						],
						usage: { prompt_tokens: 0, completion_tokens: 0 },
					});
				},
			},
		);

		expect(decision.tokensUsed).toBe(0);
		expect(decision.tokensUsed).not.toBe(380);
		expect(decision.recs[0].act).toBe("SIT");
	});
});

describe("Sleeper leftover DST heuristic and slot override", () => {
	it("treats a 4-letter all-caps id as FLEX, not a defense", () => {
		const player = mapSleeperPlayerIdToPlayer("LAFC");
		expect(player).toMatchObject({
			id: "p_LAFC",
			name: "Player #LAFC",
			pos: "FLEX",
			team: "NFL",
			tags: ["Sleeper Import"],
		});
		expect(player.name).not.toBe("LAFC Defense");
		expect(player.pos).not.toBe("DST");
	});

	it("applies the first standard slot to known BAL so the DST starts as QB", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/5566778899")) {
				return Response.json({
					league_id: "5566778899",
					name: "Slot League",
				});
			}
			if (url.endsWith("/league/5566778899/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "user_201",
						starters: ["BAL", "4984"],
						players: ["BAL", "4984"],
						settings: { wins: 3, losses: 2 },
					},
				]);
			}
			if (url.endsWith("/league/5566778899/users")) {
				return Response.json([
					{
						user_id: "user_201",
						username: "dst_first",
						display_name: "DST First",
					},
				]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "5566778899", userOrRosterId: "dst_first" },
			fetchImpl,
		);

		expect(roster.starters).toHaveLength(2);
		expect(roster.starters[0]).toMatchObject({
			id: "p_BAL",
			name: "Baltimore Ravens",
			pos: "QB",
			team: "BAL",
			tags: ["Top 3 Pressure Rate"],
		});
		expect(roster.starters[1]).toMatchObject({
			id: "p_4984",
			name: "Josh Allen",
			pos: "RB",
		});
	});
});

describe("Durable Object leftover empty fantasy subpath", () => {
	it("returns Expected WebSocket for POST /fantasy/ on a unique DO", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("empty-subpath")),
		);
		const response = await stub.fetch("https://do/fantasy/", {
			method: "POST",
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Expected WebSocket");
	});
});
