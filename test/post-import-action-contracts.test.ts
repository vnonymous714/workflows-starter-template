import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	buildEspnApiUrl,
	buildEspnCookieHeader,
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	GrokRequestError,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import { importSleeperRoster } from "../src/sleeper-client";
import type { CommandCenterState } from "../src/types/fantasy";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

const ESPN_LEAGUE: EspnRawLeagueResponse = {
	id: 12345678,
	seasonId: 2024,
	scoringPeriodId: 14,
	members: [
		{
			id: "{A8726312-3214-5432-B812-9876543210AB}",
			displayName: "Commissioner Dave",
		},
	],
	teams: [
		{
			id: 1,
			location: "Gridiron",
			nickname: "Dynasty",
			primaryOwner: "{A8726312-3214-5432-B812-9876543210AB}",
			record: { overall: { wins: 10, losses: 3, ties: 0 } },
			playoffSeed: 1,
			roster: {
				entries: [
					{
						lineupSlotId: 0,
						playerPoolEntry: {
							appliedStatTotal: 24.5,
							player: {
								id: 3918298,
								fullName: "Josh Allen",
								defaultPositionId: 1,
								proTeamId: 2,
								injuryStatus: "ACTIVE",
							},
						},
					},
					{
						lineupSlotId: 2,
						playerPoolEntry: {
							appliedStatTotal: 17.8,
							player: {
								id: 4426515,
								fullName: "Kyren Williams",
								defaultPositionId: 2,
								proTeamId: 14,
								injuryStatus: "QUESTIONABLE",
							},
						},
					},
					{
						lineupSlotId: 20,
						playerPoolEntry: {
							appliedStatTotal: 14.2,
							player: {
								id: 4567890,
								fullName: "Zach Charbonnet",
								defaultPositionId: 2,
								proTeamId: 26,
								injuryStatus: "ACTIVE",
							},
						},
					},
				],
			},
		},
	],
};

const SLEEPER_LEAGUE_ID = "1122334455";

function uniqueTeam(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function espnFetch(body: unknown = ESPN_LEAGUE): typeof fetch {
	return async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
}

function sleeperFetch(
	overrides: {
		leagueId?: string;
		league?: unknown;
		users?: unknown;
		starters?: string[];
		players?: string[];
		ownerId?: string;
	} = {},
): typeof fetch {
	const leagueId = overrides.leagueId ?? SLEEPER_LEAGUE_ID;
	return async (input) => {
		const url = String(input);
		if (url.endsWith(`/league/${leagueId}`)) {
			return Response.json(
				overrides.league ?? {
					league_id: leagueId,
					name: "Champions League",
				},
			);
		}
		if (url.endsWith(`/league/${leagueId}/rosters`)) {
			return Response.json([
				{
					roster_id: 1,
					owner_id: overrides.ownerId ?? "user_101",
					starters: overrides.starters ?? ["4984", "8138"],
					players: overrides.players ?? ["4984", "8138", "9221"],
					settings: { wins: 8, losses: 5, ties: 0 },
				},
				{
					roster_id: 2,
					owner_id: "user_102",
					starters: ["7553"],
					players: ["7553", "7543"],
					settings: { wins: 6, losses: 7, ties: 0 },
				},
			]);
		}
		if (url.endsWith(`/league/${leagueId}/users`)) {
			return Response.json(
				overrides.users ?? [
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
			);
		}
		return new Response("Not found", { status: 404 });
	};
}

function grokFetch(): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (!url.includes("api.x.ai")) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		return Response.json({
			model: "grok-4",
			choices: [
				{
					message: {
						content: JSON.stringify({
							act: "SIT",
							delta: -4.2,
							conf: 0.81,
							why: "Ankle DNP",
							flags: ["INJ"],
						}),
					},
				},
			],
			usage: { total_tokens: 88 },
		});
	};
}

async function stubFor(name: string) {
	return env.WORKFLOW_STATUS.get(env.WORKFLOW_STATUS.idFromName(name));
}

async function syncEspn(teamId: string): Promise<CommandCenterState> {
	const stub = await stubFor(teamId);
	return runInDurableObject(stub, async (instance: WorkflowStatusDO) =>
		instance.syncEspnRoster({ leagueId: "12345678" }, espnFetch()),
	);
}

async function importSleeperTeam(teamId: string): Promise<CommandCenterState> {
	const stub = await stubFor(teamId);
	return runInDurableObject(stub, async (instance: WorkflowStatusDO) =>
		instance.importSleeper(
			SLEEPER_LEAGUE_ID,
			"gridiron_king",
			sleeperFetch(),
		),
	);
}

