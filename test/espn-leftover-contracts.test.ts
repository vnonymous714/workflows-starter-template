import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
	type EspnRawPlayerEntry,
	type EspnRawTeam,
} from "../src/espn-client";
import type { CommandCenterState } from "../src/types/fantasy";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

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

describe("sanitizeEspnTeamRoster leftover identity contracts", () => {
	it("keeps a whitespace-only official name instead of composing location + nickname", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 3,
						name: "   ",
						location: "Lake",
						nickname: "Monsters",
					},
				],
			}),
		);
		expect(roster.teamName).toBe("   ");
	});

	it("keeps a whitespace-only displayName instead of falling through to first/last", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				members: [
					{
						id: "{OWNER-1}",
						displayName: "   ",
						firstName: "Pat",
						lastName: "Mahomes",
					},
				],
			}),
		);
		expect(roster.owner).toBe("   ");
	});

	it("stays ESPN Team Owner when members is empty or the owner id is unmatched", () => {
		const emptyMembers = sanitizeEspnTeamRoster(
			league({
				members: [],
				teams: [
					{
						id: 5,
						name: "Orphaned",
						primaryOwner: "{OWNER-1}",
					},
				],
			}),
		);
		expect(emptyMembers.roster.owner).toBe("ESPN Team Owner");

		const unmatched = sanitizeEspnTeamRoster(
			league({
				members: [{ id: "{OTHER}", displayName: "Someone Else" }],
				teams: [
					{
						id: 6,
						name: "Unmatched",
						primaryOwner: "{OWNER-1}",
					},
				],
			}),
		);
		expect(unmatched.roster.owner).toBe("ESPN Team Owner");
	});

	it("does not use a lone location or nickname when the official name is empty", () => {
		const locationOnly = sanitizeEspnTeamRoster(
			league({
				teams: [{ id: 8, name: "", location: "Orphans" }],
			}),
		);
		expect(locationOnly.roster.teamName).toBe("ESPN Team 8");

		const nicknameOnly = sanitizeEspnTeamRoster(
			league({
				teams: [{ id: 9, name: "", nickname: "Nomads" }],
			}),
		);
		expect(nicknameOnly.roster.teamName).toBe("ESPN Team 9");
	});

	it("treats an empty-string primaryOwner as missing and uses owners[0]", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				members: [
					{ id: "{OWNER-1}", displayName: "Primary Pat" },
					{ id: "{OWNER-2}", displayName: "Secondary Sam" },
				],
				teams: [
					{
						id: 4,
						name: "Fallback Ownership",
						primaryOwner: "",
						owners: ["{OWNER-2}"],
					},
				],
			}),
		);
		expect(roster.owner).toBe("Secondary Sam");
	});
});

describe("sanitizeEspnTeamRoster leftover week, rank, and player contracts", () => {
	it("ignores currentMatchupPeriod and treats all-zero period fields as week 14", () => {
		const matchupOnly = sanitizeEspnTeamRoster(
			league({
				scoringPeriodId: undefined,
				currentPeriodId: undefined,
				status: { currentMatchupPeriod: 8 },
			}),
		);
		expect(matchupOnly.week).toBe(14);

		const allZero = sanitizeEspnTeamRoster(
			league({
				scoringPeriodId: 0,
				currentPeriodId: 0,
				status: { latestScoringPeriod: 0, currentMatchupPeriod: 7 },
			}),
		);
		expect(allZero.week).toBe(14);
	});

	it("keeps playoffSeed 0 instead of coalescing to 1", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 1,
						name: "Unseeded",
						playoffSeed: 0,
					},
				],
			}),
		);
		expect(roster.rank).toBe(0);
	});

	it("hardcodes opp as vs NFL, rounds 17.95 to a High Floor 18, and leaves padded injury codes ACTIVE", () => {
		const { roster, sanitizedTokensEstimate } = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 1,
						name: "Edges",
						roster: {
							entries: [
								playerEntry({
									lineupSlotId: 2,
									id: 401,
									fullName: "Round Up",
									appliedStatTotal: 17.95,
								}),
								playerEntry({
									lineupSlotId: 4,
									id: 402,
									fullName: "Padded Questionable",
									injuryStatus: "questionable ",
									appliedStatTotal: 11,
								}),
								playerEntry({
									lineupSlotId: 20,
									id: 403,
									fullName: "Padded Out",
									injuryStatus: " out",
									appliedStatTotal: 8,
								}),
							],
						},
					},
				],
			}),
		);

		const rounded = roster.starters.find((p) => p.name === "Round Up");
		expect(rounded?.projPts).toBe(18);
		expect(rounded?.tags).toEqual(["High Floor"]);
		expect(rounded?.opp).toBe("vs NFL");

		const paddedQ = roster.starters.find(
			(p) => p.name === "Padded Questionable",
		);
		expect(paddedQ?.status).toBe("ACTIVE");
		expect(paddedQ?.tags).toBeUndefined();
		expect(paddedQ?.injuryDesc).toBeUndefined();
		expect(paddedQ?.opp).toBe("vs NFL");

		const paddedOut = roster.bench.find((p) => p.name === "Padded Out");
		expect(paddedOut?.status).toBe("ACTIVE");
		expect(paddedOut?.injuryDesc).toBeUndefined();

		expect(sanitizedTokensEstimate).toBe(3 * 12 + 60);
	});

	it("treats omitted or empty roster entries as an empty lineup with the envelope token estimate", () => {
		const omitted = sanitizeEspnTeamRoster(
			league({
				teams: [{ id: 10, name: "Empty Book" }],
			}),
		);
		expect(omitted.roster.starters).toEqual([]);
		expect(omitted.roster.bench).toEqual([]);
		expect(omitted.sanitizedTokensEstimate).toBe(60);

		const emptyEntries = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 11,
						name: "No Players",
						roster: { entries: [] },
					},
				],
			}),
		);
		expect(emptyEntries.roster.starters).toEqual([]);
		expect(emptyEntries.sanitizedTokensEstimate).toBe(60);
	});
});

