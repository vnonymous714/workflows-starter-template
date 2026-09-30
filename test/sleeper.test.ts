import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
	SleeperApiError,
} from "../src/sleeper-client";
import type { CommandCenterState } from "../src/types/fantasy";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

const LEAGUE_ID = "1122334455";

const mockSleeperLeague = {
	league_id: LEAGUE_ID,
	name: "Champions League",
	total_rosters: 12,
	season: "2024",
};

const mockSleeperRosters = [
	{
		roster_id: 1,
		owner_id: "user_101",
		league_id: LEAGUE_ID,
		starters: ["4984", "8183", "7564", "4035", "11439", "BAL"],
		players: [
			"4984",
			"8183",
			"7564",
			"4035",
			"11439",
			"BAL",
			"9221",
			"9493",
			"8136",
		],
		settings: { wins: 8, losses: 5, ties: 0, fpts: 1420 },
	},
	{
		roster_id: 2,
		owner_id: "user_102",
		league_id: LEAGUE_ID,
		starters: ["8138", "7553"],
		players: ["8138", "7553", "7543"],
		settings: { wins: 6, losses: 7, ties: 0, fpts: 1310 },
	},
	{
		roster_id: 3,
		owner_id: "user_103",
		league_id: LEAGUE_ID,
		starters: ["0", "4984", "", "8183", "6797", "6801", "9226", "8155", "11439", "BAL", "9493", "8136"],
		players: ["4984", "8183", "6797", "6801", "9226", "8155", "11439", "BAL", "9493", "8136"],
		settings: { wins: 4, losses: 8, ties: 1 },
	},
	{
		roster_id: 4,
		owner_id: "missing_owner",
		league_id: LEAGUE_ID,
		starters: ["99999", "NYG"],
		players: ["99999", "NYG"],
	},
];

const mockSleeperUsers = [
	{
		user_id: "user_101",
		username: "gridiron_king",
		display_name: "Gridiron King",
		metadata: { team_name: "Apex Predators" },
	},
	{
		user_id: "user_102",
		username: "rival_boss",
		display_name: "Rival Boss",
	},
	{
		user_id: "user_103",
		username: "tie_game",
		display_name: "Tie Game",
	},
];

function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function createMockSleeperFetch(
	overrides: {
		league?: Response | Error;
		rosters?: Response | Error;
		users?: Response | Error;
		onLeagueUrl?: (url: string) => void;
	} = {},
): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.includes("/league/") && url.endsWith("/rosters")) {
			if (overrides.rosters instanceof Error) throw overrides.rosters;
			return overrides.rosters ?? jsonResponse(mockSleeperRosters);
		}
		if (url.includes("/league/") && url.endsWith("/users")) {
			if (overrides.users instanceof Error) throw overrides.users;
			return overrides.users ?? jsonResponse(mockSleeperUsers);
		}
		if (url.includes("/league/")) {
			overrides.onLeagueUrl?.(url);
			if (overrides.league instanceof Error) throw overrides.league;
			return overrides.league ?? jsonResponse(mockSleeperLeague);
		}
		return new Response("Not found", { status: 404 });
	};
}

async function expectSleeperError(
	fn: () => Promise<unknown>,
	status: number,
	message: string,
): Promise<void> {
	await expect(fn()).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(SleeperApiError);
		const sleeperError = error as SleeperApiError;
		expect(sleeperError.status).toBe(status);
		expect(sleeperError.message).toContain(message);
		return true;
	});
}

describe("mapSleeperPlayerIdToPlayer", () => {
	it("maps known players, prefixes ids, and lets lineup slots override position", () => {
		const allen = mapSleeperPlayerIdToPlayer("4984");
		expect(allen).toMatchObject({
			id: "p_4984",
			name: "Josh Allen",
			pos: "QB",
			team: "BUF",
			status: "ACTIVE",
		});

		const alreadyPrefixed = mapSleeperPlayerIdToPlayer("p_unknown");
		expect(alreadyPrefixed.id).toBe("p_unknown");
		expect(mapSleeperPlayerIdToPlayer("p_4984").name).toBe("Player #p_4984");

		const flexWr = mapSleeperPlayerIdToPlayer("7564", "FLEX");
		expect(flexWr.name).toBe("Ja'Marr Chase");
		expect(flexWr.pos).toBe("FLEX");
	});

	it("uses DST heuristics for 2-3 letter codes and a generic fallback otherwise", () => {
		const knownDst = mapSleeperPlayerIdToPlayer("BAL");
		expect(knownDst).toMatchObject({
			id: "p_BAL",
			name: "Baltimore Ravens",
			pos: "DST",
			team: "BAL",
		});

		const unknownDst = mapSleeperPlayerIdToPlayer("NYG");
		expect(unknownDst).toMatchObject({
			id: "p_NYG",
			name: "NYG Defense",
			pos: "DST",
			team: "NYG",
			tags: ["Sleeper Import"],
		});

		const unknownPlayer = mapSleeperPlayerIdToPlayer("99999");
		expect(unknownPlayer).toMatchObject({
			id: "p_99999",
			name: "Player #99999",
			pos: "FLEX",
			team: "NFL",
			projPts: 10.0,
			tags: ["Sleeper Import"],
		});

		const fourLetter = mapSleeperPlayerIdToPlayer("TEST");
		expect(fourLetter.pos).toBe("FLEX");
		expect(fourLetter.name).toBe("Player #TEST");
	});
});