async function decideWithKey(
	teamId: string,
	playerA: string,
	playerB: string,
) {
	const stub = await stubFor(teamId);
	return runInDurableObject(stub, async (instance: WorkflowStatusDO) =>
		instance.decide(playerA, playerB, false, {
			apiKey: "test-xai-key",
			fetchImpl: grokFetch(),
		}),
	);
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("post-import seed ids vs imported ids", () => {
	it("rejects Evaluate with seed ids after ESPN sync because those ids no longer resolve", async () => {
		const teamId = uniqueTeam("espn-seed-decide");
		await syncEspn(teamId);

		await expect(
			decideWithKey(teamId, "p_kyren", "p_charbonnet"),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_INVALID_RESPONSE",
			message: "Unknown player in start/sit query.",
		} satisfies Partial<GrokRequestError>);
	});

	it("silently no-ops the Command Center swap when seed ids are posted after ESPN sync", async () => {
		const teamId = uniqueTeam("espn-seed-swap");
		const afterSync = await syncEspn(teamId);
		const starterIds = afterSync.activeRoster.starters.map((p) => p.id);
		const alertCount = afterSync.liveAlerts.length;
		expect(starterIds).toEqual(["espn_3918298", "espn_4426515"]);

		const response = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${teamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					starterId: "p_kyren",
					benchId: "p_charbonnet",
				}),
			},
		);

		expect(response.status).toBe(200);
		const state = (await response.json()) as CommandCenterState;
		expect(state.activeRoster.starters.map((p) => p.id)).toEqual(starterIds);
		expect(state.liveAlerts).toHaveLength(alertCount);
		expect(state.liveAlerts[0]?.type).toBe("ESPN");
	});

	it("swaps imported ESPN ids and keeps the starter slot position", async () => {
		const teamId = uniqueTeam("espn-import-swap");
		await syncEspn(teamId);

		const response = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${teamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					starterId: "espn_3918298",
					benchId: "espn_4567890",
				}),
			},
		);

		expect(response.status).toBe(200);
		const state = (await response.json()) as CommandCenterState;
		const qbSlot = state.activeRoster.starters.find(
			(p) => p.id === "espn_4567890",
		);
		expect(qbSlot?.name).toBe("Zach Charbonnet");
		expect(qbSlot?.pos).toBe("QB");
		expect(
			state.activeRoster.bench.find((p) => p.id === "espn_3918298")?.pos,
		).toBe("RB");
		expect(state.liveAlerts[0]?.type).toBe("LINEUP");
	});

	it("evaluates imported ESPN ids and still highlights Kyren via last-name rec match", async () => {
		const teamId = uniqueTeam("espn-import-decide");
		const afterSync = await syncEspn(teamId);
		const kyren = afterSync.activeRoster.starters.find(
			(p) => p.id === "espn_4426515",
		);
		expect(kyren).toBeDefined();

		const stub = await stubFor(teamId);
		const decision = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.decide("espn_4426515", "espn_4567890", false, {
					apiKey: "test-xai-key",
					fetchImpl: grokFetch(),
				}),
		);

		expect(decision.recs[0]?.id).toBe("Williams");
		expect(recommendationMatchesPlayer(decision.recs[0]!, kyren!)).toBe(true);

		const persisted = await stub.getFantasyState();
		expect(persisted.lastDecision?.tokensUsed).toBe(88);
		expect(persisted.espnSyncMeta?.leagueId).toBe("12345678");
	});

	it("serves the imported ESPN roster on the UI GET /api/fantasy/state path", async () => {
		const teamId = uniqueTeam("espn-state-http");
		await syncEspn(teamId);

		const response = await fetchWorker(`/api/fantasy/state?teamId=${teamId}`);
		expect(response.status).toBe(200);
		const state = (await response.json()) as CommandCenterState;
		expect(state.activeRoster.starters.map((p) => p.id)).toEqual([
			"espn_3918298",
			"espn_4426515",
		]);
		expect(state.espnSyncMeta?.leagueId).toBe("12345678");
	});

	it("rejects seed Evaluate after Sleeper import but still resolves name tokens", async () => {
		const teamId = uniqueTeam("sleeper-seed-decide");
		await importSleeperTeam(teamId);

		await expect(
			decideWithKey(teamId, "p_kyren", "p_charbonnet"),
		).rejects.toMatchObject({
			code: "XAI_INVALID_RESPONSE",
			message: "Unknown player in start/sit query.",
		});

		const decision = await decideWithKey(teamId, "kyren", "charbonnet");
		expect(decision.recs[0]?.id).toBe("Williams");
		expect(decision.recs[1]?.id).toBe("Charbonnet");
	});

	it("no-ops seed swap after Sleeper import and swaps the imported ids", async () => {
		const teamId = uniqueTeam("sleeper-swap");
		const afterImport = await importSleeperTeam(teamId);
		expect(afterImport.activeRoster.starters.map((p) => p.id)).toEqual([
			"p_4984",
			"p_8138",
		]);

		const seedSwap = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${teamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					starterId: "p_kyren",
					benchId: "p_charbonnet",
				}),
			},
		);
		expect(seedSwap.status).toBe(200);
		const unchanged = (await seedSwap.json()) as CommandCenterState;
		expect(unchanged.activeRoster.starters.map((p) => p.id)).toEqual([
			"p_4984",
			"p_8138",
		]);
		expect(unchanged.liveAlerts[0]?.message).toContain("Sleeper Roster Imported");

		const importedSwap = await fetchWorker(
			`/api/fantasy/roster/swap?teamId=${teamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					starterId: "p_8138",
					benchId: "p_9221",
				}),
			},
		);
		expect(importedSwap.status).toBe(200);
		const swapped = (await importedSwap.json()) as CommandCenterState;
		expect(swapped.activeRoster.starters.map((p) => p.id)).toContain("p_9221");
		expect(swapped.activeRoster.starters.map((p) => p.id)).not.toContain(
			"p_8138",
		);
		expect(swapped.liveAlerts[0]?.type).toBe("LINEUP");
	});
});

describe("import identity leftovers", () => {
	it("does not match a padded Sleeper display_name, so the first roster is imported", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: SLEEPER_LEAGUE_ID, userOrRosterId: "rival boss" },
			sleeperFetch({
				users: [
					{
						user_id: "user_101",
						username: "gridiron_king",
						display_name: "Gridiron King",
					},
					{
						user_id: "user_102",
						username: "rival_boss",
						display_name: "  Rival Boss",
					},
				],
			}),
		);

		expect(roster.teamId).toBe(`sleeper_${SLEEPER_LEAGUE_ID}_1`);
		expect(roster.owner).toContain("Gridiron King");
	});

	it("interpolates slash-containing league ids into the ESPN and Sleeper request paths", async () => {
		expect(buildEspnApiUrl(2024, "123/456")).toContain("/leagues/123/456?");

		let sleeperUrl = "";
		await importSleeperRoster(
			{ leagueId: "abc/def" },
			async (input) => {
				sleeperUrl = String(input);
				return new Response("gone", { status: 404 });
			},
		).catch(() => undefined);

		expect(sleeperUrl).toBe("https://api.sleeper.app/v1/league/abc/def");
	});

	it("still emits empty cookie values when espn_s2 and SWID are whitespace-only", async () => {
		expect(buildEspnCookieHeader("   ", "   ")).toBe("espn_s2=; SWID=");

		let cookie = "";
		await fetchEspnLeagueData({
			leagueId: "12345678",
			espnS2: "   ",
			swid: "   ",
			fetchImpl: async (_input, init) => {
				cookie = new Headers(init?.headers).get("Cookie") ?? "";
				return new Response(JSON.stringify(ESPN_LEAGUE), { status: 200 });
			},
		});
		expect(cookie).toBe("espn_s2=; SWID=");
	});

	it("keeps the imported ESPN roster when intel is refreshed", async () => {
		const teamId = uniqueTeam("espn-refresh");
		await syncEspn(teamId);

		const stub = await stubFor(teamId);
		const refreshed = await stub.refreshIntel();
		expect(refreshed.activeRoster.teamName).toBe("Gridiron Dynasty");
		expect(refreshed.activeRoster.starters.map((p) => p.id)).toEqual([
			"espn_3918298",
			"espn_4426515",
		]);
		expect(refreshed.espnSyncMeta?.leagueId).toBe("12345678");
		expect(refreshed.intelPacket.fresh).toBe(true);
		expect(refreshed.liveAlerts[0]?.type).toBe("GROK");
	});
});

describe("CSSP leftover contracts after import", () => {
	it("truncates beat claims longer than 140 characters in the compact packet", () => {
		const state = structuredClone(buildCommandCenterState());
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;
		const longClaim = `${"word ".repeat(40)}end`;
		expect(longClaim.length).toBeGreaterThan(140);

		state.intelPacket.beatReports = [
			{
				id: "beat_long",
				handle: "@RapSheet",
				authorName: "Ian Rapoport",
				timestamp: "now",
				claim: longClaim,
				playerId: "p_kyren",
				team: "LAR",
				confidence: 0.8,
				impactLevel: "HIGH",
			},
		];

		const packet = buildCsspPacket(state, kyren, charbonnet, false);
		expect(packet).toContain(`BEAT @RapSheet: ${longClaim.slice(0, 137)}...`);
		expect(packet).not.toContain(longClaim);
	});

	it("still matches a Williams verdict to an ESPN Kyren Williams player", () => {
		const { roster } = sanitizeEspnTeamRoster(ESPN_LEAGUE, 1);
		const kyren = roster.starters.find((p) => p.id === "espn_4426515")!;
		expect(
			recommendationMatchesPlayer(
				{
					id: "Williams",
					act: "SIT",
					vs: "Charbonnet",
					delta: -4.2,
					conf: 0.8,
					why: "Ankle",
					src: "grok",
					flags: ["INJ"],
				},
				kyren,
			),
		).toBe(true);
	});
});
