import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	extractTokenUsage,
	GrokRequestError,
	recId,
	recommendationMatchesPlayer,
	resolvePlayer,
} from "../src/grok-client";
import {
	EspnRequestError,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
} from "../src/espn-client";
import { importSleeperRoster } from "../src/sleeper-client";
import worker from "../worker/index";

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

const MOCK_USAGE = {
	prompt_tokens: 142,
	completion_tokens: 67,
	total_tokens: 209,
};

const MOCK_VERDICT = {
	act: "SIT",
	delta: -4.2,
	conf: 0.81,
	why: "Ankle DNP in 28mph Buffalo wind",
	flags: ["INJ", "WX"],
};

describe("ESPN leftover slot, team, and null-shape contracts", () => {
	it("keeps WR slot 4 even when defaultPositionId is RB", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 401,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "WR Slot",
					roster: {
						entries: [
							{
								lineupSlotId: 4,
								playerPoolEntry: {
									appliedStatTotal: 16.1,
									player: {
										id: 101,
										fullName: "Flexed Back",
										defaultPositionId: 2,
										proTeamId: 14,
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
		expect(roster.starters[0]?.name).toBe("Flexed Back");
		expect(roster.bench).toHaveLength(0);
	});

	it("maps bench defaultPositionId 3/5/16 to WR/K/DST instead of slot default RB", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 402,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Bench Pos",
					roster: {
						entries: [
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									player: {
										id: 201,
										fullName: "Bench WR",
										defaultPositionId: 3,
										proTeamId: 26,
									},
								},
							},
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									player: {
										id: 202,
										fullName: "Bench K",
										defaultPositionId: 5,
										proTeamId: 6,
									},
								},
							},
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									player: {
										id: 203,
										fullName: "Bench DST",
										defaultPositionId: 16,
										proTeamId: 33,
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters).toHaveLength(0);
		expect(roster.bench.map((p) => p.pos)).toEqual(["WR", "K", "DST"]);
	});

	it("maps proTeamId 34 to HOU and the unused 32 gap to NFL", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 403,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Pro Teams",
					roster: {
						entries: [
							{
								lineupSlotId: 2,
								playerPoolEntry: {
									player: {
										id: 301,
										fullName: "Houston Starter",
										defaultPositionId: 2,
										proTeamId: 34,
									},
								},
							},
							{
								lineupSlotId: 20,
								playerPoolEntry: {
									player: {
										id: 302,
										fullName: "Gap Team",
										defaultPositionId: 2,
										proTeamId: 32,
									},
								},
							},
						],
					},
				},
			],
		});

		expect(roster.starters[0]?.team).toBe("HOU");
		expect(roster.bench[0]?.team).toBe("NFL");
	});

	it("keeps ESPN Team Owner when members is null (falsy, no throw)", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 404,
			seasonId: 2024,
			members: null,
			teams: [
				{
					id: 1,
					name: "Null Members",
					primaryOwner: "owner-1",
					roster: { entries: [] },
				},
			],
		} as unknown as EspnRawLeagueResponse);

		expect(roster.owner).toBe("ESPN Team Owner");
	});

	it("throws ESPN_INVALID_RESPONSE when teams is a plain object, not TypeError", () => {
		const raw = {
			id: 405,
			seasonId: 2024,
			teams: { id: 1, name: "Not An Array" },
		} as unknown as EspnRawLeagueResponse;

		expect(() => sanitizeEspnTeamRoster(raw)).toThrow(EspnRequestError);
		try {
			sanitizeEspnTeamRoster(raw);
		} catch (error) {
			expect(error).toMatchObject({ code: "ESPN_INVALID_RESPONSE" });
		}
	});

	it("keeps ESPN Team Owner when owners is null and primaryOwner is omitted", () => {
		const { roster } = sanitizeEspnTeamRoster({
			id: 406,
			seasonId: 2024,
			members: [{ id: "owner-1", displayName: "Would Match" }],
			teams: [
				{
					id: 1,
					name: "Null Owners",
					owners: null as unknown as string[],
					roster: { entries: [] },
				},
			],
		});

		expect(roster.owner).toBe("ESPN Team Owner");
	});

	it("treats roster: null as an empty envelope instead of throwing", () => {
		const { roster, sanitizedTokensEstimate } = sanitizeEspnTeamRoster({
			id: 407,
			seasonId: 2024,
			teams: [
				{
					id: 1,
					name: "Null Roster",
					roster: null,
				},
			],
		} as unknown as EspnRawLeagueResponse);

		expect(roster.starters).toEqual([]);
		expect(roster.bench).toEqual([]);
		expect(sanitizedTokensEstimate).toBe(60);
	});
});

