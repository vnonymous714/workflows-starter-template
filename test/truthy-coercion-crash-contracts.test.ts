import {
	env,
	introspectWorkflowInstance,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	GrokRequestError,
} from "../src/grok-client";
import {
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnFetchOptions,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import { importSleeperRoster, SleeperApiError } from "../src/sleeper-client";
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

describe("ESPN leftover truthy-string, slot, and crash contracts", () => {
	it("maps bench defaultPositionId 4 to TE (leftover of WR/K/DST bench ids)", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 501,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Bench TE",
					roster: {
						entries: [
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									player: {
										id: 401,
										fullName: "Bench Tight End",
										defaultPositionId: 4,
										proTeamId: 21,
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.pos).toBe("TE");
		expect(roster.bench[0]?.team).toBe("PHI");
	});

	it("treats string lineupSlotId \"4\" as WR starter because slot map keys are strings", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 502,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "String Slot",
					roster: {
						entries: [
							{
								lineupSlotId: "4" as unknown as number,
								playerPoolEntry: {
									player: {
										id: 402,
										fullName: "String Slot WR",
										defaultPositionId: 2,
										proTeamId: 26,
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters).toHaveLength(1);
		expect(roster.starters[0]?.pos).toBe("WR");
		expect(roster.bench).toHaveLength(0);
	});

	it("maps string defaultPositionId \"4\" on the bench to TE", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 503,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "String Pos",
					roster: {
						entries: [
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									player: {
										id: 403,
										fullName: "String TE",
										defaultPositionId: "4" as unknown as number,
										proTeamId: 21,
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.bench[0]?.pos).toBe("TE");
	});

	it("falls through numeric scoringPeriodId 0 to currentPeriodId (0 is falsy; inverse of string \"0\")", () => {
		const { week } = sanitizeEspnTeamRoster({
			id: 504,
			seasonId: 2024,
			scoringPeriodId: 0,
			currentPeriodId: 9,
			status: { latestScoringPeriod: 11 },
			teams: [
				{
					id: 1,
					name: "Week Zero",
					roster: { entries: [] },
				},
			],
		});

		expect(week).toBe(9);
	});

	it("maps unused proTeamId 35 to NFL (leftover of 31-34)", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 505,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Gap 35",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									player: {
										id: 405,
										fullName: "Unknown Franchise",
										defaultPositionId: 2,
										proTeamId: 35,
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters[0]?.team).toBe("NFL");
	});

	it("throws TypeError when injuryStatus is a number (toUpperCase is not a function)", () => {
		const raw = {
			id: 506,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Numeric Injury",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									player: {
										id: 406,
										fullName: "Broken Status",
										defaultPositionId: 2,
										proTeamId: 14,
										injuryStatus: 1,
									},
								},
							},
						],
					},
				},
			],
		} as unknown as EspnRawLeagueResponse;

		expect(() => sanitizeEspnTeamRoster(raw)).toThrow(TypeError);
	});

	it("fetches season \"0\" as /0/ because a non-empty string is truthy (inverse of numeric 0 → 2024)", async () => {
		let capturedUrl = "";
		const fetchImpl: typeof fetch = async (input) => {
			capturedUrl = String(input);
			return Response.json({ id: 1, seasonId: 0, teams: [] });
		};

		await fetchEspnLeagueData({
			leagueId: "87654321",
			season: "0",
			fetchImpl,
		} as unknown as EspnFetchOptions);

		expect(capturedUrl).toContain("/seasons/0/segments/0/leagues/87654321");
		expect(capturedUrl).not.toContain("/seasons/2024/");
	});

	it("interpolates season \"2025abc\" into the ESPN URL (client path does not parseInt)", async () => {
		let capturedUrl = "";
		const fetchImpl: typeof fetch = async (input) => {
			capturedUrl = String(input);
			return Response.json({ id: 1, seasonId: 2025, teams: [] });
		};

		await fetchEspnLeagueData({
			leagueId: "87654321",
			season: "2025abc",
			fetchImpl,
		} as unknown as EspnFetchOptions);

		expect(capturedUrl).toContain("/seasons/2025abc/segments/0/leagues/87654321");
	});
});

