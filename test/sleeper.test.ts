import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
	buildCommandCenterState,
	pickDefaultMatchup,
} from "../src/fantasy-intel";
import {
	importSleeperRoster,
	mapSleeperInjuryStatus,
	mapSleeperPosition,
	SleeperRequestError,
	SLEEPER_API_BASE,
} from "../src/sleeper-client";
import type { WorkflowStatusDO } from "../worker/durable-object";

const PLAYERS = {
	"4046": {
		player_id: "4046",
		full_name: "Josh Allen",
		position: "QB",
		team: "BUF",
		injury_status: null,
	},
	"4866": {
		player_id: "4866",
		full_name: "Saquon Barkley",
		position: "RB",
		team: "PHI",
		injury_status: null,
	},
	"6794": {
		player_id: "6794",
		full_name: "Kyren Williams",
		position: "RB",
		team: "LAR",
		injury_status: "Questionable",
		injury_body_part: "Ankle",
	},
	"5849": {
		player_id: "5849",
		full_name: "Ja'Marr Chase",
		position: "WR",
		team: "CIN",
		injury_status: null,
	},
	"8134": {
		player_id: "8134",
		full_name: "Jaylen Waddle",
		position: "WR",
		team: "MIA",
		injury_status: null,
	},
	"4039": {
		player_id: "4039",
		full_name: "George Kittle",
		position: "TE",
		team: "SF",
		injury_status: null,
	},
	"4227": {
		player_id: "4227",
		full_name: "Brandon Aubrey",
		position: "K",
		team: "DAL",
		injury_status: null,
	},
	"BAL": {
		player_id: "BAL",
		first_name: "Baltimore",
		last_name: "Ravens",
		position: "DEF",
		team: "BAL",
		injury_status: null,
	},
	"8154": {
		player_id: "8154",
		full_name: "Zach Charbonnet",
		position: "RB",
		team: "SEA",
		injury_status: null,
	},
	"8146": {
		player_id: "8146",
		full_name: "Jaxon Smith-Njigba",
		position: "WR",
		team: "SEA",
		injury_status: null,
	},
	"8121": {
		player_id: "8121",
		full_name: "Tyler Allgeier",
		position: "RB",
		team: "ATL",
		injury_status: null,
	},
	"8111": {
		player_id: "8111",
		full_name: "Jake Ferguson",
		position: "TE",
		team: "DAL",
		injury_status: null,
	},
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mockSleeperFetch(): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url === `${SLEEPER_API_BASE}/state/nfl`) {
			return jsonResponse({
				week: 1,
				display_week: 1,
				season: "2026",
				league_season: "2026",
			});
		}
		if (url === `${SLEEPER_API_BASE}/user/ghost`) {
			return jsonResponse(null);
		}
		if (url === `${SLEEPER_API_BASE}/user/missing`) {
			return new Response("not found", { status: 404 });
		}
		if (url === `${SLEEPER_API_BASE}/user/gridiron`) {
			return jsonResponse({
				user_id: "user_gridiron",
				username: "gridiron",
				display_name: "Gridiron GM",
			});
		}
		if (url === `${SLEEPER_API_BASE}/user/copilot`) {
			return jsonResponse({
				user_id: "user_copilot",
				username: "copilot",
				display_name: "Co Pilot",
			});
		}
		if (url === `${SLEEPER_API_BASE}/user/spectator`) {
			return jsonResponse({
				user_id: "user_spectator",
				username: "spectator",
				display_name: "League Spectator",
			});
		}
		if (
			url === `${SLEEPER_API_BASE}/user/user_gridiron/leagues/nfl/2026` ||
			url === `${SLEEPER_API_BASE}/user/user_copilot/leagues/nfl/2026` ||
			url === `${SLEEPER_API_BASE}/user/user_spectator/leagues/nfl/2026`
		) {
			return jsonResponse([
				{
					league_id: "lg_pulse",
					name: "Sunday Night Circuit",
					roster_positions: [
						"QB",
						"RB",
						"RB",
						"WR",
						"WR",
						"TE",
						"FLEX",
						"K",
						"DEF",
						"BN",
						"BN",
						"BN",
						"BN",
					],
					season: "2026",
				},
			]);
		}
		if (url === `${SLEEPER_API_BASE}/league/lg_pulse/rosters`) {
			return jsonResponse([
				{
					roster_id: 7,
					owner_id: "user_gridiron",
					starters: [
						"4046",
						"4866",
						"6794",
						"5849",
						"8134",
						"4039",
						"0",
						"4227",
						"BAL",
					],
					players: [
						"4046",
						"4866",
						"6794",
						"5849",
						"8134",
						"4039",
						"4227",
						"BAL",
						"8154",
						"8146",
						"8121",
						"8111",
					],
					settings: { wins: 1, losses: 0, fpts: 128.4 },
				},
				{
					roster_id: 2,
					owner_id: "someone_else",
					co_owners: ["user_copilot"],
					players: ["4046"],
					starters: ["4046"],
					settings: { wins: 0, losses: 1, fpts: 90 },
				},
			]);
		}
		if (url === `${SLEEPER_API_BASE}/league/lg_pulse/users`) {
			return jsonResponse([
				{
					user_id: "user_gridiron",
					display_name: "Gridiron GM",
					metadata: { team_name: "Live Pulse" },
				},
				{
					user_id: "someone_else",
					display_name: "Other Manager",
					metadata: { team_name: "Rival Squad" },
				},
				{
					user_id: "user_copilot",
					display_name: "Co Pilot",
				},
			]);
		}
		if (url === `${SLEEPER_API_BASE}/players/nfl`) {
			return jsonResponse(PLAYERS);
		}
		if (url.includes("site.api.espn.com")) {
			return jsonResponse({
				events: [
					{
						weather: { temperature: 27, displayValue: "Windy" },
						competitions: [
							{
								venue: {
									indoor: false,
									fullName: "Highmark Stadium",
									address: { city: "Orchard Park" },
								},
								competitors: [
									{
										homeAway: "home",
										team: { abbreviation: "BUF" },
									},
									{
										homeAway: "away",
										team: { abbreviation: "LAR" },
									},
								],
							},
						],
					},
				],
			});
		}
		if (url.includes("api.weather.gov/points/")) {
			return jsonResponse({
				properties: {
					forecastHourly:
						"https://api.weather.gov/gridpoints/BUF/39,42/forecast/hourly",
				},
			});
		}
		if (url.includes("api.weather.gov/gridpoints/")) {
			return jsonResponse({
				properties: {
					periods: [
						{
							temperature: 27,
							windSpeed: "18 mph",
							windGust: "28 mph",
							shortForecast: "Windy",
							probabilityOfPrecipitation: { value: 45 },
						},
					],
				},
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	};
}

describe("Sleeper mapping helpers", () => {
	it("maps injury and position codes", () => {
		expect(mapSleeperInjuryStatus("Questionable")).toBe("QUESTIONABLE");
		expect(mapSleeperInjuryStatus("OUT")).toBe("OUT");
		expect(mapSleeperInjuryStatus(null)).toBe("ACTIVE");
		expect(mapSleeperPosition("DEF")).toBe("DST");
		expect(mapSleeperPosition("RB")).toBe("RB");
		expect(mapSleeperPosition("SUPER_FLEX")).toBe("FLEX");
	});

	it("keeps Kyren vs Charbonnet on the seed roster", () => {
		const matchup = pickDefaultMatchup(buildCommandCenterState().activeRoster);
		expect(matchup.starterId).toBe("p_kyren");
		expect(matchup.benchId).toBe("p_charbonnet");
	});
});

describe("importSleeperRoster", () => {
	it("rejects a blank username", async () => {
		await expect(importSleeperRoster({ username: "  " })).rejects.toMatchObject({
			code: "SLEEPER_USERNAME_REQUIRED",
		});
	});

	it("returns a clear error when the Sleeper user does not exist", async () => {
		await expect(
			importSleeperRoster({ username: "missing" }, mockSleeperFetch()),
		).rejects.toBeInstanceOf(SleeperRequestError);
		await expect(
			importSleeperRoster({ username: "ghost" }, mockSleeperFetch()),
		).rejects.toMatchObject({ code: "SLEEPER_USER_NOT_FOUND" });
	});

	it("maps a live roster, week, injuries, and NFL opponent", async () => {
		const result = await importSleeperRoster(
			{ username: "gridiron" },
			mockSleeperFetch(),
		);

		expect(result.week).toBe(1);
		expect(result.roster.teamName).toBe("Live Pulse");
		expect(result.roster.owner).toBe("Gridiron GM");
		expect(result.roster.record).toBe("1-0");
		expect(result.roster.rank).toBe(1);
		expect(result.roster.source?.provider).toBe("sleeper");
		expect(result.roster.source?.rosterId).toBe(7);
		expect(result.roster.source?.leagueName).toBe("Sunday Night Circuit");
		expect(result.roster.teamName).not.toBe("Neural Gridiron Pulse");
		expect(result.roster.starters.map((player) => player.name)).toContain(
			"Kyren Williams",
		);
		expect(result.roster.starters.some((player) => player.id === "0")).toBe(
			false,
		);
		expect(result.roster.bench.map((player) => player.name)).toContain(
			"Zach Charbonnet",
		);

		const kyren = result.roster.starters.find((player) => player.id === "6794");
		expect(kyren?.status).toBe("QUESTIONABLE");
		expect(kyren?.pos).toBe("RB");
		expect(kyren?.opp).toBe("@ BUF");
		expect(kyren?.weatherCondition).toContain("PASS-FADE");
		expect(result.weather.some((wx) => wx.weatherTag === "PASS-FADE")).toBe(
			true,
		);
		const kicker = result.roster.starters.find((player) => player.id === "4227");
		expect(kicker?.pos).toBe("K");
		expect(result.injuries.some((item) => item.playerId === "6794")).toBe(true);
		const matchup = pickDefaultMatchup(result.roster);
		expect(matchup.starterId).toBe("6794");
		expect(matchup.benchId).toBe("8154");
	});

	it("imports the roster when the user is listed as a co-owner", async () => {
		const result = await importSleeperRoster(
			{ username: "copilot" },
			mockSleeperFetch(),
		);

		expect(result.roster.source?.rosterId).toBe(2);
		expect(result.roster.teamName).toBe("Rival Squad");
		expect(result.roster.starters.map((player) => player.id)).toEqual(["4046"]);
	});

	it("returns not-found when no roster is owned or co-owned by the user", async () => {
		await expect(
			importSleeperRoster({ username: "spectator" }, mockSleeperFetch()),
		).rejects.toMatchObject({
			code: "SLEEPER_ROSTER_NOT_FOUND",
			status: 404,
		});
	});
});

describe("WorkflowStatusDO Sleeper import", () => {
	it("replaces the demo roster and drops canned beat intel", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_sleeper_import");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const before = await stub.getFantasyState();
		expect(before.activeRoster.teamName).toBe("Neural Gridiron Pulse");
		expect(before.selectedWeek).toBe(14);

		const after = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				return instance.importRoster(
					{ username: "gridiron" },
					{ fetchImpl: mockSleeperFetch() },
				);
			},
		);

		expect(after.selectedWeek).toBe(1);
		expect(after.activeRoster.teamName).toBe("Live Pulse");
		expect(after.activeRoster.starters).toHaveLength(8);
		expect(after.intelPacket.beatReports).toHaveLength(0);
		expect(after.intelPacket.weather.length).toBeGreaterThan(0);
		expect(after.recommendations).toHaveLength(0);
		expect(after.liveAlerts.some((alert) => alert.type === "LINEUP")).toBe(true);
		expect(after.liveAlerts.some((alert) => alert.message.includes("Live Pulse"))).toBe(
			true,
		);

		const persisted = await stub.getFantasyState();
		expect(persisted.activeRoster.source?.provider).toBe("sleeper");
		expect(persisted.intelPacket.hash).toContain("sleeper_");

		const refreshed = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				return instance.refreshIntel({ fetchImpl: mockSleeperFetch() });
			},
		);
		expect(refreshed.activeRoster.teamName).toBe("Live Pulse");
		expect(refreshed.liveAlerts[0].message).toContain("Re-synced");
	});

	it("returns 400 when the import body has no username", async () => {
		const doId = env.WORKFLOW_STATUS.idFromName("test_sleeper_blank_user");
		const stub = env.WORKFLOW_STATUS.get(doId);

		const res = await stub.fetch("https://do/roster/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "   " }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("SLEEPER_USERNAME_REQUIRED");
	});
});
