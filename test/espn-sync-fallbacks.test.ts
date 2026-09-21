import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
	type EspnRawPlayerEntry,
	type EspnRawTeam,
} from "../src/espn-client";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function playerEntry(
	overrides: {
		lineupSlotId: number;
		id: number;
		fullName: string;
		defaultPositionId?: number;
		proTeamId?: number;
		injuryStatus?: string;
		appliedStatTotal?: number | null;
	},
): EspnRawPlayerEntry {
	return {
		lineupSlotId: overrides.lineupSlotId,
		playerPoolEntry: {
			appliedStatTotal: overrides.appliedStatTotal as number | undefined,
			player: {
				id: overrides.id,
				fullName: overrides.fullName,
				defaultPositionId: overrides.defaultPositionId ?? 2,
				proTeamId: overrides.proTeamId ?? 2,
				injuryStatus: overrides.injuryStatus,
			},
		},
	};
}

function league(
	overrides: Partial<EspnRawLeagueResponse> & { teams?: EspnRawTeam[] } = {},
): EspnRawLeagueResponse {
	return {
		id: 12345678,
		seasonId: 2024,
		scoringPeriodId: 14,
		members: [{ id: "{OWNER-1}", displayName: "Commissioner Dave" }],
		...overrides,
		teams: overrides.teams ?? [
			{
				id: 1,
				location: "Gridiron",
				nickname: "Dynasty",
				primaryOwner: "{OWNER-1}",
				record: { overall: { wins: 10, losses: 3, ties: 0 } },
				roster: {
					entries: [
						playerEntry({
							lineupSlotId: 0,
							id: 1,
							fullName: "Josh Allen",
							defaultPositionId: 1,
							appliedStatTotal: 24.5,
						}),
					],
				},
			},
		],
	};
}

const TWO_TEAM_LEAGUE = league({
	teams: [
		{
			id: 1,
			name: "Alpha Club",
			primaryOwner: "{OWNER-1}",
			roster: {
				entries: [
					playerEntry({
						lineupSlotId: 0,
						id: 11,
						fullName: "Alpha QB",
						defaultPositionId: 1,
					}),
				],
			},
		},
		{
			id: 2,
			name: "Beta Club",
			primaryOwner: "{OWNER-2}",
			roster: {
				entries: [
					playerEntry({
						lineupSlotId: 2,
						id: 22,
						fullName: "Beta RB",
						defaultPositionId: 2,
					}),
				],
			},
		},
	],
	members: [
		{ id: "{OWNER-1}", displayName: "Alpha Owner" },
		{ id: "{OWNER-2}", displayName: "Beta Owner" },
	],
});

