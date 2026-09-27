import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	importSleeperRoster,
	SleeperApiError,
	type SleeperLeagueRaw,
	type SleeperRosterRaw,
	type SleeperUserRaw,
} from "../src/sleeper-client";

const LEAGUE_ID = "9988776655";

const league: SleeperLeagueRaw = {
	league_id: LEAGUE_ID,
	name: "Collision League",
};

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function sleeperFetch(options: {
	rosters: SleeperRosterRaw[];
	users?: SleeperUserRaw[] | unknown;
	league?: SleeperLeagueRaw;
	throwOnLeague?: Error;
}): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (options.throwOnLeague && url.endsWith(`/league/${LEAGUE_ID}`)) {
			throw options.throwOnLeague;
		}
		if (url.endsWith(`/league/${LEAGUE_ID}`)) {
			return jsonResponse(options.league ?? league);
		}
		if (url.endsWith(`/league/${LEAGUE_ID}/rosters`)) {
			return jsonResponse(options.rosters);
		}
		if (url.endsWith(`/league/${LEAGUE_ID}/users`)) {
			return jsonResponse(options.users ?? []);
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("Sleeper roster resolution collisions", () => {
	it("prefers numeric roster_id over a user whose user_id is the same digits", async () => {
		const rosters: SleeperRosterRaw[] = [
			{
				roster_id: 2,
				owner_id: "owner_a",
				starters: ["4984"],
				players: ["4984"],
			},
			{
				roster_id: 9,
				owner_id: "2",
				starters: ["8183"],
				players: ["8183"],
			},
		];
		const users: SleeperUserRaw[] = [
			{ user_id: "owner_a", display_name: "Roster Two Owner" },
			{ user_id: "2", display_name: "Numeric User Id" },
		];

		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "2" },
			sleeperFetch({ rosters, users }),
		);

		expect(roster.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
		expect(roster.owner).toContain("Roster Two Owner");
		expect(roster.starters.map((p) => p.name)).toEqual(["Josh Allen"]);
		expect(roster.starters.map((p) => p.name)).not.toContain("Bijan Robinson");
	});

	it("does not trim user_id matches, so padded ids fall back to the first roster", async () => {
		const rosters: SleeperRosterRaw[] = [
			{
				roster_id: 1,
				owner_id: "owner_a",
				starters: ["4984"],
				players: ["4984"],
			},
			{
				roster_id: 7,
				owner_id: "user_777",
				starters: ["8183"],
				players: ["8183"],
			},
		];
		const users: SleeperUserRaw[] = [
			{ user_id: "owner_a", display_name: "First Roster" },
			{
				user_id: "user_777",
				username: "second_manager",
				display_name: "Second Manager",
			},
		];

		const paddedUserId = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: " user_777 " },
			sleeperFetch({ rosters, users }),
		);
		expect(paddedUserId.teamId).toBe(`sleeper_${LEAGUE_ID}_1`);
		expect(paddedUserId.owner).toContain("First Roster");

		const paddedUsername = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: " SECOND_MANAGER " },
			sleeperFetch({ rosters, users }),
		);
		expect(paddedUsername.teamId).toBe(`sleeper_${LEAGUE_ID}_7`);
	});
});

describe("Sleeper starters vs players set", () => {
	it("keeps starters that are missing from players and benches only the extras", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID },
			sleeperFetch({
				rosters: [
					{
						roster_id: 1,
						owner_id: "owner_a",
						starters: ["4984", "8183"],
						players: ["8183", "9221"],
					},
				],
			}),
		);

		expect(roster.starters.map((p) => p.id)).toEqual(["p_4984", "p_8183"]);
		expect(roster.starters.map((p) => p.pos)).toEqual(["QB", "RB"]);
		expect(roster.bench.map((p) => p.id)).toEqual(["p_9221"]);
		expect(roster.bench.map((p) => p.name)).toEqual(["Zach Charbonnet"]);
	});

	it("puts every player on the bench when starters is omitted", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID },
			sleeperFetch({
				rosters: [
					{
						roster_id: 1,
						players: ["4984", "9221"],
					},
				],
			}),
		);

		expect(roster.starters).toEqual([]);
		expect(roster.bench.map((p) => p.id)).toEqual(["p_4984", "p_9221"]);
	});

	it("assigns duplicate starter ids to consecutive lineup slots", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID },
			sleeperFetch({
				rosters: [
					{
						roster_id: 1,
						starters: ["4984", "4984"],
						players: ["4984"],
					},
				],
			}),
		);

		expect(roster.starters.map((p) => p.id)).toEqual(["p_4984", "p_4984"]);
		expect(roster.starters.map((p) => p.pos)).toEqual(["QB", "RB"]);
		expect(roster.bench).toEqual([]);
	});
});

describe("Sleeper transport failures", () => {
	it("does not wrap a thrown league fetch as SleeperApiError 502", async () => {
		const pending = importSleeperRoster(
			{ leagueId: LEAGUE_ID },
			sleeperFetch({
				rosters: [],
				throwOnLeague: new Error("network down"),
			}),
		);

		await expect(pending).rejects.toThrow("network down");
		await expect(pending).rejects.not.toBeInstanceOf(SleeperApiError);
	});

	it("maps a thrown Sleeper fetch on the Durable Object HTTP path to 500", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("socket hang up");
		}) as typeof fetch;

		try {
			const stub = env.WORKFLOW_STATUS.get(
				env.WORKFLOW_STATUS.idFromName(
					`sleeper-throw-${crypto.randomUUID()}`,
				),
			);
			const response = await stub.fetch(
				"https://do/roster/sleeper-import",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ leagueId: LEAGUE_ID }),
				},
			);

			expect(response.status).toBe(500);
			await expect(response.json()).resolves.toEqual({
				error: "socket hang up",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
