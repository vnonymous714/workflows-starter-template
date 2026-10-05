import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	extractTokenUsage,
	GrokRequestError,
	parseGrokVerdict,
	resolvePlayer,
} from "../src/grok-client";
import {
	buildEspnApiUrl,
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
} from "../src/sleeper-client";
import worker from "../worker/index";

function uniqueName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function stubFor(name: string) {
	const id = env.WORKFLOW_STATUS.idFromName(name);
	return env.WORKFLOW_STATUS.get(id);
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

function espnTeam(overrides: Record<string, unknown> = {}): EspnRawLeagueResponse {
	return {
		id: 1,
		seasonId: 2024,
		teams: [
			{
				id: 1,
				name: "Default One",
				roster: { entries: [] },
			},
			{
				id: 2,
				name: "Target Two",
				roster: { entries: [] },
			},
		],
		...overrides,
	} as EspnRawLeagueResponse;
}

describe("ESPN leftover identity, injury, and season coercions", () => {
	it("throws when members is a plain object instead of an array", () => {
		const raw = {
			id: 201,
			seasonId: 2024,
			members: { id: "owner-1", displayName: "Not Iterable" },
			teams: [
				{
					id: 1,
					name: "Object Members",
					primaryOwner: "owner-1",
					roster: { entries: [] },
				},
			],
		} as unknown as EspnRawLeagueResponse;

		expect(() => sanitizeEspnTeamRoster(raw)).toThrow(TypeError);
	});

	it("treats a string owners field as a character index, so the GUID never matches", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 202,
			seasonId: 2024,
			members: [
				{
					id: "{A8726312-3214-5432-B812-9876543210AB}",
					displayName: "Commissioner Dave",
				},
			],
			teams: [
				{
					id: 1,
					name: "String Owners",
					owners: "{A8726312-3214-5432-B812-9876543210AB}" as unknown as string[],
					roster: { entries: [] },
				},
			],
		});

		expect(roster.owner).toBe("ESPN Team Owner");
	});

	it("matches a numeric targetTeamId to the string team id", () => {
		const { roster } = sanitizeEspnTeamRoster(espnTeam(), 2);

		expect(roster.teamName).toBe("Target Two");
		expect(roster.teamId).toBe("espn_team_2");
	});

	it("maps unpadded lowercase out/doubtful/ir/injury_reserve after toUpperCase", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 203,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Lower Injury",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									appliedStatTotal: 12,
									player: {
										id: 1,
										fullName: "Out Back",
										defaultPositionId: 2,
										proTeamId: 14,
										injuryStatus: "out",
									},
								},
							},
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									appliedStatTotal: 11,
									player: {
										id: 2,
										fullName: "Doubtful Back",
										defaultPositionId: 2,
										proTeamId: 14,
										injuryStatus: "doubtful",
									},
								},
							},
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									appliedStatTotal: 4,
									player: {
										id: 3,
										fullName: "Short Ir",
										defaultPositionId: 2,
										proTeamId: 14,
										injuryStatus: "ir",
									},
								},
							},
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									appliedStatTotal: 3,
									player: {
										id: 4,
										fullName: "Reserve Back",
										defaultPositionId: 2,
										proTeamId: 14,
										injuryStatus: "injury_reserve",
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters.map((p) => [p.name, p.status])).toEqual([
			["Out Back", "OUT"],
			["Doubtful Back", "DOUBTFUL"],
		]);
		expect(roster.bench.map((p) => [p.name, p.status])).toEqual([
			["Short Ir", "IR"],
			["Reserve Back", "IR"],
		]);
	});

	it("treats numeric primaryOwner 0 as missing and uses owners[0]", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 204,
			seasonId: 2024,
			members: [
				{ id: "real-owner", displayName: "Real Owner" },
				{ id: "0", displayName: "Zero Owner" },
			],
			teams: [
				{
					id: 1,
					name: "Zero Primary",
					primaryOwner: 0 as unknown as string,
					owners: ["real-owner"],
					roster: { entries: [] },
				},
			],
		});

		expect(roster.owner).toBe("Real Owner");
	});

	it("does not format string ties \"0\" as W-L-T because \"0\" > 0 is false", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 205,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Zero Ties",
					record: {
						overall: {
							wins: 9,
							losses: 4,
							ties: "0" as unknown as number,
						},
					},
				},
			],
		});

		expect(roster.record).toBe("9-4");
	});

	it("maps proTeamId 33 to BAL and the unused 31 gap to NFL", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 206,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Pro Teams",
					roster: {
						entries: [
							{
								lineupSlotId: 16,
								playerPoolEntry: {
									appliedStatTotal: 8,
									player: {
										id: 33,
										fullName: "Baltimore Ravens",
										defaultPositionId: 16,
										proTeamId: 33,
									},
								},
							},
							{
								lineupSlotId: 16,
								playerPoolEntry: {
									appliedStatTotal: 7,
									player: {
										id: 31,
										fullName: "Gap Team",
										defaultPositionId: 16,
										proTeamId: 31,
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters[0]?.team).toBe("BAL");
		expect(roster.starters[1]?.team).toBe("NFL");
	});

	it("keeps a negative appliedStatTotal and does not tag High Floor", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 207,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Negative Proj",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									appliedStatTotal: -3.2,
									player: {
										id: 99,
										fullName: "Busted Back",
										defaultPositionId: 2,
										proTeamId: 14,
										injuryStatus: "ACTIVE",
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters[0]?.projPts).toBe(-3.2);
		expect(roster.starters[0]?.tags).toBeUndefined();
	});

	it("uses season 2024 when fetchEspnLeagueData is given season 0 (|| fallback)", async () => {
		expect(buildEspnApiUrl("2025abc", 99)).toContain("/2025abc/segments/0/leagues/99");

		let capturedUrl = "";
		await fetchEspnLeagueData({
			leagueId: "8888",
			season: 0,
			fetchImpl: async (input) => {
				capturedUrl = String(input);
				return new Response(JSON.stringify({ id: 8888, teams: [] }), {
					status: 200,
				});
			},
		});

		expect(capturedUrl).toContain("/2024/segments/0/leagues/8888");
		expect(capturedUrl).not.toContain("/0/segments");
	});
});