describe("Grok leftover lookup, content-shape, and usage contracts", () => {
	it("resolves empty and whitespace tokens to Josh Allen via includes", () => {
		const state = buildCommandCenterState();
		const first = state.activeRoster.starters[0];

		// "" is a substring of every id. " " matches the first name that contains a space.
		expect(resolvePlayer(state, "")?.id).toBe(first?.id);
		expect(resolvePlayer(state, "")?.name).toBe("Josh Allen");
		expect(resolvePlayer(state, " ")?.name).toBe("Josh Allen");
	});

	it("resolves \"will\" to Kyren Williams via name includes, unlike rec-id prefix matching", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;

		expect(resolvePlayer(state, "will")?.id).toBe("p_kyren");
		expect(
			recommendationMatchesPlayer(
				{
					id: "Will",
					act: "SIT",
					vs: "Charbonnet",
					delta: -1,
					conf: 0.5,
					why: "prefix",
					src: "grok",
					flags: [],
				},
				kyren,
			),
		).toBe(false);
	});

	it("keys Baltimore Ravens as Ravens so DST recs can match the last name token", () => {
		const state = buildCommandCenterState();
		const dst = resolvePlayer(state, "p_baldst")!;

		expect(recId(dst)).toBe("Ravens");
		expect(
			recommendationMatchesPlayer(
				{
					id: "Ravens",
					act: "START",
					vs: "",
					delta: 1,
					conf: 0.5,
					why: "stream",
					src: "grok",
					flags: [],
				},
				dst,
			),
		).toBe(true);
	});

	it("throws TypeError when xAI content is an object instead of GrokRequestError", async () => {
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
							choices: [{ message: { content: MOCK_VERDICT } }],
							usage: MOCK_USAGE,
						}),
				},
			),
		).rejects.toBeInstanceOf(TypeError);

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
							choices: [{ message: { content: MOCK_VERDICT } }],
							usage: MOCK_USAGE,
						}),
				},
			),
		).rejects.not.toBeInstanceOf(GrokRequestError);
	});

	it("sums prompt_tokens with output_tokens when total and completion_tokens are omitted", () => {
		expect(
			extractTokenUsage({ prompt_tokens: 100, output_tokens: 40 }),
		).toBe(140);
	});
});

describe("Sleeper leftover collection shapes and identity collisions", () => {
	const league = {
		league_id: "998877",
		name: "Collision League",
	};

	it("throws TypeError when users is a plain object (find sits outside the users try/catch)", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/998877")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/998877/rosters")) {
				return Response.json([
					{ roster_id: 1, owner_id: "u1", starters: ["4984"], players: ["4984"] },
				]);
			}
			if (url.endsWith("/league/998877/users")) {
				return Response.json({ user_id: "u1", display_name: "Not Iterable" });
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "998877" }, fetchImpl),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("throws when the league payload is JSON null instead of falling back to Sleeper League", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/998877")) {
				return Response.json(null);
			}
			return new Response("Not found", { status: 404 });
		};

		await expect(
			importSleeperRoster({ leagueId: "998877" }, fetchImpl),
		).rejects.toThrow();
	});

	it("imports the first users.find match when display_name and username collide case-insensitively", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/998877")) {
				return Response.json(league);
			}
			if (url.endsWith("/league/998877/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "u1",
						starters: ["4984"],
						players: ["4984"],
					},
					{
						roster_id: 2,
						owner_id: "u2",
						starters: ["8138"],
						players: ["8138"],
					},
				]);
			}
			if (url.endsWith("/league/998877/users")) {
				return Response.json([
					{
						user_id: "u1",
						username: "gridiron_king",
						display_name: "Alex",
					},
					{
						user_id: "u2",
						username: "alex",
						display_name: "Rival Boss",
					},
				]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "998877", userOrRosterId: "alex" },
			fetchImpl,
		);

		expect(roster.teamId).toBe("sleeper_998877_1");
		expect(roster.owner).toContain("Alex");
		expect(roster.starters[0]?.name).toBe("Josh Allen");
	});
});

describe("Worker leftover Evaluate method contract", () => {
	it("returns 400 Expected WebSocket for GET /api/fantasy/decide (UI POSTs)", async () => {
		const response = await fetchWorker("/api/fantasy/decide");

		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Expected WebSocket");
	});
});