describe("importSleeperRoster", () => {
	it("rejects missing or whitespace-only league ids before calling Sleeper", async () => {
		const fetchImpl = createMockSleeperFetch();
		await expectSleeperError(
			() => importSleeperRoster({ leagueId: "" }, fetchImpl),
			400,
			"leagueId is required",
		);
		await expectSleeperError(
			() => importSleeperRoster({ leagueId: "   " }, fetchImpl),
			400,
			"leagueId is required",
		);
	});

	it("maps league 404 vs other upstream failures, and empty rosters", async () => {
		await expectSleeperError(
			() =>
				importSleeperRoster(
					{ leagueId: LEAGUE_ID },
					createMockSleeperFetch({
						league: new Response("gone", { status: 404 }),
					}),
				),
			404,
			"Sleeper league not found (404)",
		);

		await expectSleeperError(
			() =>
				importSleeperRoster(
					{ leagueId: LEAGUE_ID },
					createMockSleeperFetch({
						league: new Response("boom", { status: 500 }),
					}),
				),
			502,
			"Sleeper league not found (500)",
		);

		await expectSleeperError(
			() =>
				importSleeperRoster(
					{ leagueId: LEAGUE_ID },
					createMockSleeperFetch({
						rosters: new Response("boom", { status: 503 }),
					}),
				),
			502,
			"Failed to fetch rosters (503)",
		);

		await expectSleeperError(
			() =>
				importSleeperRoster(
					{ leagueId: LEAGUE_ID },
					createMockSleeperFetch({ rosters: jsonResponse([]) }),
				),
			404,
			"No rosters found",
		);

		await expectSleeperError(
			() =>
				importSleeperRoster(
					{ leagueId: LEAGUE_ID },
					createMockSleeperFetch({
						rosters: jsonResponse({ not: "an array" }),
					}),
				),
			404,
			"No rosters found",
		);
	});

	it("trims league ids, survives a users-endpoint failure, and resolves owners", async () => {
		let leagueUrl = "";
		const roster = await importSleeperRoster(
			{ leagueId: `  ${LEAGUE_ID}  `, userOrRosterId: "  GRIDIRON_KING  " },
			createMockSleeperFetch({
				users: new Error("users unavailable"),
				onLeagueUrl: (url) => {
					leagueUrl = url;
				},
			}),
		);

		expect(leagueUrl).toBe(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`);
		expect(roster.teamId).toBe(`sleeper_${LEAGUE_ID}_1`);
		expect(roster.teamName).toBe("Team 1 (Champions League)");
		expect(roster.owner).toBe("Sleeper Manager (Sleeper)");
		expect(roster.record).toBe("8-5");
	});

	it("resolves roster by numeric id, user id, display name, or first-roster fallback", async () => {
		const byNumber = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "2" },
			createMockSleeperFetch(),
		);
		expect(byNumber.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
		expect(byNumber.owner).toContain("Rival Boss");
		expect(byNumber.teamName).toContain("Rival Boss");

		const byUserId = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "user_102" },
			createMockSleeperFetch(),
		);
		expect(byUserId.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);

		const byDisplayName = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "RIVAL BOSS" },
			createMockSleeperFetch(),
		);
		expect(byDisplayName.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);

		const byTrimmedUsername = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "  rival_boss  " },
			createMockSleeperFetch(),
		);
		expect(byTrimmedUsername.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);

		const unknownFallsBack = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "nobody" },
			createMockSleeperFetch(),
		);
		expect(unknownFallsBack.teamId).toBe(`sleeper_${LEAGUE_ID}_1`);

		const omittedFallsBack = await importSleeperRoster(
			{ leagueId: LEAGUE_ID },
			createMockSleeperFetch(),
		);
		expect(omittedFallsBack.teamId).toBe(`sleeper_${LEAGUE_ID}_1`);
	});

	it("formats tied records, unnamed leagues, and missing owner metadata", async () => {
		const tied = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "3" },
			createMockSleeperFetch(),
		);
		expect(tied.record).toBe("4-8-1");
		expect(tied.rank).toBe(3);

		const unnamed = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "4" },
			createMockSleeperFetch({
				league: jsonResponse({ league_id: LEAGUE_ID }),
			}),
		);
		expect(unnamed.teamName).toBe("Team 4 (Sleeper League)");
		expect(unnamed.owner).toBe("Sleeper Manager (Sleeper)");
		expect(unnamed.record).toBe("0-0");
	});

	it("drops empty starter slots, assigns sequential lineup positions, and keeps unknown ids", async () => {
		const roster = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "3" },
			createMockSleeperFetch(),
		);

		expect(roster.starters.map((s) => s.id)).toEqual([
			"p_4984",
			"p_8183",
			"p_6797",
			"p_6801",
			"p_9226",
			"p_8155",
			"p_11439",
			"p_BAL",
			"p_9493",
			"p_8136",
		]);
		expect(roster.starters.map((s) => s.pos)).toEqual([
			"QB",
			"RB",
			"RB",
			"WR",
			"WR",
			"TE",
			"FLEX",
			"K",
			"DST",
			"FLEX",
		]);
		expect(roster.bench).toEqual([]);

		const unknowns = await importSleeperRoster(
			{ leagueId: LEAGUE_ID, userOrRosterId: "4" },
			createMockSleeperFetch(),
		);
		expect(unknowns.starters[0]).toMatchObject({
			name: "Player #99999",
			pos: "QB",
		});
		expect(unknowns.starters[1]).toMatchObject({
			name: "NYG Defense",
			pos: "RB",
		});
	});
});

describe("Sleeper HTTP and Durable Object contracts", () => {
	it("maps worker/DO import failures without calling Sleeper", async () => {
		const emptyLeague = await worker.fetch(
			new Request(
				"https://example.com/api/fantasy/roster/sleeper-import?teamId=sleeper-empty-league",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ leagueId: "   " }),
				},
			),
			env,
		);
		expect(emptyLeague.status).toBe(400);
		await expect(emptyLeague.json()).resolves.toEqual({
			error: "Sleeper leagueId is required",
		});

		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName("sleeper-bad-json"),
		);
		const badJson = await stub.fetch("https://do/roster/sleeper-import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});
		expect(badJson.status).toBe(500);
		const badBody = (await badJson.json()) as { error: string };
		expect(badBody.error.length).toBeGreaterThan(0);

		const wrongMethod = await stub.fetch("https://do/roster/sleeper-import");
		expect(wrongMethod.status).toBe(400);
		expect(await wrongMethod.text()).toBe(
			"Expected WebSocket or API route",
		);
	});

	it("imports through HTTP, maps upstream 404, and persists across eviction", async () => {
		const teamId = `sleeper-http-${crypto.randomUUID()}`;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = createMockSleeperFetch();

		try {
			const imported = await worker.fetch(
				new Request(
					`https://example.com/api/fantasy/roster/sleeper-import?teamId=${teamId}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							leagueId: LEAGUE_ID,
							userOrRosterId: "2",
						}),
					},
				),
				env,
			);
			expect(imported.status).toBe(200);
			const body = (await imported.json()) as CommandCenterState;
			expect(body.activeRoster.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
			expect(body.activeRoster.starters[0]?.name).toBe("Kyren Williams");
			expect(body.liveAlerts[0]?.type).toBe("LINEUP");
			expect(body.liveAlerts[0]?.message).toContain("Sleeper Roster Imported");

			const stub = env.WORKFLOW_STATUS.get(
				env.WORKFLOW_STATUS.idFromName(teamId),
			);
			await evictDurableObject(stub);
			const restored = await stub.getFantasyState();
			expect(restored.activeRoster.teamId).toBe(`sleeper_${LEAGUE_ID}_2`);
			expect(restored.activeRoster.owner).toContain("Rival Boss");
		} finally {
			globalThis.fetch = originalFetch;
		}

		const missingTeamId = `sleeper-404-${crypto.randomUUID()}`;
		globalThis.fetch = createMockSleeperFetch({
			league: new Response("gone", { status: 404 }),
		});
		try {
			const missing = await worker.fetch(
				new Request(
					`https://example.com/api/fantasy/roster/sleeper-import?teamId=${missingTeamId}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ leagueId: LEAGUE_ID }),
					},
				),
				env,
			);
			expect(missing.status).toBe(404);
			await expect(missing.json()).resolves.toEqual({
				error: "Sleeper league not found (404)",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("broadcasts the imported roster on connected fantasy sockets", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`sleeper-ws-${crypto.randomUUID()}`),
		);
		const response = await stub.fetch("https://example.com/", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const imported = new Promise<CommandCenterState>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for sleeper broadcast")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				const data = JSON.parse(event.data as string) as {
					type: string;
					payload?: CommandCenterState;
				};
				if (
					data.type === "fantasy_update" &&
					data.payload?.activeRoster.teamName.includes("Apex Predators")
				) {
					clearTimeout(timer);
					resolve(data.payload);
				}
			});
		});

		socket.accept();
		await runInDurableObject(stub, async (instance: WorkflowStatusDO) => {
			return instance.importSleeper(
				LEAGUE_ID,
				"gridiron_king",
				createMockSleeperFetch(),
			);
		});

		const payload = await imported;
		socket.close(1000, "done");
		expect(payload.activeRoster.starters.map((s) => s.name)).toContain(
			"Josh Allen",
		);
		expect(payload.liveAlerts[0]?.severity).toBe("success");
	});
});
