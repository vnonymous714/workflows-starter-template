import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	buildCsspPacket,
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

function uniqueName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function stubFor(name: string) {
	const id = env.WORKFLOW_STATUS.idFromName(name);
	return env.WORKFLOW_STATUS.get(id);
}

describe("ESPN leftover null teams and string records", () => {
	it("throws when teams is [null] instead of importing an empty ESPN Team undefined roster", () => {
		const raw = {
			id: 101,
			seasonId: 2024,
			teams: [null],
		} as unknown as EspnRawLeagueResponse;

		expect(() => sanitizeEspnTeamRoster(raw)).toThrow(TypeError);
	});

	it("throws while finding a later real team when an earlier teams row is null", () => {
		const raw = {
			id: 102,
			seasonId: 2024,
			teams: [
				null,
				{
					id: 2,
					name: "Real Second Team",
					roster: { entries: [] },
				},
			],
		} as unknown as EspnRawLeagueResponse;

		expect(() => sanitizeEspnTeamRoster(raw, 2)).toThrow(TypeError);
	});

	it("formats string ties as W-L-T because \"1\" > 0 is true", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 103,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "String Ties",
					record: {
						overall: {
							wins: 10,
							losses: 3,
							ties: "1" as unknown as number,
						},
					},
				},
			],
		});

		expect(roster.record).toBe("10-3-1");
	});

	it("benches a QB when lineupSlotId is omitted (unknown slot is not starter)", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 104,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Missing Slot",
					roster: {
						entries: [
							{
								playerPoolEntry: {
									appliedStatTotal: 22.1,
									player: {
										id: 3918298,
										fullName: "Josh Allen",
										defaultPositionId: 1,
										proTeamId: 2,
										injuryStatus: "ACTIVE",
									},
								},
							},
						],
					},
				},
			],
		} as unknown as EspnRawLeagueResponse);

		expect(roster.starters).toEqual([]);
		expect(roster.bench).toHaveLength(1);
		expect(roster.bench[0]?.name).toBe("Josh Allen");
		expect(roster.bench[0]?.pos).toBe("QB");
	});

	it("defaults projPts to 10 when appliedStatTotal is omitted even if ratings.totalRating is 18.5", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 105,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Ratings Only",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									ratings: { "0": { totalRating: 18.5 } },
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

		expect(roster.starters[0]?.projPts).toBe(10);
		expect(roster.starters[0]?.tags).toBeUndefined();
	});
});

describe("Sleeper leftover null collection rows and string records", () => {
	it("throws when users contains null even if userOrRosterId is omitted", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/5566778899")) {
				return Response.json({
					league_id: "5566778899",
					name: "Null Users League",
				});
			}
			if (url.endsWith("/league/5566778899/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "user_101",
						starters: ["4984"],
						players: ["4984"],
					},
				]);
			}
			if (url.endsWith("/league/5566778899/users")) {
				return Response.json([null]);
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "5566778899" }, fetchImpl),
		).rejects.toThrow(TypeError);
	});

	it("throws when rosters is [null] instead of 404 or Team undefined", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/6677889900")) {
				return Response.json({
					league_id: "6677889900",
					name: "Null Roster League",
				});
			}
			if (url.endsWith("/league/6677889900/rosters")) {
				return Response.json([null]);
			}
			if (url.endsWith("/league/6677889900/users")) {
				return Response.json([]);
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "6677889900" }, fetchImpl),
		).rejects.toThrow(TypeError);
	});

	it("formats string wins/losses/ties as W-L-T because \"1\" > 0 is true", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/7788990011")) {
				return Response.json({
					league_id: "7788990011",
					name: "String Record League",
				});
			}
			if (url.endsWith("/league/7788990011/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "user_201",
						starters: ["4984"],
						players: ["4984"],
						settings: { wins: "9", losses: "4", ties: "1", fpts: "1400" },
					},
				]);
			}
			if (url.endsWith("/league/7788990011/users")) {
				return Response.json([]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "7788990011" },
			fetchImpl,
		);

		expect(roster.record).toBe("9-4-1");
		expect(roster.rank).toBe(1);
	});
});

describe("Grok leftover empty-string delta, usage ??, and full-name rec ids", () => {
	it("accepts rec.delta \"\" as 0 instead of throwing missing fields", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						delta: "",
						conf: 0.8,
						why: "Empty string delta",
						flags: ["INJ"],
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs).toHaveLength(1);
		expect(recs[0]?.delta).toBe(0);
		expect(recs[0]?.act).toBe("SIT");
	});

	it("uses prompt_tokens: 0 over input_tokens via ?? (silent undercount)", () => {
		expect(
			extractTokenUsage({
				prompt_tokens: 0,
				input_tokens: 80,
				completion_tokens: 10,
			}),
		).toBe(10);
	});

	it("does not match a full-name rec id to the rostered player", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;

		expect(
			recommendationMatchesPlayer(
				{
					id: "Kyren Williams",
					act: "SIT",
					vs: "Charbonnet",
					delta: -4.2,
					conf: 0.8,
					why: "Full name id",
					src: "grok",
					flags: ["INJ"],
				},
				kyren,
			),
		).toBe(false);
		expect(
			recommendationMatchesPlayer(
				{
					id: "Williams",
					act: "SIT",
					vs: "Charbonnet",
					delta: -4.2,
					conf: 0.8,
					why: "Last name id",
					src: "grok",
					flags: ["INJ"],
				},
				kyren,
			),
		).toBe(true);
	});

	it("still emits an INJ line when every practice day is \"-\" (no Wed/Thu/Fri tokens)", () => {
		const state = structuredClone(buildCommandCenterState());
		state.intelPacket.injuries = [
			{
				playerId: "p_kyren",
				playerName: "Kyren Williams",
				team: "LAR",
				status: "Q",
				practiceReport: { wed: "-", thu: "-", fri: "-" },
				handcuffName: "Zach Charbonnet",
				confidence: 0.72,
			},
		];
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const packet = buildCsspPacket(state, kyren, charbonnet, false);
		expect(packet).toContain("- INJ: Kyren Williams Q");
		expect(packet).toContain("conf0.72");
		expect(packet).toContain("hc:Zach Charbonnet");
		expect(packet).not.toContain("Wed-");
		expect(packet).not.toContain("Thu-");
		expect(packet).not.toContain("Fri-");
	});
});

describe("Durable Object leftover get_fantasy_state frame", () => {
	it("returns fantasy_update for get_fantasy_state even when the socket connected as workflow", async () => {
		const stub = stubFor(uniqueName("ws-get-fantasy"));
		const response = await stub.fetch("https://example.com/", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const frames: Array<{ type?: string; payload?: { selectedWeek?: number } }> =
			[];
		const gotSecond = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for get_fantasy_state")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				frames.push(
					JSON.parse(event.data as string) as (typeof frames)[number],
				);
				if (frames.length >= 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		socket.accept();
		socket.send(JSON.stringify({ type: "get_fantasy_state" }));
		await gotSecond;
		socket.close(1000, "done");

		expect(frames[0]?.type).toBe("workflow_update");
		expect(frames[1]?.type).toBe("fantasy_update");
		expect(frames[1]?.payload?.selectedWeek).toBe(14);
	});
});