describe("ESPN Durable Object leftover HTTP contracts", () => {
	it("treats JSON leagueId 0 as omitted and falls through to ESPN_LEAGUE_ID", async () => {
		const teamId = `espn-zero-league-${crypto.randomUUID()}`;
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(teamId),
		);
		const raw = league({
			teams: [{ id: 1, name: "Env Club", primaryOwner: "{OWNER-1}" }],
		});

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			instance.env.ESPN_LEAGUE_ID = "777001";
		});

		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = espnFetch(raw);
			const res = await fetchWorker(`/api/fantasy/espn/sync?teamId=${teamId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leagueId: 0, espnS2: "s2", swid: "{S}" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as CommandCenterState;
			expect(body.espnSyncMeta?.leagueId).toBe("777001");
			expect(body.activeRoster.teamName).toBe("Env Club");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("parses ESPN_SEASON with parseInt so a trailing suffix still selects that year", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-season-${crypto.randomUUID()}`),
		);
		let capturedUrl = "";

		const updated = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				instance.env.ESPN_SEASON = "2025abc";
				return instance.syncEspnRoster(
					{ leagueId: "12345678" },
					async (input) => {
						capturedUrl = String(input);
						return espnFetch(league())();
					},
				);
			},
		);

		expect(capturedUrl).toContain("/seasons/2025/");
		expect(updated.espnSyncMeta?.season).toBe(2025);
	});

	it("serves GET /fantasy/state as JSON after sync, and rejects GET /espn/sync through the worker", async () => {
		const teamId = `espn-state-${crypto.randomUUID()}`;
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(teamId),
		);
		const raw = league({
			scoringPeriodId: 9,
			teams: [{ id: 1, name: "State Club", primaryOwner: "{OWNER-1}" }],
		});

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) =>
			instance.syncEspnRoster({ leagueId: "12345678" }, espnFetch(raw)),
		);

		const stateRes = await stub.fetch("https://do/fantasy/state");
		expect(stateRes.status).toBe(200);
		const state = (await stateRes.json()) as CommandCenterState;
		expect(state.selectedWeek).toBe(9);
		expect(state.activeRoster.teamName).toBe("State Club");
		expect(state.espnSyncMeta?.leagueId).toBe("12345678");

		const workerState = await fetchWorker(
			`/api/fantasy/state?teamId=${teamId}`,
		);
		expect(workerState.status).toBe(200);
		await expect(workerState.json()).resolves.toMatchObject({
			selectedWeek: 9,
			activeRoster: { teamName: "State Club" },
		});

		const getSync = await fetchWorker(`/api/fantasy/espn/sync?teamId=${teamId}`);
		expect(getSync.status).toBe(400);
		expect(await getSync.text()).toBe("Expected WebSocket");
	});
});
