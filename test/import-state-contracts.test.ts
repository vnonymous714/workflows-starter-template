import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
	type EspnRawPlayerEntry,
	type EspnRawTeam,
} from "../src/espn-client";
import type { WorkflowStatusDO } from "../worker/durable-object";

function playerEntry(overrides: {
	lineupSlotId: number;
	id: number;
	fullName: string;
	defaultPositionId?: number;
	proTeamId?: number;
	injuryStatus?: string;
	appliedStatTotal?: number;
}): EspnRawPlayerEntry {
	return {
		lineupSlotId: overrides.lineupSlotId,
		playerPoolEntry: {
			appliedStatTotal: overrides.appliedStatTotal,
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

const WEEK_NINE_LEAGUE = league({
	scoringPeriodId: 9,
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
	],
});

const SLEEPER_LEAGUE_ID = "1122334455";

const mockSleeperLeague = {
	league_id: SLEEPER_LEAGUE_ID,
	name: "Champions League",
};

const mockSleeperRosters = [
	{
		roster_id: 1,
		owner_id: "user_101",
		starters: ["4984"],
		players: ["4984", "9221"],
		settings: { wins: 8, losses: 5, ties: 0 },
	},
];

const mockSleeperUsers = [
	{
		user_id: "user_101",
		username: "gridiron_king",
		display_name: "Gridiron King",
		metadata: { team_name: "Apex Predators" },
	},
];

function sleeperFetch(): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}`)) {
			return Response.json(mockSleeperLeague);
		}
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}/rosters`)) {
			return Response.json(mockSleeperRosters);
		}
		if (url.endsWith(`/league/${SLEEPER_LEAGUE_ID}/users`)) {
			return Response.json(mockSleeperUsers);
		}
		return new Response("Not found", { status: 404 });
	};
}

function espnFetch(body: unknown): typeof fetch {
	return async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
}

describe("sanitizeEspnTeamRoster identity leftovers", () => {
	it("treats empty-string team name as missing and composes location + nickname", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 3,
						name: "",
						location: "Lake",
						nickname: "Monsters",
					},
				],
			}),
		);
		expect(roster.teamName).toBe("Lake Monsters");
	});

	it("builds owner from firstName-only or lastName-only when displayName is empty", () => {
		const firstOnly = sanitizeEspnTeamRoster(
			league({
				members: [
					{
						id: "{OWNER-1}",
						displayName: "",
						firstName: "Pat",
					},
				],
			}),
		);
		expect(firstOnly.roster.owner).toBe("Pat");

		const lastOnly = sanitizeEspnTeamRoster(
			league({
				members: [
					{
						id: "{OWNER-1}",
						displayName: "",
						lastName: "Mahomes",
					},
				],
			}),
		);
		expect(lastOnly.roster.owner).toBe("Mahomes");
	});

	it("keeps ESPN Team Owner when owners is an empty array and primaryOwner is omitted", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 6,
						name: "Orphaned",
						owners: [],
					},
				],
			}),
		);
		expect(roster.owner).toBe("ESPN Team Owner");
	});

	it("leaves unknown or whitespace injury statuses as ACTIVE with no injury tags", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 1,
						name: "Statuses",
						roster: {
							entries: [
								playerEntry({
									lineupSlotId: 2,
									id: 301,
									fullName: "Suspended Back",
									injuryStatus: "SUSPENDED",
									appliedStatTotal: 12,
								}),
								playerEntry({
									lineupSlotId: 4,
									id: 302,
									fullName: "PUP Wideout",
									injuryStatus: "PUP",
									appliedStatTotal: 11,
								}),
								playerEntry({
									lineupSlotId: 20,
									id: 303,
									fullName: "Padded Status",
									injuryStatus: "   ",
									appliedStatTotal: 9,
								}),
							],
						},
					},
				],
			}),
		);

		for (const name of ["Suspended Back", "PUP Wideout", "Padded Status"]) {
			const player =
				roster.starters.find((p) => p.name === name) ??
				roster.bench.find((p) => p.name === name);
			expect(player?.status).toBe("ACTIVE");
			expect(player?.tags).toBeUndefined();
			expect(player?.injuryDesc).toBeUndefined();
		}
	});
});

