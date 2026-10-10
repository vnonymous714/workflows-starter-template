import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	parseGrokVerdict,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	sanitizeEspnTeamRoster,
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

describe("ESPN leftover owner types, string maps, and week/injury coercions", () => {
	it("maps leftover string defaultPositionId 2/3 on the bench to RB/WR", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(801, [
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 8011,
							fullName: "String Bench RB",
							defaultPositionId: "2" as unknown as number,
							proTeamId: 14,
						},
					},
				},
				{
					lineupSlotId: 20,
					playerPoolEntry: {
						player: {
							id: 8012,
							fullName: "String Bench WR",
							defaultPositionId: "3" as unknown as number,
							proTeamId: 26,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => p.pos)).toEqual(["RB", "WR"]);
	});

	it("benches numeric leftover lineupSlotId 3 (not in the ESPN slot map) using defaultPositionId", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(802, [
				{
					lineupSlotId: 3,
					playerPoolEntry: {
						player: {
							id: 8021,
							fullName: "Confused Slot WR",
							defaultPositionId: 3,
							proTeamId: 15,
						},
					},
				},
			]),
		);

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.pos).toBe("WR");
		expect(roster.bench[0]?.name).toBe("Confused Slot WR");
	});

	it("maps leftover numeric slots 16/17/23 to DST/K/FLEX starters", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(803, [
				{
					lineupSlotId: 16,
					playerPoolEntry: {
						player: {
							id: 8031,
							fullName: "Numeric DST",
							defaultPositionId: 1,
							proTeamId: 33,
						},
					},
				},
				{
					lineupSlotId: 17,
					playerPoolEntry: {
						player: {
							id: 8032,
							fullName: "Numeric K",
							defaultPositionId: 2,
							proTeamId: 6,
						},
					},
				},
				{
					lineupSlotId: 23,
					playerPoolEntry: {
						player: {
							id: 8033,
							fullName: "Numeric Flex",
							defaultPositionId: 2,
							proTeamId: 26,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => p.pos)).toEqual(["DST", "K", "FLEX"]);
		expect(roster.bench).toHaveLength(0);
	});

	it("maps leftover string proTeamId 14/33 via object-key coercion and 31 to NFL", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(804, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 8041,
							fullName: "String Team LAR",
							defaultPositionId: 2,
							proTeamId: "14" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 8042,
							fullName: "String Team BAL",
							defaultPositionId: 2,
							proTeamId: "33" as unknown as number,
						},
					},
				},
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 8043,
							fullName: "String Gap NFL",
							defaultPositionId: 2,
							proTeamId: "31" as unknown as number,
						},
					},
				},
			]),
		);

		expect(roster.starters.map((p) => ({ name: p.name, team: p.team }))).toEqual(
			[
				{ name: "String Team LAR", team: "LAR" },
				{ name: "String Team BAL", team: "BAL" },
				{ name: "String Gap NFL", team: "NFL" },
			],
		);
	});

	it("does not match a numeric primaryOwner to a string member id (inverse of numeric member)", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 805,
			seasonId: 2024,
			members: [
				{
					id: "123",
					displayName: "String Member",
				},
			],
			teams: [
				{
					id: 1,
					name: "Owner Type Inverse",
					primaryOwner: 123 as unknown as string,
				},
			],
		});

		expect(roster.owner).toBe("ESPN Team Owner");
		expect(roster.owner).not.toBe("String Member");
	});

	it("maps mixed-case Questionable after toUpperCase (leftover of lowercase / padded codes)", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(806, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						player: {
							id: 8061,
							fullName: "Mixed Case Q",
							defaultPositionId: 2,
							proTeamId: 14,
							injuryStatus: "Questionable",
						},
					},
				},
			]),
		);

		expect(roster.starters[0]?.status).toBe("QUESTIONABLE");
		expect(roster.starters[0]?.tags).toContain("QUESTIONABLE");
		expect(roster.starters[0]?.injuryDesc).toContain("Questionable");
	});

	it("uses string currentPeriodId when scoringPeriodId is omitted (leftover of numeric currentPeriodId)", () => {
		const { week } = sanitizeEspnTeamRoster({
			id: 807,
			seasonId: 2024,
			currentPeriodId: "8" as unknown as number,
			status: { latestScoringPeriod: 11 },
			teams: [
				{
					id: 1,
					name: "String Current Period",
				},
			],
		});

		expect(week).toBe("8");
		expect(week).not.toBe(11);
		expect(week).not.toBe(14);
	});

	it("treats string appliedStatTotal 18.5 as the default 10 without High Floor", () => {
		const { roster } = sanitizeEspnTeamRoster(
			leagueWithEntries(808, [
				{
					lineupSlotId: 2,
					playerPoolEntry: {
						appliedStatTotal: "18.5" as unknown as number,
						player: {
							id: 8081,
							fullName: "String Proj",
							defaultPositionId: 2,
							proTeamId: 14,
						},
					},
				},
			]),
		);

		expect(roster.starters[0]?.projPts).toBe(10);
		expect(roster.starters[0]?.tags ?? []).not.toContain("High Floor");
	});
});

