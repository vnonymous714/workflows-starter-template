import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	executeGrokDecision,
	GrokRequestError,
	parseGrokVerdict,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import { importSleeperRoster } from "../src/sleeper-client";
import type { FantasyPlayer } from "../src/types/fantasy";
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

function entry(
	lineupSlotId: number,
	player: {
		id: number;
		fullName: string;
		defaultPositionId: number;
		proTeamId: number;
	},
): EspnRawLeagueResponse["teams"][number]["roster"] {
	return {
		entries: [
			{
				lineupSlotId,
				playerPoolEntry: { player },
			},
		],
	};
}

function leagueWithEntries(
	id: number,
	entries: NonNullable<
		NonNullable<EspnRawLeagueResponse["teams"]>[number]["roster"]
	>["entries"],
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
	};
}

const AMON_RA: FantasyPlayer = {
	id: "p_amonra",
	name: "Amon-Ra St. Brown",
	pos: "WR",
	team: "DET",
	opp: "vs GB",
	projPts: 16.4,
	status: "ACTIVE",
};

describe("ESPN leftover string slots, pro-team tails, and falsy season", () => {
	it("treats string lineupSlotId \"0\" as QB starter (inverse of padded \"02\" unknown bench)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(601, [
				{
					lineupSlotId: "0" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 6010,
							fullName: "String Slot QB",
							defaultPositionId: 2,
							proTeamId: 2,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(1);
		expect(roster.starters[0]?.pos).toBe("QB");
		expect(roster.bench).toHaveLength(0);
	});

	it("maps leftover string slot ids 16/17/23 to DST/K/FLEX starters", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(602, [
				{
					lineupSlotId: "16" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 6021,
							fullName: "String DST",
							defaultPositionId: 2,
							proTeamId: 33,
						},
					},
				},
				{
					lineupSlotId: "17" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 6022,
							fullName: "String K",
							defaultPositionId: 2,
							proTeamId: 6,
						},
					},
				},
				{
					lineupSlotId: "23" as unknown as number,
					playerPoolEntry: {
						player: {
							id: 6023,
							fullName: "String FLEX",
							defaultPositionId: 2,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => p.pos)).toEqual(["DST", "K", "FLEX"]);
		expect(roster.bench).toHaveLength(0);
	});

	it("maps string defaultPositionId \"1\" on the bench to QB (leftover of string \"4\" TE)", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 603,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "String QB Bench",
					roster: entry(20, {
						id: 6031,
						fullName: "String Bench QB",
						defaultPositionId: "1" as unknown as number,
						proTeamId: 2,
					}),
				},
			],
		});

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench[0]?.pos).toBe("QB");
	});

	it("maps unmapped proTeamId 36 and 0 to NFL (leftover of 31–35)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(604, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 6041,
							fullName: "Unmapped 36",
							defaultPositionId: 2,
							proTeamId: 36,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 6042,
							fullName: "Unmapped 0",
							defaultPositionId: 2,
							proTeamId: 0,
						},
					},
				},
			]),
		);

		expect(roster.bench.map((p) => p.team)).toEqual(["NFL", "NFL"]);
	});

	it("uses season 2024 when fetchEspnLeagueData season is null (inverse of string \"0\")", async () => {
		let capturedUrl = "";
		const mockFetch: typeof fetch = async (input) => {
			capturedUrl = String(input);
			return Response.json({
				id: 1,
				seasonId: 2024,
				teams: [],
			});
		};

		await fetchEspnLeagueData({
			leagueId: "999",
			season: null as unknown as number,
			fetchImpl: mockFetch,
		});

		expect(capturedUrl).toContain("/seasons/2024/");
		expect(capturedUrl).not.toContain("/seasons/null/");
		expect(capturedUrl).not.toContain("/seasons/0/");
	});
});