function espnFetch(body: unknown, status = 200): typeof fetch {
	return async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("ESPN fetch credential and header fallbacks", () => {
	it("omits Cookie when both cookies are missing and always sends Accept", async () => {
		let captured: Headers | undefined;
		await fetchEspnLeagueData({
			leagueId: "99",
			fetchImpl: async (_input, init) => {
				captured = new Headers(init?.headers);
				return espnFetch({ id: 1, teams: [] })();
			},
		});

		expect(captured?.get("Accept")).toBe("application/json");
		expect(captured?.has("Cookie")).toBe(false);
	});

	it("does not treat whitespace-only leagueId as missing credentials", async () => {
		let called = false;
		let capturedUrl = "";
		await expect(
			fetchEspnLeagueData({
				leagueId: "   ",
				fetchImpl: async (input) => {
					called = true;
					capturedUrl = String(input);
					return espnFetch("missing", 404)();
				},
			}),
		).rejects.toMatchObject({
			code: "ESPN_REQUEST_FAILED",
			status: 404,
		});
		expect(called).toBe(true);
		expect(capturedUrl).toContain("/leagues/");
		expect(capturedUrl).not.toContain("/leagues/?");
	});
});

describe("sanitizeEspnTeamRoster identity and scoring fallbacks", () => {
	it("treats empty-string targetTeamId as omitted and prefers primaryOwner over owners[0]", () => {
		const emptyTarget = sanitizeEspnTeamRoster(TWO_TEAM_LEAGUE, "");
		expect(emptyTarget.roster.teamId).toBe("espn_team_1");
		expect(emptyTarget.roster.teamName).toBe("Alpha Club");

		const primaryWins = sanitizeEspnTeamRoster(
			league({
				members: [
					{ id: "{OWNER-1}", displayName: "Primary Pat" },
					{ id: "{OWNER-2}", displayName: "Secondary Sam" },
				],
				teams: [
					{
						id: 4,
						name: "Split Ownership",
						primaryOwner: "{OWNER-1}",
						owners: ["{OWNER-2}"],
					},
				],
			}),
		);
		expect(primaryWins.roster.owner).toBe("Primary Pat");
	});

	it("does not compose nickname-only names and keeps ESPN Team Owner when members are omitted", () => {
		const nicknameOnly = sanitizeEspnTeamRoster(
			league({
				teams: [{ id: 12, nickname: "Nomads" }],
			}),
		);
		expect(nicknameOnly.roster.teamName).toBe("ESPN Team 12");

		const noMembers = sanitizeEspnTeamRoster(
			league({
				members: undefined,
				teams: [
					{
						id: 5,
						name: "Orphaned",
						primaryOwner: "{OWNER-1}",
					},
				],
			}),
		);
		expect(noMembers.roster.owner).toBe("ESPN Team Owner");
	});

	it("uses currentPeriodId, maps injuryStatus IR, keeps projPts 0, and honors TE starter slots", () => {
		const { roster, week } = sanitizeEspnTeamRoster(
			league({
				scoringPeriodId: undefined,
				currentPeriodId: 9,
				status: { latestScoringPeriod: 14, currentMatchupPeriod: 8 },
				teams: [
					{
						id: 1,
						name: "Edges",
						roster: {
							entries: [
								playerEntry({
									lineupSlotId: 6,
									id: 201,
									fullName: "Slot TE",
									defaultPositionId: 3,
									appliedStatTotal: 0,
								}),
								playerEntry({
									lineupSlotId: 4,
									id: 202,
									fullName: "IR Wideout",
									defaultPositionId: 3,
									injuryStatus: "ir",
									appliedStatTotal: 11.1,
								}),
								playerEntry({
									lineupSlotId: 20,
									id: 203,
									fullName: "Null Proj",
									appliedStatTotal: null,
								}),
							],
						},
					},
				],
			}),
		);

		expect(week).toBe(9);

		const te = roster.starters.find((p) => p.name === "Slot TE");
		expect(te?.pos).toBe("TE");
		expect(te?.projPts).toBe(0);
		expect(te?.tags).toBeUndefined();

		const ir = roster.starters.find((p) => p.name === "IR Wideout");
		expect(ir?.status).toBe("IR");
		expect(ir?.injuryDesc).toContain("ir");
		expect(ir?.tags).toEqual(["IR"]);

		const bench = roster.bench.find((p) => p.name === "Null Proj");
		expect(bench?.projPts).toBe(10);
	});
});

describe("ESPN Durable Object credential precedence and HTTP contracts", () => {
	it("prefers body cookies, then ESPN_S2/SWID, then alternate env names; season 0 falls back to 2024", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-prec-${crypto.randomUUID()}`),
		);

		let capturedCookie = "";
		let capturedUrl = "";
		const first = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				instance.env.ESPN_S2 = "canonical_s2";
				instance.env.Espn_s2 = "alt_s2";
				instance.env.SWID = "{CANON}";
				instance.env.Swid = "{ALT}";
				return instance.syncEspnRoster(
					{ leagueId: "321", season: 0 },
					async (input, init) => {
						capturedUrl = String(input);
						capturedCookie = new Headers(init?.headers).get("Cookie") ?? "";
						return espnFetch(TWO_TEAM_LEAGUE)();
					},
				);
			},
		);
		expect(capturedCookie).toBe("espn_s2=canonical_s2; SWID={CANON}");
		expect(capturedUrl).toContain("/seasons/2024/");
		expect(first.espnSyncMeta?.season).toBe(2024);

		capturedCookie = "";
		capturedUrl = "";
		const second = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{
						leagueId: "321",
						season: 2025,
						espnS2: "body_s2",
						swid: "{BODY}",
					},
					async (input, init) => {
						capturedUrl = String(input);
						capturedCookie = new Headers(init?.headers).get("Cookie") ?? "";
						return espnFetch(TWO_TEAM_LEAGUE)();
					},
				),
		);
		expect(capturedCookie).toBe("espn_s2=body_s2; SWID={BODY}");
		expect(capturedUrl).toContain("/seasons/2025/");
		expect(second.espnSyncMeta?.season).toBe(2025);
		expect(second.liveAlerts[0]?.type).toBe("ESPN");
		expect(second.liveAlerts.filter((a) => a.type === "ESPN").length).toBe(2);
	});

	it("rejects GET /espn/sync and uses env ESPN_LEAGUE_ID when the POST body is empty", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-empty-${crypto.randomUUID()}`),
		);

		const getRes = await stub.fetch("https://do/espn/sync");
		expect(getRes.status).toBe(400);
		expect(await getRes.text()).toBe("Expected WebSocket");

		const emptyWithoutEnv = await stub.fetch("https://do/espn/sync", {
			method: "POST",
		});
		expect(emptyWithoutEnv.status).toBe(400);
		await expect(emptyWithoutEnv.json()).resolves.toMatchObject({
			code: "ESPN_CREDENTIALS_MISSING",
		});

		const originalFetch = globalThis.fetch;
		try {
			await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
				instance.env.ESPN_LEAGUE_ID = "777";
			});
			globalThis.fetch = espnFetch(TWO_TEAM_LEAGUE);
			const emptyWithEnv = await stub.fetch("https://do/espn/sync", {
				method: "POST",
			});
			expect(emptyWithEnv.status).toBe(200);
			const body = (await emptyWithEnv.json()) as {
				espnSyncMeta?: { leagueId: string };
				activeRoster: { teamName: string };
			};
			expect(body.espnSyncMeta?.leagueId).toBe("777");
			expect(body.activeRoster.teamName).toBe("Alpha Club");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("routes omitted teamId through default_team and accepts a numeric leagueId in JSON", async () => {
		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = espnFetch(TWO_TEAM_LEAGUE);
			const http = await fetchWorker("/api/fantasy/espn/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leagueId: 12345678,
					teamId: "2",
					espnS2: "s2",
					swid: "{S}",
				}),
			});
			expect(http.status).toBe(200);
			const body = (await http.json()) as {
				activeRoster: { teamName: string };
				espnSyncMeta?: { leagueId: string };
			};
			expect(body.activeRoster.teamName).toBe("Beta Club");
			expect(body.espnSyncMeta?.leagueId).toBe("12345678");

			const defaultStub = env.WORKFLOW_STATUS.get(
				env.WORKFLOW_STATUS.idFromName("default_team"),
			);
			const persisted = await defaultStub.getFantasyState();
			expect(persisted.activeRoster.teamName).toBe("Beta Club");
			expect(persisted.espnSyncMeta?.leagueId).toBe("12345678");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
