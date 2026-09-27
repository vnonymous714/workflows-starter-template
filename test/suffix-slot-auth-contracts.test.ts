import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	buildEspnCookieHeader,
	fetchEspnLeagueData,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
	type EspnRawPlayerEntry,
} from "../src/espn-client";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
	clipWhy,
	parseGrokVerdict,
	recId,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
} from "../src/sleeper-client";
import type { FantasyPlayer } from "../src/types/fantasy";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function uniqueTeam(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function player(
	overrides: Partial<FantasyPlayer> & Pick<FantasyPlayer, "id" | "name">,
): FantasyPlayer {
	return {
		pos: "RB",
		team: "LAR",
		opp: "@ BUF",
		projPts: 15,
		status: "ACTIVE",
		...overrides,
	};
}

function espnEntry(
	overrides: {
		lineupSlotId?: number | string;
		id?: number;
		fullName?: string;
		defaultPositionId?: number;
		proTeamId?: number;
		injuryStatus?: string;
		injured?: boolean;
		appliedStatTotal?: number;
	} = {},
): EspnRawPlayerEntry {
	return {
		lineupSlotId: (overrides.lineupSlotId ?? 2) as number,
		playerPoolEntry: {
			appliedStatTotal: overrides.appliedStatTotal,
			player: {
				id: overrides.id ?? 4426515,
				fullName: overrides.fullName ?? "Kyren Williams",
				defaultPositionId: overrides.defaultPositionId ?? 2,
				proTeamId: overrides.proTeamId ?? 14,
				injuryStatus: overrides.injuryStatus,
				injured: overrides.injured,
			},
		},
	};
}

function espnLeague(
	entries: EspnRawPlayerEntry[],
): EspnRawLeagueResponse {
	return {
		id: 12345678,
		seasonId: 2024,
		scoringPeriodId: 14,
		teams: [
			{
				id: 1,
				name: "Gridiron Dynasty",
				roster: { entries },
			},
		],
	};
}

describe("Grok recId suffix leftovers", () => {
	it("uses the first name when the last token is Jr./III (len <= 3)", () => {
		expect(recId(player({ id: "p_kw3", name: "Kenneth Walker III" }))).toBe(
			"Kenneth",
		);
		expect(recId(player({ id: "p_obj", name: "Odell Beckham Jr." }))).toBe(
			"Odell",
		);
		expect(recId(player({ id: "p_stb", name: "Amon-Ra St. Brown" }))).toBe(
			"Brown",
		);
		expect(recId(player({ id: "p_bijan", name: "  Bijan  " }))).toBe("Bijan");
	});

	it("matches a Kenneth Walker III rec by first name, last name, or III", () => {
		const walker = player({ id: "p_8139", name: "Kenneth Walker III" });
		expect(
			recommendationMatchesPlayer(
				{
					id: "Kenneth",
					act: "START",
					vs: "Charbonnet",
					delta: 1,
					conf: 0.8,
					why: "Volume",
					src: "grok",
					flags: [],
				},
				walker,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "Walker",
					act: "START",
					vs: "Charbonnet",
					delta: 1,
					conf: 0.8,
					why: "Volume",
					src: "grok",
					flags: [],
				},
				walker,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "III",
					act: "START",
					vs: "Charbonnet",
					delta: 1,
					conf: 0.8,
					why: "Volume",
					src: "grok",
					flags: [],
				},
				walker,
			),
		).toBe(true);
	});

	it("compact verdicts key the III suffix player as Kenneth, not Walker", () => {
		const walker = player({ id: "p_8139", name: "Kenneth Walker III" });
		const cuff = player({
			id: "p_charbonnet",
			name: "Zach Charbonnet",
			team: "SEA",
			opp: "@ ARI",
		});
		const recs = parseGrokVerdict(
			{ act: "START", delta: 2.4, conf: 0.7, why: "Bellcow", flags: [] },
			walker,
			cuff,
		);
		expect(recs[0]?.id).toBe("Kenneth");
		expect(recs[0]?.vs).toBe("Charbonnet");
		expect(recs[1]?.id).toBe("Charbonnet");
		expect(recs[1]?.vs).toBe("Kenneth");
	});

	it("treats whitespace-only why as empty and numeric rec.id as missing", () => {
		expect(clipWhy("   ")).toBe("");
		expect(clipWhy("\n\tone   two  ")).toBe("one two");

		const a = player({ id: "p_kyren", name: "Kyren Williams" });
		const b = player({ id: "p_charbonnet", name: "Zach Charbonnet" });
		expect(() =>
			parseGrokVerdict(
				{ recs: [{ id: 1, act: "START", delta: 2 }] },
				a,
				b,
			),
		).toThrow(/missing required fields/);
	});
});

