import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	GrokRequestError,
	parseGrokVerdict,
	resolvePlayer,
} from "../src/grok-client";
import {
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import { importSleeperRoster } from "../src/sleeper-client";
import worker from "../worker/index";

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

function uniqueId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

const MOCK_USAGE = {
	prompt_tokens: 142,
	completion_tokens: 67,
	total_tokens: 209,
};

function leagueWithEntries(
	id: number,
	entries: NonNullable<
		NonNullable<EspnRawLeagueResponse["teams"]>[number]["roster"]
	>["entries"],
	extras: Partial<EspnRawLeagueResponse> = {},
): EspnRawLeagueResponse {
	return {
		id,
		seasonId: 2024,
		teams: [
			{
				id: 1,
				name: `League ${id}`,
				roster: { entries },
			},
		],
		...extras,
	};
}

describe("ESPN leftover string slots, slot-map gaps, and week/owner coercions", () => {
	it("maps leftover string slots 2/6 to RB/TE starters and 20/21 to bench", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(701, [
				{
					lineupSlotId: "2" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 7011,
							fullName: "String Slot RB",
							defaultPositionId: 1,
							proTeamId: 14,
						},
					},
				},
				{
					lineupSlotId: "6" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 7012,
							fullName: "String Slot TE",
							defaultPositionId: 2,
							proTeamId: 25,
						},
					},
				},
				{
					lineupSlotId: "20" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 7013,
							fullName: "String Bench WR",
							defaultPositionId: 3,
							proTeamId: 26,
						},
					},
				},
				{
					lineupSlotId: "21" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 7014,
							fullName: "String IR QB",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => p.pos)).toEqual(["RB", "TE"]);
		expect(roster.bench.map((p) => ({ name: p.name, pos: p.pos }))).toEqual([
			{ name: "String Bench WR", pos: "WR" },
			{ name: "String IR QB", pos: "QB" },
		]);
	});

	it("benches numeric lineupSlotId 1 (not in the ESPN slot map) using defaultPositionId", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(702, [
				{
					lineupSlotId: 1,
					playerPoolEntry: {
						player: {
							id: 7021,
							fullName: "Confused Slot QB",
							defaultPositionId: 1,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.pos).toBe("QB");
		expect(roster.bench[0]?.name).toBe("Confused Slot QB");
	});

	it("maps leftover string defaultPositionId 5/16 on the bench to K/DST", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(703, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 7031,
							fullName: "String Bench K",
							defaultPositionId: "5" as unknown as number,
							proTeamId: 6,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 7032,
							fullName: "String Bench DST",
							defaultPositionId: "16" as unknown as number,
							proTeamId: 33,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => p.pos)).toEqual(["K", "DST"]);
	});

	it("uses status.latestScoringPeriod when scoringPeriodId and currentPeriodId are omitted", () => {
		const { week } = sanitizeEspnTeamRoster({
			id: 704,
			seasonId: 2024,
			status: { latestScoringPeriod: 11 },
			teams: [
				{
					id: 1,
					name: "Latest Period Only",
				},
			],
		});

		expect(week).toBe(11);
	});

	it("does not match a numeric member id to a string primaryOwner (strict ===)", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 705,
			seasonId: 2024,
			members: [
				{
					id: 123 as unknown as string,
					displayName: "Numeric Member",
				},
			],
			teams: [
				{
					id: 1,
					name: "Owner Type Mismatch",
					primaryOwner: "123",
				},
			],
		});

		expect(roster.owner).toBe("ESPN Team Owner");
		expect(roster.owner).not.toBe("Numeric Member");
	});

	it("uses 2024 for numeric NaN season but interpolates string \"NaN\" (leftover of null / \"0\")", async () => {
		const urls: string[] = [];
		const mockFetch: typeof fetch = async (input) => {
			urls.push(String(input));
			return Response.json({
				id: 1,
				seasonId: 2024,
				teams: [],
			});
		};

		await fetchEspnLeagueData({
			leagueId: "999",
			season: Number.NaN,
			fetchImpl: mockFetch,
		});
		await fetchEspnLeagueData({
			leagueId: "999",
			season: "NaN" as unknown as number,
			fetchImpl: mockFetch,
		});

		expect(urls[0]).toContain("/seasons/2024/");
		expect(urls[0]).not.toContain("/seasons/NaN/");
		expect(urls[1]).toContain("/seasons/NaN/");
		expect(urls[1]).not.toContain("/seasons/2024/");
	});
});