describe("Sleeper leftover collection-shape contracts", () => {
	it("maps rosters: {} to 404 No rosters found, not TypeError (inverse of users: {})", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/shape-1")) {
				return Response.json({ league_id: "shape-1", name: "Object Rosters" });
			}
			if (url.endsWith("/league/shape-1/rosters")) {
				return Response.json({ roster_id: 1 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "shape-1" }, fetchImpl),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 404,
			message: "No rosters found in Sleeper league",
		});
		await expect(
			importSleeperRoster({ leagueId: "shape-1" }, fetchImpl),
		).rejects.toBeInstanceOf(SleeperApiError);
	});

	it("maps rosters: null to 404 instead of throwing TypeError (inverse of [null] rows)", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/shape-2")) {
				return Response.json({ league_id: "shape-2", name: "Null Rosters" });
			}
			if (url.endsWith("/league/shape-2/rosters")) {
				return Response.json(null);
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "shape-2" }, fetchImpl),
		).rejects.toMatchObject({
			status: 404,
			message: "No rosters found in Sleeper league",
		});
	});

	it("drops null starter ids instead of throwing (inverse of ESPN entries: [null])", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/shape-3")) {
				return Response.json({ league_id: "shape-3", name: "Null Starters" });
			}
			if (url.endsWith("/league/shape-3/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "u1",
						starters: [null, "4984"],
						players: [null, "4984"],
					},
				]);
			}
			if (url.endsWith("/league/shape-3/users")) {
				return Response.json([
					{ user_id: "u1", display_name: "Null Slot Manager" },
				]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "shape-3", userOrRosterId: "u1" },
			fetchImpl,
		);

		expect(roster.starters).toHaveLength(1);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[0]?.pos).toBe("QB");
		expect(roster.bench).toHaveLength(0);
	});

	it("treats league JSON {} as Sleeper League instead of throwing (inverse of JSON null)", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/shape-4")) {
				return Response.json({});
			}
			if (url.endsWith("/league/shape-4/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "u1",
						starters: ["4984"],
						players: ["4984"],
					},
				]);
			}
			if (url.endsWith("/league/shape-4/users")) {
				return Response.json([
					{ user_id: "u1", display_name: "Empty League Manager" },
				]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "shape-4", userOrRosterId: "u1" },
			fetchImpl,
		);

		expect(roster.teamName).toContain("Sleeper League");
		expect(roster.owner).toContain("Empty League Manager");
	});
});

describe("Grok leftover falsy content contracts", () => {
	it("treats numeric content 0 as missing message content, not TypeError", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: async () =>
						Response.json({
							model: "grok-4",
							choices: [{ message: { content: 0 } }],
							usage: MOCK_USAGE,
						}),
				},
			),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_INVALID_RESPONSE",
			message: "xAI response was missing message content.",
		});
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: async () =>
						Response.json({
							model: "grok-4",
							choices: [{ message: { content: 0 } }],
							usage: MOCK_USAGE,
						}),
				},
			),
		).rejects.toBeInstanceOf(GrokRequestError);
	});

	it("treats boolean content false as missing message content (if (!content))", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: async () =>
						Response.json({
							model: "grok-4",
							choices: [{ message: { content: false } }],
							usage: MOCK_USAGE,
						}),
				},
			),
		).rejects.toMatchObject({
			code: "XAI_INVALID_RESPONSE",
			message: "xAI response was missing message content.",
		});
	});
});

describe("Worker leftover method and Upgrade contracts", () => {
	it("rejects Upgrade: WEBSOCKET and Websocket (only lowercase websocket upgrades)", async () => {
		const allCaps = await fetchWorker("/ws?instanceId=demo", {
			headers: { Upgrade: "WEBSOCKET" },
		});
		expect(allCaps.status).toBe(426);
		expect(await allCaps.text()).toBe("Expected Upgrade: websocket");

		const mixed = await fetchWorker("/ws?instanceId=demo", {
			headers: { Upgrade: "Websocket" },
		});
		expect(mixed.status).toBe(426);
		expect(await mixed.text()).toBe("Expected Upgrade: websocket");
	});

	it("serves workflow status on POST because the route does not check method", async () => {
		const instanceId = uniqueId("status-post");
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

		const response = await fetchWorker(`/api/workflow/status/${instanceId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ unexpected: true }),
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string };
		expect(body.status).toEqual(expect.any(String));
		await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
	});
});
