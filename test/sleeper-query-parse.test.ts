import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	importSleeperRoster,
	SleeperApiError,
	type SleeperRosterRaw,
	type SleeperUserRaw,
} from "../src/sleeper-client";
import worker from "../worker/index";

const LEAGUE_ID = "1122334455";

const defaultRosters: SleeperRosterRaw[] = [
	{
		roster_id: 1,
		owner_id: "owner_a",
		starters: ["4984"],
		players: ["4984"],
		settings: { wins: 8, losses: 5 },
	},
	{
		roster_id: 2,
		owner_id: "owner_b",
		starters: ["8183"],
		players: ["8183"],
		settings: { wins: 6, losses: 7 },
	},
];

const defaultUsers: SleeperUserRaw[] = [
	{
		user_id: "owner_a",
		username: "first_manager",
		display_name: "First Manager",
		metadata: { team_name: "Alpha Club" },
	},
	{
		user_id: "owner_b",
		username: "second_manager",
		display_name: "Second Manager",
		metadata: { team_name: "Beta Club" },
	},
];

function sleeperFetch(
	overrides: {
		rosters?: SleeperRosterRaw[];
		users?: SleeperUserRaw[] | Response | Error;
		leagueBody?: BodyInit;
		leagueStatus?: number;
		leagueContentType?: string;
		throwOnRosters?: Error;
	} = {},
): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.endsWith("/rosters")) {
			if (overrides.throwOnRosters) {
				throw overrides.throwOnRosters;
			}
			return Response.json(overrides.rosters ?? defaultRosters);
		}
		if (url.endsWith("/users")) {
			if (overrides.users instanceof Error) {
				throw overrides.users;
			}
			if (overrides.users instanceof Response) {
				return overrides.users;
			}
			return Response.json(overrides.users ?? defaultUsers);
		}
		if (url.includes("/league/")) {
			if (overrides.leagueBody !== undefined) {
				return new Response(overrides.leagueBody, {
					status: overrides.leagueStatus ?? 200,
					headers: {
						"Content-Type":
							overrides.leagueContentType ?? "application/json",
					},
				});
			}
			return Response.json({
				league_id: LEAGUE_ID,
				name: "Query Parse League",
			});
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("Sleeper userOrRosterId parseInt collisions", () => {
	it("treats prefixed, decimal, and zero-padded queries as roster_id 2", async () => {
		const fetchImpl = sleeperFetch();

		const prefixed = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "2abc" },
			fetchImpl,
		);
		expect(prefixed.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
		expect(prefixed.starters.map((p) => p.name)).toEqual(["Bijan Robinson"]);

		const decimal = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "2.9" },
			fetchImpl,
		);
		expect(decimal.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);

		const padded = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "02" },
			fetchImpl,
		);
		expect(padded.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
		expect(padded.teamName).toContain("Beta Club");
	});

	it("falls back to the first roster when a matched user owns no roster", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "orphan_manager" },
			sleeperFetch({
				users: [
					...defaultUsers,
					{
						user_id: "orphan",
						username: "orphan_manager",
						display_name: "Orphan Manager",
					},
				],
			}),
		);

		expect(roster.teamId).toBe(`sleeper_${LEAGUE_ID}_1`);
		expect(roster.owner).toContain("First Manager");
		expect(roster.starters.map((p) => p.name)).toEqual(["Josh Allen"]);
	});

	it("treats a whitespace-only userOrRosterId as unspecified", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "   " },
			sleeperFetch(),
		);

		expect(roster.teamId).toBe(`sleeper_${LEAGUE_ID}_1`);
		expect(roster.teamName).toContain("Alpha Club");
	});
});

describe("Sleeper users endpoint and owner fallbacks", () => {
	it("treats a users HTTP 4xx as empty owners instead of failing the import", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "2" },
			sleeperFetch({
				users: new Response("gone", { status: 404 }),
			}),
		);

		expect(roster.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
		expect(roster.teamName).toBe("Team 2 (Query Parse League)");
		expect(roster.owner).toBe("Sleeper Manager (Sleeper)");
	});

	it("uses an empty users array as Team N without throwing", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID },
			sleeperFetch({ users: [] }),
		);

		expect(roster.teamId).toBe(`sleeper_${LEAGUE_ID}_1`);
		expect(roster.teamName).toBe("Team 1 (Query Parse League)");
		expect(roster.owner).toBe("Sleeper Manager (Sleeper)");
	});

	it("falls through an empty team_name to display_name, then username", async () => {
		const emptyTeamName = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "1" },
			sleeperFetch({
				users: [
					{
						user_id: "owner_a",
						username: "first_manager",
						display_name: "First Manager",
						metadata: { team_name: "" },
					},
					defaultUsers[1],
				],
			}),
		);
		expect(emptyTeamName.teamName).toContain("First Manager");
		expect(emptyTeamName.owner).toBe("First Manager (Sleeper)");

		const usernameOnly = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "2" },
			sleeperFetch({
				users: [
					defaultUsers[0],
					{
						user_id: "owner_b",
						username: "second_manager",
					},
				],
			}),
		);
		expect(usernameOnly.teamName).toContain("second_manager");
		expect(usernameOnly.owner).toBe("second_manager (Sleeper)");
	});
});

describe("Sleeper transport parse failures", () => {
	it("does not wrap a thrown roster fetch as SleeperApiError", async () => {
		const pending = importSleeperRoster(
			{ leagueId: LEAGUE_ID },
			sleeperFetch({ throwOnRosters: new Error("rosters socket reset") }),
		);

		await expect(pending).rejects.toThrow("rosters socket reset");
		await expect(pending).rejects.not.toBeInstanceOf(SleeperApiError);
	});

	it("maps a 200 non-JSON league body on the HTTP import path to 500", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = sleeperFetch({
			leagueBody: "<html>sleeper outage</html>",
			leagueContentType: "text/html",
		});

		try {
			const response = await worker.fetch(
				new Request(
					`https://example.com/api/fantasy/roster/sleeper-import?teamId=sleeper-html-${crypto.randomUUID()}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ leagueId: LEAGUE_ID }),
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
});