describe("ESPN / Sleeper Durable Object import contracts", () => {
	it("records ESPN savings from max(rawBytes/4, sanitized*5) and replaces a Roster token metric", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-savings-${crypto.randomUUID()}`),
		);
		const rawJson = WEEK_NINE_LEAGUE;
		const rawText = JSON.stringify(rawJson);
		const rawBytes = new TextEncoder().encode(rawText).length;
		const { sanitizedTokensEstimate } = sanitizeEspnTeamRoster(rawJson);
		const legacyTokens = Math.max(
			Math.round(rawBytes / 4),
			sanitizedTokensEstimate * 5,
		);
		const savingsPercent = Math.round(
			((legacyTokens - sanitizedTokensEstimate) / legacyTokens) * 100,
		);

		const updated = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				const state = await instance.getFantasyState();
				state.tokenMetrics.unshift({
					queryType: "Legacy Roster Dump",
					legacyTokens: 9999,
					optimizedTokens: 1,
					savingsPercent: 99,
					latencyReductionMs: 1,
				});
				return instance.syncEspnRoster(
					{ leagueId: "12345678", espnS2: "s2", swid: "{S}" },
					espnFetch(rawJson),
				);
			},
		);

		expect(updated.espnSyncMeta).toMatchObject({
			leagueId: "12345678",
			rawBytes,
			sanitizedTokens: sanitizedTokensEstimate,
			savingsPercent,
		});
		expect(
			updated.tokenMetrics.filter((m) => m.queryType.includes("Roster")),
		).toHaveLength(1);
		expect(updated.tokenMetrics[0]).toMatchObject({
			queryType: "ESPN League Roster Sync & Ingestion",
			legacyTokens,
			optimizedTokens: sanitizedTokensEstimate,
			savingsPercent,
		});
		expect(updated.liveAlerts[0]?.message).toContain("12345678");
		expect(updated.liveAlerts[0]?.message).toContain(
			`${updated.activeRoster.starters.length} starters`,
		);
	});

	it("updates week on ESPN sync but keeps prior Grok recommendations", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-keep-recs-${crypto.randomUUID()}`),
		);

		const before = await stub.getFantasyState();
		expect(before.selectedWeek).toBe(14);
		expect(before.recommendations.some((r) => r.id === "Kyren")).toBe(true);
		const recCount = before.recommendations.length;

		const after = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{ leagueId: "12345678" },
					espnFetch(WEEK_NINE_LEAGUE),
				),
		);

		expect(after.selectedWeek).toBe(9);
		expect(after.activeRoster.teamName).toBe("Alpha Club");
		expect(after.recommendations).toHaveLength(recCount);
		expect(after.recommendations.some((r) => r.id === "Kyren")).toBe(true);
		expect(after.lastDecision).toBeNull();
	});

	it("keeps week, Grok recs, and ESPN sync meta after a Sleeper import", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`sleeper-keep-${crypto.randomUUID()}`),
		);

		await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{ leagueId: "12345678" },
					espnFetch(WEEK_NINE_LEAGUE),
				),
		);

		const afterSleeper = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.importSleeper(
					SLEEPER_LEAGUE_ID,
					"gridiron_king",
					sleeperFetch(),
				),
		);

		expect(afterSleeper.activeRoster.teamName).toContain("Apex Predators");
		expect(afterSleeper.selectedWeek).toBe(9);
		expect(afterSleeper.espnSyncMeta?.leagueId).toBe("12345678");
		expect(afterSleeper.recommendations.some((r) => r.id === "Kyren")).toBe(
			true,
		);
		expect(afterSleeper.liveAlerts[0]?.type).toBe("LINEUP");
		expect(afterSleeper.liveAlerts[0]?.message).toContain(
			"Sleeper Roster Imported",
		);
	});
});
