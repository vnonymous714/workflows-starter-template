import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	extractTokenUsage,
	parseGrokVerdict,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import { importSleeperRoster } from "../src/sleeper-client";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function uniqueName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("Worker leftover Upgrade whitespace", () => {
	it("still upgrades when Upgrade has a trailing space (Headers.get trims; inverse of WebSocket casing)", async () => {
		const response = await fetchWorker("/ws?instanceId=demo", {
			headers: { Upgrade: "websocket " },
		});
		expect(response.status).toBe(101);
		expect(response.webSocket).toBeDefined();
		response.webSocket?.accept();
		response.webSocket?.close(1000, "done");
	});
});

describe("ESPN leftover malformed payloads that wipe or crash", () => {
	it("throws when roster.entries contains a null slot (inverse of entries: null)", () => {
		const raw = {
			id: 91,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Null Slot",
					roster: {
						entries: [null],
					},
				},
			],
		} as unknown as EspnRawLeagueResponse;

		expect(() => sanitizeEspnTeamRoster(raw, 1)).toThrow(TypeError);
	});

	it("imports teams: [{}] as an empty ESPN Team undefined roster instead of throwing", () => {
		const { roster, week, sanitizedTokensEstimate } = sanitizeEspnTeamRoster({
			id: 92,
			seasonId: 2024,
			teams: [{}],
		} as unknown as EspnRawLeagueResponse);

		expect(roster.teamId).toBe("espn_team_undefined");
		expect(roster.teamName).toBe("ESPN Team undefined");
		expect(roster.owner).toBe("ESPN Team Owner");
		expect(roster.starters).toEqual([]);
		expect(roster.bench).toEqual([]);
		expect(week).toBe(14);
		expect(sanitizedTokensEstimate).toBe(60);
	});

	it("throws when members contains null and a primaryOwner is set", () => {
		const raw = {
			id: 93,
			seasonId: 2024,
			members: [null],
			teams: [
				{
					id: 2,
					name: "Sparse Members",
					primaryOwner: "{OWNER-1}",
				},
			],
		} as unknown as EspnRawLeagueResponse;

		expect(() => sanitizeEspnTeamRoster(raw, 2)).toThrow(TypeError);
	});

	it("keeps NaN appliedStatTotal (typeof number) and does not add High Floor", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 94,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "NaN Proj",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									appliedStatTotal: Number.NaN,
									player: {
										id: 4426515,
										fullName: "Kyren Williams",
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

		expect(Number.isNaN(roster.starters[0]?.projPts)).toBe(true);
		expect(roster.starters[0]?.tags).toBeUndefined();
	});

	it("keeps Infinity appliedStatTotal and tags High Floor", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 95,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Inf Proj",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									appliedStatTotal: Number.POSITIVE_INFINITY,
									player: {
										id: 8138,
										fullName: "Kyren Williams",
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

		expect(roster.starters[0]?.projPts).toBe(Number.POSITIVE_INFINITY);
		expect(roster.starters[0]?.tags).toEqual(["High Floor"]);
	});

	it("treats string scoringPeriodId \"0\" as week 0 instead of falling through to 14", () => {
		const { week } = sanitizeEspnTeamRoster({
			id: 96,
			seasonId: 2024,
			scoringPeriodId: "0" as unknown as number,
			currentPeriodId: 12,
			status: { latestScoringPeriod: 13 },
			teams: [{ id: 1, name: "String Zero Week" }],
		});

		expect(week).toBe("0");
		expect(week).not.toBe(14);
		expect(week).not.toBe(12);
	});
});

describe("Sleeper leftover empty roster objects wipe the lineup", () => {
	it("imports [{}] as an empty Team undefined roster instead of 404", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/9988776655")) {
				return Response.json({
					league_id: "9988776655",
					name: "Hollow League",
				});
			}
			if (url.endsWith("/league/9988776655/rosters")) {
				return Response.json([{}]);
			}
			if (url.endsWith("/league/9988776655/users")) {
				return Response.json([]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "9988776655" },
			fetchImpl,
		);

		expect(roster.teamId).toBe("sleeper_9988776655_undefined");
		expect(roster.teamName).toBe("Team undefined (Hollow League)");
		expect(roster.owner).toBe("Sleeper Manager (Sleeper)");
		expect(roster.record).toBe("0-0");
		expect(roster.starters).toEqual([]);
		expect(roster.bench).toEqual([]);
	});

	it("persists that empty Sleeper import over the seeded Command Center starters", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("empty-sleeper-wipe")),
		);

		const before = await stub.getFantasyState();
		expect(before.activeRoster.starters.length).toBeGreaterThan(0);
		expect(before.activeRoster.teamName).toBe("Neural Gridiron Pulse");

		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/1100223344")) {
				return Response.json({
					league_id: "1100223344",
					name: "Wipe League",
				});
			}
			if (url.endsWith("/league/1100223344/rosters")) {
				return Response.json([{ roster_id: 1 }]);
			}
			if (url.endsWith("/league/1100223344/users")) {
				return Response.json([]);
			}
			return new Response("Not found", { status: 404 });
		};

		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.importSleeper("1100223344", undefined, fetchImpl);
		});

		const after = await stub.getFantasyState();
		expect(after.activeRoster.teamName).toBe("Team 1 (Wipe League)");
		expect(after.activeRoster.starters).toEqual([]);
		expect(after.activeRoster.bench).toEqual([]);
		expect(after.liveAlerts[0]?.type).toBe("LINEUP");
		expect(after.liveAlerts[0]?.message).toContain("Sleeper Roster Imported");
	});
});

describe("Grok leftover null rec items and empty rec ids", () => {
	it("throws TypeError (not GrokRequestError) when recs contains null", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		expect(() =>
			parseGrokVerdict({ recs: [null] }, kyren, charbonnet),
		).toThrow(TypeError);
	});

	it("accepts an empty rec.id and never matches it to a rostered player", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "",
						act: "SIT",
						delta: -4.2,
						conf: 0.8,
						why: "Blank id",
						flags: ["INJ"],
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(recs[0]?.id).toBe("");
		expect(recs[0]?.act).toBe("SIT");
		expect(recommendationMatchesPlayer(recs[0]!, kyren)).toBe(false);
		expect(recommendationMatchesPlayer(recs[0]!, charbonnet)).toBe(false);
	});

	it("returns NaN token usage when total_tokens is NaN", () => {
		expect(extractTokenUsage({ total_tokens: Number.NaN })).toBeNaN();
	});
});