describe("Sleeper leftover 3-letter DST, double-placeholder reindex, and DST-slot override", () => {
	const league = {
		league_id: "leftover-owner-league",
		name: "Leftover Owner League",
	};

	function sleeperFetch(rosters: unknown[], users: unknown[] = []): typeof fetch {
		return async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-owner-league")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/leftover-owner-league/rosters")) {
				return Response.json(rosters);
			}
			if (url.endsWith("/league/leftover-owner-league/users")) {
				return Response.json(users);
			}
			return new Response("Not found", { status: 404 });
		};
	}

	it("treats 3-letter unknown LAR as LAR Defense DST (leftover of 2-letter SF)", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-owner-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984"],
					players: ["4984", "LAR"],
				},
			]),
		);

		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.id).toBe("p_LAR");
		expect(roster.bench[0]?.name).toBe("LAR Defense");
		expect(roster.bench[0]?.pos).toBe("DST");
		expect(roster.bench[0]?.team).toBe("LAR");
		expect(roster.bench[0]?.name).not.toBe("Player #LAR");
	});

	it("reindexes Chase onto RB after dropping two placeholder 0 starters", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-owner-league" },
			sleeperFetch([
				{
					roster_id: 1,
					starters: ["4984", "0", "0", "7564"],
					players: ["4984", "0", "0", "7564"],
				},
			]),
		);

		expect(roster.starters).toHaveLength(2);
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[0]?.pos).toBe("QB");
		expect(roster.starters[1]?.name).toBe("Ja'Marr Chase");
		expect(roster.starters[1]?.pos).toBe("RB");
		expect(roster.starters[1]?.pos).not.toBe("WR");
	});

	it("keeps known RB metadata when that player occupies the hardcoded DST slot", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: "leftover-owner-league" },
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
						"11439",
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
						"11439",
						"8136",
					],
				},
			]),
		);

		expect(roster.starters).toHaveLength(9);
		expect(roster.starters[8]?.name).toBe("Tyler Allgeier");
		expect(roster.starters[8]?.pos).toBe("DST");
		expect(roster.starters[8]?.team).toBe("ATL");
		expect(roster.starters[8]?.tags).toContain("Red Zone Handcuff");
		expect(roster.starters[8]?.projPts).toBe(9.2);
	});

	it("maps Sleeper league HTTP 403 to 502 rather than 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/leftover-owner-league")) {
				return new Response("Forbidden", { status: 403 });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "leftover-owner-league" }, fetchImpl),
		).rejects.toMatchObject({
			name: "SleeperApiError",
			status: 502,
			message: "Sleeper league not found (403)",
		} satisfies Partial<SleeperApiError>);
	});
});

describe("Grok leftover boolean rec fields, SPLIT flag, and apostrophe match", () => {
	it("accepts recs[].delta/conf true as 1 instead of throwing (leftover of false → 0)", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						delta: true,
						conf: true,
						why: "boolean true",
						flags: ["SPLIT", "nope"],
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(recs[0]?.delta).toBe(1);
		expect(recs[0]?.conf).toBe(1);
		expect(recs[0]?.flags).toEqual(["SPLIT"]);
	});

	it("resolves substring ijan to Bijan Robinson via name includes (leftover of osh)", () => {
		const state = buildCommandCenterState();
		const player = resolvePlayer(state, "ijan");

		expect(player?.id).toBe("p_bijan");
		expect(player?.name).toBe("Bijan Robinson");
	});

	it("matches apostrophe first-token rec id Ja'Marr to Chase", () => {
		const state = buildCommandCenterState();
		const chase = resolvePlayer(state, "p_jchase")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Ja'Marr",
					act: "START",
					vs: "Waddle",
					delta: 1,
					conf: 0.8,
					why: "target share",
					src: "grok",
					flags: [],
				},
				chase,
			),
		).toBe(true);
		expect(
			recommendationMatchesPlayer(
				{
					id: "Ja Marr",
					act: "START",
					vs: "Waddle",
					delta: 1,
					conf: 0.8,
					why: "space split",
					src: "grok",
					flags: [],
				},
				chase,
			),
		).toBe(false);
	});
});

describe("Worker leftover trailing-slash fantasy mutate routes", () => {
	it("returns 400 Expected WebSocket for POST /api/fantasy/decide/ trailing slash", async () => {
		const res = await fetchWorker(
			`/api/fantasy/decide/?teamId=${uniqueId("decide-slash")}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					playerA: "p_kyren",
					playerB: "p_charbonnet",
				}),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});

	it("returns 400 Expected WebSocket for POST /api/fantasy/roster/swap/ trailing slash", async () => {
		const res = await fetchWorker(
			`/api/fantasy/roster/swap/?teamId=${uniqueId("swap-slash")}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					starterId: "p_kyren",
					benchId: "p_charbonnet",
				}),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Expected WebSocket");
	});
});