describe("Sleeper leftover DST heuristic, starter reindex, and K-slot override", () => {
	const league = {
		league_id: "leftover-league",
		name: "Leftover League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("treats 2-letter unknown SF as SF Defense DST (leftover of NYJ / LAFC / lowercase bal)", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "SF"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.id).toBe("p_SF");
		expect(roster.bench[0]?.name).toBe("SF Defense");
		expect(roster.bench[0]?.pos).toBe("DST");
		expect(roster.bench[0]?.team).toBe("SF");
		expect(roster.bench[0]?.name).not.toBe("Player #SF");
	});

	it("reindexes remaining starters onto hardcoded slots after dropping placeholder \"0\"", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["0", "4984"],
					players: ["0", "4984"],
				},
			]),
		);

		expect(roster.starters).toHaveLength(1);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[0]?.pos).toBe("QB");
		expect(roster.bench).toEqual([]);
	});

	it("keeps known RB metadata when that player occupies the hardcoded K slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: [
						"4984",
						"8183",
						"8138",
						"7564",
						"7553",
						"4035",
						"9221",
						"8136",
					],
					players: [
						"4984",
						"8183",
						"8138",
						"7564",
						"7553",
						"4035",
						"9221",
						"8136",
					],
				},
			]),
		);

		expect(roster.starters).toHaveLength(8);
		expect(roster.starters[7]?.name).toBe("Tyler Allgeier");
		expect(roster.starters[7]?.pos).toBe("K");
		expect(roster.starters[7]?.team).toBe("ATL");
		expect(roster.starters[7]?.tags).toContain("Red Zone Handcuff");
		expect(roster.starters[7]?.projPts).toBe(9.2);
	});
});

describe("Grok leftover extract, array payload, boolean delta, and substring resolve", () => {
	it("extracts markdown-fenced JSON via the greedy brace match (inverse of sibling objects)", async () => {
		const decision = await executeGrokDecision(
			buildCommandCenterState(),
			"p_kyren",
			"p_charbonnet",
			{
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [
							{
								message: {
									content:
										'Sure:\n```json\n{"act":"SIT","delta":-4.2,"conf":0.81,"why":"fenced","flags":["INJ"]}\n```',
								},
							},
						],
						usage: MOCK_USAGE,
					}),
			},
		);

		expect(decision.recs).toHaveLength(2);
		expect(decision.recs[0]?.act).toBe("SIT");
		expect(decision.recs[0]?.delta).toBe(-4.2);
		expect(decision.recs[1]?.act).toBe("START");
		expect(decision.tokensUsed).toBe(209);
	});

	it("treats a top-level JSON array verdict as missing act/delta/conf", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict(
				[
					{
						id: "Williams",
						act: "SIT",
						delta: -1,
						conf: 0.5,
						why: "array payload",
						flags: [],
					},
				],
				kyren,
				charbonnet,
			),
		).toThrow(
			expect.objectContaining({
				name: "GrokRequestError",
				code: "XAI_INVALID_RESPONSE",
				message: "Grok verdict was missing act, delta, or conf.",
			} satisfies Partial<GrokRequestError>),
		);
	});

	it("accepts recs[].delta false as 0 instead of throwing missing fields (leftover of \"abc\" → NaN)", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						delta: false,
						conf: 0.5,
						why: "boolean delta",
						flags: [],
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(recs[0]?.delta).toBe(0);
		expect(Number.isNaN(recs[0]?.delta)).toBe(false);
	});

	it("resolves substring osh to Josh Allen via name includes", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "osh");

		expect(player?.id).toBe("p_jallen");
		expect(player?.name).toBe("Josh Allen");
	});
});

describe("DO leftover WS Ping casing and ESPN trailing-slash routing", () => {
	it("does not pong on JSON type Ping after a fantasy websocket connect", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueId("ws-ping-case")),
		);

		const response = await stub.fetch("https://example.com/?teamId=ping-case", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const messages: Array<{ type?: string }> = [];
		const gotSecond = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for Ping fallback")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				messages.push(JSON.parse(event.data as string) as { type?: string });
				if (messages.length >= 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		socket.accept();
		socket.send(JSON.stringify({ type: "Ping" }));
		await gotSecond;
		socket.close(1000, "done");

		expect(messages[0]?.type).toBe("fantasy_update");
		expect(messages[1]?.type).toBe("workflow_update");
		expect(messages[1]?.type).not.toBe("pong");
		expect(messages[1]?.type).not.toBe("fantasy_update");
	});

	it("returns 400 Expected WebSocket for POST /api/fantasy/espn/sync/ trailing slash", async () => {
		const res = await fetchWorker(
			`/api/fantasy/espn/sync/?teamId=${uniqueId("espn-slash")}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leagueId: "12345678" }),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
