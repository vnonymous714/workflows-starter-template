import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
	SleeperApiError,
} from "../src/sleeper-client";
import worker from "../worker/index";

const LEAGUE_ID = "1122334455";

const mockLeague = {
	league_id: LEAGUE_ID,
	name: "Type Coercion League",
};

const mockRosters = [
	{
		roster_id: 1,
		owner_id: "user_101",
		starters: ["4984"],
		players: ["4984", "9221"],
		settings: { wins: 8, losses: 5 },
	},
	{
		roster_id: 2,
		owner_id: "user_99",
		starters: ["8138", "7553"],
		players: ["8138", "7553"],
		settings: { wins: 6, losses: 7 },
	},
];

const mockUsers = [
	{
		user_id: "user_101",
		username: "gridiron_king",
		display_name: "Gridiron King",
		metadata: { team_name: "Apex Predators" },
	},
	{
		user_id: "99",
		username: "ninety_nine",
		display_name: "User Ninety Nine",
		metadata: { team_name: "Numeric Id Club" },
	},
];

function sleeperFetch(
	overrides: {
		usersBody?: unknown;
		rosters?: unknown;
	} = {},
): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.endsWith("/rosters")) {
			return Response.json(overrides.rosters ?? mockRosters);
		}
		if (url.endsWith("/users")) {
			return Response.json(overrides.usersBody ?? mockUsers);
		}
		if (url.includes("/league/")) {
			return Response.json(mockLeague);
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("mapSleeperPlayerIdToPlayer DST heuristic", () => {
	it("does not treat lowercase or 1-letter codes as defenses", () => {
		expect(mapSleeperPlayerIdToPlayer("BAL")).toMatchObject({
			name: "Baltimore Ravens",
			pos: "DST",
		});
		expect(mapSleeperPlayerIdToPlayer("bal")).toMatchObject({
			id: "p_bal",
			name: "Player #bal",
			pos: "FLEX",
			team: "NFL",
		});
		expect(mapSleeperPlayerIdToPlayer("ny")).toMatchObject({
			pos: "FLEX",
			name: "Player #ny",
		});
		expect(mapSleeperPlayerIdToPlayer("A")).toMatchObject({
			pos: "FLEX",
			name: "Player #A",
		});
	});
});

describe("Sleeper payload type coercion", () => {
	it("rejects a non-string leagueId before calling Sleeper", async () => {
		let called = false;
		const fetchImpl: typeof fetch = async () => {
			called = true;
			return new Response("should not run");
		};

		await expect(
			importSleeperRoster(
				{ leagueId: 1122334455 as unknown as string },
				fetchImpl,
			),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(SleeperApiError);
			expect((error as SleeperApiError).status).toBe(400);
			expect((error as SleeperApiError).message).toContain(
				"leagueId is required",
			);
			return true;
		});
		expect(called).toBe(false);
	});

	it("falls through to user_id when the numeric query matches no roster_id", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "99" },
			sleeperFetch(),
		);

		expect(roster.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
		expect(roster.teamName).toContain("Numeric Id Club");
		expect(roster.owner).toContain("User Ninety Nine");
	});

	it("throws a TypeError (not SleeperApiError) when userOrRosterId is a JSON number", async () => {
		await expect(
			importSleeperRoster(
				{
					leagueId: LEAGUE_ID,
					userOrRosterId: 2 as unknown as string,
				},
				sleeperFetch(),
			),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(TypeError);
			expect(error).not.toBeInstanceOf(SleeperApiError);
			return true;
		});
	});

	it("maps a JSON-number userOrRosterId on the HTTP import path to 500", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = sleeperFetch();
		try {
			const response = await worker.fetch(
				new Request(
					`https://example.com/api/fantasy/roster/sleeper-import?teamId=sleeper-num-${crypto.randomUUID()}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							leagueId: LEAGUE_ID,
							userOrRosterId: 2,
						}),
					},
				),
				env,
			);

			expect(response.status).toBe(500);
			const body = (await response.json()) as { error: string };
			expect(body.error.length).toBeGreaterThan(0);
			expect(body.error).not.toContain("leagueId is required");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not treat a non-array users payload as an empty owner list", async () => {
		await expect(
			importSleeperRoster(
				{ leagueId: LEAGUE_ID, userOrRosterId: "2" },
				sleeperFetch({ usersBody: { not: "an array" } }),
			),
		).rejects.toBeInstanceOf(TypeError);

		await expect(
			importSleeperRoster(
				{ leagueId: LEAGUE_ID },
				sleeperFetch({ usersBody: null }),
			),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("still starts listed players when the players array is omitted", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "1" },
			sleeperFetch({
				rosters: [
					{
						roster_id: 1,
						owner_id: "user_101",
						starters: ["4984", "8183"],
						players: null,
					},
				],
			}),
		);

		expect(roster.starters.map((s) => s.name)).toEqual([
			"Josh Allen",
			"Bijan Robinson",
		]);
		expect(roster.bench).toEqual([]);
	});
});