describe("ESPN IR slot, padded slot ids, and projection leftovers", () => {
	it("benches IR slot 21 using defaultPositionId, not the slot's RB default", () => {
		const { roster } = sanitizeEspnTeamRoster(
			espnLeague([
				espnEntry({
					lineupSlotId: 21,
					id: 888,
					fullName: "Injured QB",
					defaultPositionId: 1,
					proTeamId: 2,
					injuryStatus: "OUT",
					appliedStatTotal: 4.1,
				}),
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.id).toBe("espn_888");
		expect(roster.bench[0]?.pos).toBe("QB");
		expect(roster.bench[0]?.status).toBe("OUT");
		expect(roster.bench[0]?.tags).toContain("OUT");
	});

	it("treats string lineupSlotId 02 as unknown and benches the player", () => {
		const { roster } = sanitizeEspnTeamRoster(
			espnLeague([
				espnEntry({
					lineupSlotId: "02",
					id: 99,
					fullName: "Padded Slot RB",
					defaultPositionId: 3,
					appliedStatTotal: 11,
				}),
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.name).toBe("Padded Slot RB");
		expect(roster.bench[0]?.pos).toBe("WR");
	});

	it("maps unknown pro teams to NFL, keeps empty names, and rounds 17.94 below High Floor", () => {
		const { roster } = sanitizeEspnTeamRoster(
			espnLeague([
				espnEntry({
					lineupSlotId: 4,
					id: 1,
					fullName: "",
					defaultPositionId: 3,
					proTeamId: 99,
					appliedStatTotal: 17.94,
				}),
				espnEntry({
					lineupSlotId: 20,
					id: 2,
					fullName: "Negative Proj",
					defaultPositionId: 99,
					proTeamId: 0,
					appliedStatTotal: -3.2,
					injured: true,
					injuryStatus: "ACTIVE",
				}),
			]),
		);

		const wr = roster.starters[0];
		expect(wr?.name).toBe("");
		expect(wr?.team).toBe("NFL");
		expect(wr?.projPts).toBe(17.9);
		expect(wr?.tags).toBeUndefined();

		const bench = roster.bench[0];
		expect(bench?.pos).toBe("RB");
		expect(bench?.team).toBe("NFL");
		expect(bench?.projPts).toBe(-3.2);
		expect(bench?.status).toBe("ACTIVE");
		expect(bench?.tags).toBeUndefined();
		expect(bench?.injuryDesc).toBeUndefined();
	});
});

describe("ESPN partial cookies", () => {
	it("emits a one-sided Cookie header when only espn_s2 or only SWID is set", async () => {
		expect(buildEspnCookieHeader("s2_only", undefined)).toBe("espn_s2=s2_only");
		expect(buildEspnCookieHeader(undefined, "{SWID}")).toBe("SWID={SWID}");

		let captured = "";
		await fetchEspnLeagueData({
			leagueId: "123",
			espnS2: "s2_only",
			fetchImpl: async (_input, init) => {
				captured = new Headers(init?.headers).get("Cookie") ?? "";
				return new Response(JSON.stringify(espnLeague([])), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		expect(captured).toBe("espn_s2=s2_only");
		expect(captured).not.toContain("SWID=");
	});
});

describe("Sleeper padded / pre-prefixed player ids", () => {
	it("does not treat a trailing-space known id as Josh Allen", async () => {
		expect(mapSleeperPlayerIdToPlayer("4984 ").name).toBe("Player #4984 ");
		expect(mapSleeperPlayerIdToPlayer("4984 ").id).toBe("p_4984 ");
		expect(mapSleeperPlayerIdToPlayer("p_9999").id).toBe("p_9999");

		const roster = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "1" },
			async (input) => {
				const url = String(input);
				if (url.endsWith("/league/1122334455")) {
					return Response.json({ league_id: "1122334455", name: "Pad League" });
				}
				if (url.endsWith("/rosters")) {
					return Response.json([
						{
							roster_id: 1,
							owner_id: "user_101",
							starters: ["4984 "],
							players: ["4984 "],
							settings: { wins: 1, losses: 0, ties: 0 },
						},
					]);
				}
				if (url.endsWith("/users")) {
					return Response.json([]);
				}
				return new Response("Not found", { status: 404 });
			},
		);

		expect(roster.starters).toHaveLength(1);
		expect(roster.starters[0]?.name).toBe("Player #4984 ");
		expect(roster.starters[0]?.id).toBe("p_4984 ");
		expect(roster.starters[0]?.pos).toBe("QB");
	});
});

describe("Swap empty-body no-op and post-import injury via team", () => {
	it("returns 200 with an unchanged seed roster when swap ids are omitted", async () => {
		const teamId = uniqueTeam("swap-empty");
		const response = await worker.fetch(
			new Request(`https://example.com/api/fantasy/roster/swap?teamId=${teamId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
			env,
		);

		expect(response.status).toBe(200);
		const state = (await response.json()) as ReturnType<
			typeof buildCommandCenterState
		>;
		expect(state.activeRoster.starters.map((p) => p.id)).toContain("p_kyren");
		expect(state.activeRoster.bench.map((p) => p.id)).toContain("p_charbonnet");
		expect(state.liveAlerts[0]?.type).not.toBe("LINEUP");
	});

	it("lets malformed swap JSON throw instead of mapping to a 4xx", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueTeam("swap-bad-json")),
		);

		await expect(
			stub.fetch("https://do/roster/swap", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{not-json",
			}),
		).rejects.toThrow();
	});

	it("still attaches seed LAR injury intel after ESPN rewrites Kyren's id", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueTeam("espn-inj-team")),
		);

		const updated = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{ leagueId: "12345678" },
					async () =>
						new Response(
							JSON.stringify(
								espnLeague([
									espnEntry({
										lineupSlotId: 2,
										id: 4426515,
										fullName: "Kyren Williams",
										proTeamId: 14,
									}),
									espnEntry({
										lineupSlotId: 20,
										id: 4567890,
										fullName: "Zach Charbonnet",
										proTeamId: 26,
									}),
								]),
							),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						),
				),
		);

		const kyren = resolvePlayer(updated, "espn_4426515");
		const charbonnet = resolvePlayer(updated, "espn_4567890");
		expect(kyren?.id).toBe("espn_4426515");
		expect(resolvePlayer(updated, "p_kyren")).toBeUndefined();

		const packet = buildCsspPacket(updated, kyren!, charbonnet!);
		expect(packet).toContain("INJ: Kyren Williams");
		expect(packet).toContain("hc:Zach Charbonnet");
	});

	it("keeps a swapped starter after intel refresh", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueTeam("swap-then-refresh")),
		);

		const afterSwap = await stub.swapRoster("p_kyren", "p_charbonnet");
		expect(afterSwap.activeRoster.starters.map((p) => p.id)).toContain(
			"p_charbonnet",
		);

		const afterRefresh = await stub.refreshIntel();
		expect(afterRefresh.activeRoster.starters.map((p) => p.id)).toContain(
			"p_charbonnet",
		);
		expect(afterRefresh.activeRoster.starters.map((p) => p.id)).not.toContain(
			"p_kyren",
		);
		expect(afterRefresh.intelPacket.fresh).toBe(true);
		expect(afterRefresh.liveAlerts[0]?.type).toBe("GROK");
	});
});