describe("Sleeper leftover identity coercions", () => {
	it("does not treat an already-prefixed p_BAL id as the known Ravens DST", () => {
		const player = mapSleeperPlayerIdToPlayer("p_BAL");

		expect(player).toMatchObject({
			id: "p_BAL",
			name: "Player #p_BAL",
			pos: "FLEX",
			team: "NFL",
			tags: ["Sleeper Import"],
		});
		expect(player.name).not.toBe("Baltimore Ravens");
	});

	it("treats query +2 as roster_id 2 via parseInt", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/7788990011")) {
				return Response.json({
					league_id: "7788990011",
					name: "Plus Two League",
				});
			}
			if (url.endsWith("/league/7788990011/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "user_a",
						starters: ["4984"],
						players: ["4984"],
					},
					{
						roster_id: 2,
						owner_id: "user_b",
						starters: ["8138"],
						players: ["8138"],
					},
				]);
			}
			if (url.endsWith("/league/7788990011/users")) {
				return Response.json([
					{ user_id: "user_a", display_name: "Alpha" },
					{ user_id: "user_b", display_name: "Bravo" },
				]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "7788990011", userOrRosterId: "+2" },
			fetchImpl,
		);

		expect(roster.teamId).toBe("sleeper_7788990011_2");
		expect(roster.owner).toContain("Bravo");
		expect(roster.starters[0]?.name).toBe("Kyren Williams");
	});

	it("keeps a truthy team_name of \"0\" instead of falling through to display_name", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/8899001122")) {
				return Response.json({
					league_id: "8899001122",
					name: "Zero Name League",
				});
			}
			if (url.endsWith("/league/8899001122/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "user_zero",
						starters: ["4984"],
						players: ["4984"],
					},
				]);
			}
			if (url.endsWith("/league/8899001122/users")) {
				return Response.json([
					{
						user_id: "user_zero",
						display_name: "Should Not Win",
						username: "zero_user",
						metadata: { team_name: "0" },
					},
				]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "8899001122" },
			fetchImpl,
		);

		expect(roster.teamName).toBe("0 (Zero Name League)");
		expect(roster.teamName).not.toContain("Should Not Win");
	});
});