describe("Sleeper leftover slot overflow, partial roster, and DST heuristic", () => {
	const league = {
		league_id: "overflow-league",
		name: "Overflow League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/overflow-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/overflow-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/overflow-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("assigns the 10th starter FLEX while keeping known-player metadata", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "overflow-league" },
			sleeperFetch([
				{
					roster_id: 1,
					owner_id: "user_101",
					starters: [
						"4984",
						"8183",
						"8138",
						"7564",
						"7553",
						"4035",
						"9221",
						"11439",
						"BAL",
						"8139",
					],
					players: [
						"4984",
						"8183",
						"8138",
						"7564",
						"7553",
						"4035",
						"9221",
						"11439",
						"BAL",
						"8139",
					],
				},
			]),
		);

		expect(roster.starters).toHaveLength(10);
		expect(roster.starters[8]?.name).toBe("Baltimore Ravens");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[9]?.name).toBe("Kenneth Walker III");
		expect(roster.starters[9]?.pos).toBe("FLEX");
		expect(roster.starters[9]?.team).toBe("SEA");
		expect(roster.starters[9]?.tags).toContain("Explosive Playmaker");
	});

	it("builds starters when players is null and leaves the bench empty", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "overflow-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "8183"],
					players: null,
				},
			]),
		);

		expect(roster.starters.map((p) => p.name)).toEqual([
			"Josh Allen",
			"Bijan Robinson",
		]);
		expect(roster.bench).toEqual([]);
	});

	it("treats lowercase bal as FLEX Player #bal, not the known Ravens DST", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "overflow-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "bal"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.id).toBe("p_bal");
		expect(roster.bench[0]?.name).toBe("Player #bal");
		expect(roster.bench[0]?.pos).toBe("FLEX");
		expect(roster.bench[0]?.team).toBe("NFL");
		expect(roster.bench[0]?.name).not.toBe("Baltimore Ravens");
		expect(roster.bench[0]?.name).not.toBe("bal Defense");
	});

	it("matches an exact Sleeper user_id (distinct from username lookup)", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "overflow-league", userOrRosterId: "user_102" },
			sleeperFetch(
				[
					{
						roster_id: 1,
						owner_id: "user_101",
						starters: ["4984"],
						players: ["4984"],
					},
					{
						roster_id: 2,
						owner_id: "user_102",
						starters: ["8138"],
						players: ["8138"],
					},
				],
				[
					{
						user_id: "user_101",
						username: "gridiron_king",
						display_name: "Gridiron King",
					},
					{
						user_id: "user_102",
						username: "rival_boss",
						display_name: "Rival Boss",
					},
				],
			),
		);

		expect(roster.teamId).toBe("sleeper_overflow-league_2");
		expect(roster.starters[0]?.name).toBe("Kyren Williams");
		expect(roster.owner).toContain("Rival Boss");
	});
});