describe("Grok leftover verdict and usage coercions", () => {
	it("rejects null, string, and array verdicts instead of inventing a start/sit", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() => parseGrokVerdict(null, kyren, charbonnet)).toThrow(
			GrokRequestError,
		);
		expect(() => parseGrokVerdict("SIT", kyren, charbonnet)).toThrow(
			/Grok verdict was empty/,
		);
		expect(() => parseGrokVerdict([], kyren, charbonnet)).toThrow(
			/missing act, delta, or conf/,
		);
	});

	it("treats null message content and a null choices[0] as missing content", async () => {
		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [{ message: { content: null } }],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_INVALID_RESPONSE",
			message: expect.stringContaining("missing message content"),
		});

		await expect(
			executeGrokDecision(buildCommandCenterState(), "p_kyren", "p_charbonnet", {
				apiKey: "test-xai-key",
				fetchImpl: async () =>
					Response.json({
						choices: [null],
						usage: { total_tokens: 10 },
					}),
			}),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_INVALID_RESPONSE",
			message: expect.stringContaining("missing message content"),
		});
	});

	it("empties a numeric rec.vs and keeps a numeric rec.src instead of defaulting grok", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						vs: 12,
						delta: -1,
						conf: 0.5,
						why: "Weather",
						src: 7,
						flags: ["WX"],
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs[0]?.vs).toBe("");
		expect(recs[0]?.src).toBe(7);
	});

	it("sums completion_tokens with input_tokens when prompt_tokens is omitted", () => {
		expect(
			extractTokenUsage({
				input_tokens: 80,
				completion_tokens: 12,
			}),
		).toBe(92);
	});
});

describe("swap and HTTP leftover contracts", () => {
	it("no-ops a swap when only the starter id exists", async () => {
		const stub = stubFor(uniqueName("one-sided-swap"));
		const before = await stub.getFantasyState();
		const starterNames = before.activeRoster.starters.map((p) => p.name);
		const alertCount = before.liveAlerts.length;

		const after = await stub.swapRoster("p_kyren", "p_missing_bench");

		expect(after.activeRoster.starters.map((p) => p.name)).toEqual(starterNames);
		expect(after.liveAlerts).toHaveLength(alertCount);
		expect(after.liveAlerts[0]?.type).not.toBe("LINEUP");
	});

	it("rejects HEAD /api/fantasy/state as 400 with an empty body (HEAD is not GET)", async () => {
		const response = await fetchWorker(
			`/api/fantasy/state?teamId=${uniqueName("head-state")}`,
			{ method: "HEAD" },
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("");
	});

	it("refreshes intel through POST /api/fantasy/intel/refresh (the UI path)", async () => {
		const teamId = uniqueName("intel-refresh");
		const response = await fetchWorker(
			`/api/fantasy/intel/refresh?teamId=${teamId}`,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		const state = (await response.json()) as {
			intelPacket: { fresh: boolean; hash: string };
			liveAlerts: Array<{ type: string }>;
		};
		expect(state.intelPacket.fresh).toBe(true);
		expect(state.intelPacket.hash).toMatch(/^intel_wk14_/);
		expect(state.liveAlerts[0]?.type).toBe("GROK");
	});
});