describe("Grok leftover inverses, greedy JSON, NaN recs, and token match", () => {
	it("inverts TRADE_Y and TRADE_N compact verdicts to HOLD", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const tradeYes = parseGrokVerdict(
			{
				act: "TRADE_Y",
				delta: 1.5,
				conf: 0.7,
				why: "Smash the offer",
				flags: [],
			},
			kyren,
			charbonnet,
		);
		expect(tradeYes[0]?.act).toBe("TRADE_Y");
		expect(tradeYes[1]?.act).toBe("HOLD");
		expect(tradeYes[1]?.delta).toBe(-1.5);

		const tradeNo = parseGrokVerdict(
			{
				act: "TRADE_N",
				delta: -2,
				conf: 0.6,
				why: "Keep the backfield",
				flags: [],
			},
			kyren,
			charbonnet,
		);
		expect(tradeNo[0]?.act).toBe("TRADE_N");
		expect(tradeNo[1]?.act).toBe("HOLD");
		expect(tradeNo[1]?.delta).toBe(2);
	});

	it("accepts recs[].delta \"abc\" as NaN instead of throwing missing fields", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						delta: "abc",
						conf: 0.5,
						why: "non numeric delta",
						flags: [],
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(Number.isNaN(recs[0]?.delta)).toBe(true);
	});

	it("fails greedy JSON extract when two sibling objects are in the xAI content", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						model: "grok-4",
						choices: [
							{
								message: {
									content:
										'{"act":"SIT","delta":-1,"conf":0.5,"why":"first blob","flags":[]} {"act":"START","delta":1,"conf":0.9,"why":"second blob","flags":[]}',
								},
							},
						],
						usage: MOCK_USAGE,
					}),
			}),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_INVALID_RESPONSE",
			message: "Grok JSON verdict could not be parsed.",
		} satisfies Partial<GrokRequestError>);
	});

	it("matches rec id St. as a middle name token but not partial Amon on Amon-Ra", () => {
		const recSt = {
			id: "St.",
			act: "START" as const,
			vs: "Waddle",
			delta: 1,
			conf: 0.8,
			why: "slot work",
			src: "grok",
			flags: [],
		};
		const recAmon = { ...recSt, id: "Amon" };
		const recHyphen = { ...recSt, id: "Amon-Ra" };

		expect(recommendationMatchesPlayer(recSt, AMON_RA)).toBe(true);
		expect(recommendationMatchesPlayer(recAmon, AMON_RA)).toBe(false);
		expect(recommendationMatchesPlayer(recHyphen, AMON_RA)).toBe(true);
	});

	it("includes team-level beat reports that omit playerId when the team matches", () => {
		const state = structuredClone(buildCommandCenterState());
		state.intelPacket.beatReports.push({
			id: "beat_team_only",
			handle: "@NFLResearch",
			authorName: "NFL Research",
			timestamp: "5m ago",
			claim: "Rams installing extra 12 personnel for Buffalo weather.",
			team: "LAR",
			confidence: 0.6,
			impactLevel: "MEDIUM",
		});

		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;
		const packet = buildCsspPacket(state, kyren, charbonnet, false);

		expect(packet).toContain("BEAT @NFLResearch:");
		expect(packet).toContain("extra 12 personnel");
	});
});

describe("DO leftover swap direction and import/decide HTTP contracts", () => {
	it("treats reversed swap ids as a silent 200 no-op with no LINEUP alert", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueId("swap-reversed")),
		);
		const before = await stub.getFantasyState();
		const starterIds = before.activeRoster.starters.map((p) => p.id);
		const alertCount = before.liveAlerts.length;

		const after = await stub.swapRoster("p_charbonnet", "p_kyren");

		expect(after.activeRoster.starters.map((p) => p.id)).toEqual(starterIds);
		expect(after.liveAlerts).toHaveLength(alertCount);
		expect(after.liveAlerts[0]?.message).not.toContain(
			"Started Kyren Williams over Zach Charbonnet",
		);
	});

	it("lets malformed /decide JSON throw outside grokErrorResponse", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueId("decide-bad-json")),
		);

		await expect(
			stub.fetch("https://do/decide", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{not-json",
			}),
		).rejects.toThrow();
	});

	it("returns 400 JSON when Sleeper import body omits leagueId", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueId("sleeper-empty-body")),
		);

		const res = await stub.fetch("https://do/roster/sleeper-import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toEqual({
			error: "Sleeper leagueId is required",
		});
	});

	it("maps malformed Sleeper import JSON to 500 JSON (caught; inverse of /decide throw)", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueId("sleeper-bad-json")),
		);

		const res = await stub.fetch("https://do/roster/sleeper-import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/JSON|json|Unexpected|parse/i);
	});

	it("proxies empty Sleeper import through the worker as 400 leagueId required", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/sleeper-import?teamId=${uniqueId("worker-sleeper-empty")}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			},
		);

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toEqual({
			error: "Sleeper leagueId is required",
		});
	});
});
