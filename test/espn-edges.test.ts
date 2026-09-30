import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	buildEspnApiUrl,
	buildEspnCookieHeader,
	EspnRequestError,
	fetchEspnLeagueData,
	MissingEspnCredentialsError,
	sanitizeEspnTeamRoster,
	type EspnRawLeagueResponse,
	type EspnRawPlayerEntry,
	type EspnRawTeam,
} from "../src/espn-client";
import type { WorkflowStatusDO } from "../worker/durable-object";
import worker from "../worker/index";

function playerEntry(
	overrides: {
		lineupSlotId: number;
		id: number;
		fullName: string;
		defaultPositionId?: number;
		proTeamId?: number;
		injuryStatus?: string;
		injured?: boolean;
		appliedStatTotal?: number | string | null;
		omitPlayer?: boolean;
		omitPool?: boolean;
	},
): EspnRawPlayerEntry {
	if (overrides.omitPool) {
		return { lineupSlotId: overrides.lineupSlotId };
	}
	return {
		lineupSlotId: overrides.lineupSlotId,
		playerPoolEntry: {
			appliedStatTotal: overrides.appliedStatTotal as number | undefined,
			player: overrides.omitPlayer
				? undefined
				: {
						id: overrides.id,
						fullName: overrides.fullName,
						defaultPositionId: overrides.defaultPositionId ?? 2,
						proTeamId: overrides.proTeamId ?? 2,
						injuryStatus: overrides.injuryStatus,
						injured: overrides.injured,
					},
		},
	};
}

function league(
	overrides: Partial<EspnRawLeagueResponse> & {
		teams?: EspnRawTeam[];
	} = {},
): EspnRawLeagueResponse {
	const defaultTeam: EspnRawTeam = {
		id: 1,
		location: "Gridiron",
		nickname: "Dynasty",
		primaryOwner: "{OWNER-1}",
		record: { overall: { wins: 10, losses: 3, ties: 0 } },
		playoffSeed: 1,
		roster: {
			entries: [
				playerEntry({
					lineupSlotId: 0,
					id: 1,
					fullName: "Josh Allen",
					defaultPositionId: 1,
					proTeamId: 2,
					appliedStatTotal: 24.5,
				}),
			],
		},
	};

	return {
		id: 12345678,
		seasonId: 2024,
		scoringPeriodId: 14,
		members: [
			{
				id: "{OWNER-1}",
				displayName: "Commissioner Dave",
			},
		],
		...overrides,
		teams: overrides.teams ?? [defaultTeam],
	};
}

const TWO_TEAM_LEAGUE: EspnRawLeagueResponse = league({
	teams: [
		{
			id: 1,
			name: "Alpha Club",
			primaryOwner: "{OWNER-1}",
			roster: {
				entries: [
					playerEntry({
						lineupSlotId: 0,
						id: 11,
						fullName: "Alpha QB",
						defaultPositionId: 1,
					}),
				],
			},
		},
		{
			id: 2,
			name: "Beta Club",
			primaryOwner: "{OWNER-2}",
			roster: {
				entries: [
					playerEntry({
						lineupSlotId: 2,
						id: 22,
						fullName: "Beta RB",
						defaultPositionId: 2,
					}),
				],
			},
		},
	],
	members: [
		{ id: "{OWNER-1}", displayName: "Alpha Owner" },
		{ id: "{OWNER-2}", displayName: "Beta Owner" },
	],
});

function espnFetch(
	body: unknown,
	status = 200,
	contentType = "application/json",
): typeof fetch {
	return async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": contentType },
		});
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("ESPN cookie / URL / fetch edges", () => {
	it("trims padded cookies and omits a missing half of the pair", () => {
		expect(buildEspnCookieHeader("  s2_token  ", "  {SWID}  ")).toBe(
			"espn_s2=s2_token; SWID={SWID}",
		);
		expect(buildEspnCookieHeader("only_s2")).toBe("espn_s2=only_s2");
		expect(buildEspnCookieHeader(undefined, "{ONLY_SWID}")).toBe(
			"SWID={ONLY_SWID}",
		);
		// Whitespace is truthy, so the cookie is still emitted after trim.
		expect(buildEspnCookieHeader("   ", "  ")).toBe("espn_s2=; SWID=");
	});

	it("defaults season to 2024 and accepts a numeric leagueId", async () => {
		expect(buildEspnApiUrl(2024, 99)).toContain("/seasons/2024/");
		expect(buildEspnApiUrl(2024, 99)).toContain("/leagues/99?");

		let capturedUrl = "";
		await fetchEspnLeagueData({
			leagueId: 87654321,
			fetchImpl: async (input) => {
				capturedUrl = String(input);
				return espnFetch({ id: 1, teams: [] })(input);
			},
		});
		expect(capturedUrl).toContain("/seasons/2024/segments/0/leagues/87654321");
	});

	it("treats numeric leagueId 0 as missing credentials", async () => {
		await expect(
			fetchEspnLeagueData({ leagueId: 0, fetchImpl: espnFetch({}) }),
		).rejects.toBeInstanceOf(MissingEspnCredentialsError);
	});

	it("maps 403 to ESPN_AUTH_UNAUTHORIZED and other HTTP errors to ESPN_REQUEST_FAILED", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "1",
				fetchImpl: espnFetch("Forbidden", 403),
			}),
		).rejects.toMatchObject({
			code: "ESPN_AUTH_UNAUTHORIZED",
			status: 403,
			name: "EspnRequestError",
		});

		await expect(
			fetchEspnLeagueData({
				leagueId: "1",
				fetchImpl: espnFetch("gone", 404),
			}),
		).rejects.toMatchObject({
			code: "ESPN_REQUEST_FAILED",
			status: 404,
		});

		await expect(
			fetchEspnLeagueData({
				leagueId: "1",
				fetchImpl: espnFetch("boom", 500),
			}),
		).rejects.toMatchObject({
			code: "ESPN_REQUEST_FAILED",
			status: 500,
		});
	});

	it("wraps thrown fetches and non-JSON 200 bodies as ESPN_REQUEST_FAILED / ESPN_INVALID_RESPONSE", async () => {
		await expect(
			fetchEspnLeagueData({
				leagueId: "1",
				fetchImpl: async () => {
					throw new Error("dns failed");
				},
			}),
		).rejects.toMatchObject({
			code: "ESPN_REQUEST_FAILED",
			message: expect.stringContaining("dns failed"),
		});

		await expect(
			fetchEspnLeagueData({
				leagueId: "1",
				fetchImpl: async () => {
					throw "socket reset";
				},
			}),
		).rejects.toBeInstanceOf(EspnRequestError);

		await expect(
			fetchEspnLeagueData({
				leagueId: "1",
				fetchImpl: espnFetch("<html>not json</html>", 200, "text/html"),
			}),
		).rejects.toMatchObject({
			code: "ESPN_INVALID_RESPONSE",
			message: "Failed to parse ESPN API response as JSON.",
		});
	});
});

describe("sanitizeEspnTeamRoster slot, injury, and identity edges", () => {
	it("rejects missing, empty, and non-array teams payloads", () => {
		expect(() =>
			sanitizeEspnTeamRoster({ id: 1, seasonId: 2024 } as EspnRawLeagueResponse),
		).toThrow(EspnRequestError);
		expect(() =>
			sanitizeEspnTeamRoster({
				id: 1,
				seasonId: 2024,
				teams: [],
			}),
		).toThrow(/no teams found/);

		try {
			sanitizeEspnTeamRoster({
				id: 1,
				seasonId: 2024,
				teams: { id: 1 } as unknown as EspnRawTeam[],
			});
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toMatchObject({ code: "ESPN_INVALID_RESPONSE" });
		}
	});

	it("selects a team by string id and falls back to the first team when unmatched", () => {
		const matched = sanitizeEspnTeamRoster(TWO_TEAM_LEAGUE, "2");
		expect(matched.roster.teamId).toBe("espn_team_2");
		expect(matched.roster.teamName).toBe("Beta Club");
		expect(matched.roster.starters[0]?.name).toBe("Beta RB");

		const fallback = sanitizeEspnTeamRoster(TWO_TEAM_LEAGUE, "missing");
		expect(fallback.roster.teamId).toBe("espn_team_1");
		expect(fallback.roster.teamName).toBe("Alpha Club");

		const omitted = sanitizeEspnTeamRoster(TWO_TEAM_LEAGUE);
		expect(omitted.roster.teamId).toBe("espn_team_1");
	});

	it("resolves team name, owner, record, and rank fallbacks", () => {
		const named = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 7,
						name: "Official Name",
						location: "Should",
						nickname: "Ignore",
					},
				],
			}),
		);
		expect(named.roster.teamName).toBe("Official Name");
		expect(named.roster.owner).toBe("ESPN Team Owner");
		expect(named.roster.record).toBe("0-0");
		expect(named.roster.rank).toBe(1);

		const composed = sanitizeEspnTeamRoster(
			league({
				teams: [{ id: 8, location: "Lake", nickname: "Monsters" }],
			}),
		);
		expect(composed.roster.teamName).toBe("Lake Monsters");

		const locationOnly = sanitizeEspnTeamRoster(
			league({
				teams: [{ id: 9, location: "Orphans" }],
			}),
		);
		expect(locationOnly.roster.teamName).toBe("ESPN Team 9");

		const ownerFromOwnersArray = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 3,
						owners: ["{OWNER-1}"],
						name: "Owned",
					},
				],
			}),
		);
		expect(ownerFromOwnersArray.roster.owner).toBe("Commissioner Dave");

		const nameFromParts = sanitizeEspnTeamRoster(
			league({
				members: [
					{
						id: "{OWNER-1}",
						displayName: "",
						firstName: "Pat",
						lastName: "Mahomes",
					},
				],
			}),
		);
		expect(nameFromParts.roster.owner).toBe("Pat Mahomes");

		const blankMemberName = sanitizeEspnTeamRoster(
			league({
				members: [
					{
						id: "{OWNER-1}",
						displayName: "",
						firstName: "",
						lastName: "",
					},
				],
			}),
		);
		expect(blankMemberName.roster.owner).toBe("ESPN Team Owner");

		const tied = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 1,
						name: "Tied",
						record: { overall: { wins: 5, losses: 5, ties: 1 } },
						playoffSeed: 4,
					},
				],
			}),
		);
		expect(tied.roster.record).toBe("5-5-1");
		expect(tied.roster.rank).toBe(4);
	});

	it("maps starter slots, bench/IR, unknown slots, and default positions", () => {
		const { roster } = sanitizeEspnTeamRoster(
			league({
				teams: [
					{
						id: 1,
						name: "Slots",
						roster: {
							entries: [
								playerEntry({
									lineupSlotId: 23,
									id: 100,
									fullName: "Flex WR",
									defaultPositionId: 3,
									proTeamId: 26,
									appliedStatTotal: 15.1,
								}),
								playerEntry({
									lineupSlotId: 16,
									id: 101,
									fullName: "Ravens D",
									defaultPositionId: 16,
									proTeamId: 33,
								}),
								playerEntry({
									lineupSlotId: 17,
									id: 102,
									fullName: "Aubrey",
									defaultPositionId: 5,
									proTeamId: 6,
								}),
								playerEntry({
									lineupSlotId: 21,
									id: 103,
									fullName: "IR Back",
									defaultPositionId: 2,
									injuryStatus: "IR",
								}),
								playerEntry({
									lineupSlotId: 99,
									id: 104,
									fullName: "Unknown Slot WR",
									defaultPositionId: 3,
									proTeamId: 21,
								}),
								playerEntry({
									lineupSlotId: 20,
									id: 105,
									fullName: "Unknown Pos",
									defaultPositionId: 99,
									proTeamId: 99,
								}),
								playerEntry({
									lineupSlotId: 4,
									id: 106,
									fullName: "Ghost",
									omitPlayer: true,
								}),
								playerEntry({
									lineupSlotId: 2,
									id: 107,
									fullName: "No Pool",
									omitPool: true,
								}),
							],
						},
					},
				],
			}),
		);

		expect(roster.starters.map((p) => `${p.name}:${p.pos}`)).toEqual([
			"Flex WR:FLEX",
			"Ravens D:DST",
			"Aubrey:K",
		]);
		expect(roster.starters[0]?.team).toBe("SEA");
		expect(roster.starters[1]?.team).toBe("BAL");

		expect(roster.bench.map((p) => `${p.name}:${p.pos}`)).toEqual([
			"IR Back:RB",
			"Unknown Slot WR:WR",
			"Unknown Pos:RB",
		]);
		expect(roster.bench[1]?.team).toBe("PHI");
		expect(roster.bench[2]?.team).toBe("NFL");
		expect(roster.starters.find((p) => p.name === "Ghost")).toBeUndefined();
		expect(roster.bench.find((p) => p.name === "No Pool")).toBeUndefined();
	});

	it("maps injury statuses, High Floor tags, projection rounding, and week fallbacks", () => {
		const { roster, week } = sanitizeEspnTeamRoster(
			league({
				scoringPeriodId: 0,
				currentPeriodId: 0,
				status: { latestScoringPeriod: 11 },
				teams: [
					{
						id: 1,
						name: "Injuries",
						roster: {
							entries: [
								playerEntry({
									lineupSlotId: 2,
									id: 1,
									fullName: "Doubtful",
									injuryStatus: "doubtful",
									appliedStatTotal: 18,
								}),
								playerEntry({
									lineupSlotId: 2,
									id: 2,
									fullName: "Out",
									injuryStatus: "OUT",
									appliedStatTotal: 17.94,
								}),
								playerEntry({
									lineupSlotId: 20,
									id: 3,
									fullName: "Reserve",
									injuryStatus: "INJURY_RESERVE",
									appliedStatTotal: "12" as unknown as number,
								}),
								playerEntry({
									lineupSlotId: 20,
									id: 4,
									fullName: "Flag Only",
									injured: true,
								}),
							],
						},
					},
				],
			}),
		);

		const doubtful = roster.starters.find((p) => p.name === "Doubtful");
		expect(doubtful?.status).toBe("DOUBTFUL");
		expect(doubtful?.tags).toEqual(["DOUBTFUL", "High Floor"]);
		expect(doubtful?.injuryDesc).toContain("doubtful");

		const out = roster.starters.find((p) => p.name === "Out");
		expect(out?.status).toBe("OUT");
		expect(out?.projPts).toBe(17.9);
		expect(out?.tags).toEqual(["OUT"]);

		const reserve = roster.bench.find((p) => p.name === "Reserve");
		expect(reserve?.status).toBe("IR");
		expect(reserve?.projPts).toBe(10);
		expect(reserve?.tags).toEqual(["IR"]);

		const flagOnly = roster.bench.find((p) => p.name === "Flag Only");
		expect(flagOnly?.status).toBe("ACTIVE");
		expect(flagOnly?.tags).toBeUndefined();
		expect(flagOnly?.injuryDesc).toBeUndefined();

		expect(week).toBe(11);
	});

	it("falls back to week 14 when every scoring-period field is missing", () => {
		const { week } = sanitizeEspnTeamRoster(
			league({
				scoringPeriodId: undefined,
				currentPeriodId: undefined,
				status: {},
			}),
		);
		expect(week).toBe(14);
	});
});

describe("ESPN Durable Object / worker HTTP contracts", () => {
	it("maps ESPN auth, request, and invalid-JSON errors through the HTTP path", async () => {
		const originalFetch = globalThis.fetch;
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-http-errors-${crypto.randomUUID()}`),
		);

		try {
			globalThis.fetch = espnFetch("nope", 401);
			const unauthorized = await stub.fetch("https://do/espn/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leagueId: "9", espnS2: "s2", swid: "{S}" }),
			});
			expect(unauthorized.status).toBe(401);
			await expect(unauthorized.json()).resolves.toMatchObject({
				code: "ESPN_AUTH_UNAUTHORIZED",
			});

			globalThis.fetch = espnFetch("missing", 404);
			const missing = await stub.fetch("https://do/espn/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leagueId: "9" }),
			});
			expect(missing.status).toBe(404);
			await expect(missing.json()).resolves.toMatchObject({
				code: "ESPN_REQUEST_FAILED",
			});

			globalThis.fetch = espnFetch("<html>", 200, "text/html");
			const invalid = await stub.fetch("https://do/espn/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leagueId: "9" }),
			});
			expect(invalid.status).toBe(502);
			await expect(invalid.json()).resolves.toMatchObject({
				code: "ESPN_INVALID_RESPONSE",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("treats malformed JSON as an empty body and still requires leagueId", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-bad-json-${crypto.randomUUID()}`),
		);
		const res = await stub.fetch("https://do/espn/sync", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			code: "ESPN_CREDENTIALS_MISSING",
		});
	});

	it("uses ESPN_LEAGUE_ID and alternate Espn_s2 / Swid env names when the body omits them", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-env-${crypto.randomUUID()}`),
		);
		let capturedCookie = "";

		const updated = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) => {
				instance.env.ESPN_LEAGUE_ID = "555";
				instance.env.ESPN_SEASON = "not-a-year";
				instance.env.Espn_s2 = "env_s2";
				instance.env.Swid = "{ENV_SWID}";
				delete instance.env.ESPN_S2;
				delete instance.env.SWID;
				return instance.syncEspnRoster({}, async (_input, init) => {
					capturedCookie = new Headers(init?.headers).get("Cookie") ?? "";
					return espnFetch(TWO_TEAM_LEAGUE)();
				});
			},
		);

		expect(capturedCookie).toBe("espn_s2=env_s2; SWID={ENV_SWID}");
		expect(updated.espnSyncMeta?.leagueId).toBe("555");
		expect(updated.espnSyncMeta?.season).toBe(2024);
		expect(updated.activeRoster.teamName).toBe("Alpha Club");
	});

	it("honors credentials.teamId, replaces an existing ESPN token metric, and persists storage", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-team-${crypto.randomUUID()}`),
		);
		const mockFetch = espnFetch(TWO_TEAM_LEAGUE);

		const first = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{ leagueId: "123", teamId: "2", espnS2: "s2", swid: "{S}" },
					mockFetch,
				),
		);
		expect(first.activeRoster.teamName).toBe("Beta Club");
		expect(first.activeRoster.owner).toBe("Beta Owner");
		expect(
			first.tokenMetrics.filter((m) => m.queryType.includes("ESPN")),
		).toHaveLength(1);

		const second = await runInDurableObject(
			stub,
			async (instance: WorkflowStatusDO) =>
				instance.syncEspnRoster(
					{ leagueId: "123", teamId: 2, espnS2: "s2", swid: "{S}" },
					mockFetch,
				),
		);
		expect(
			second.tokenMetrics.filter((m) => m.queryType.includes("ESPN")),
		).toHaveLength(1);

		await runInDurableObject(stub, async (_instance, durableState) => {
			const stored = await durableState.storage.get<{
				activeRoster: { teamName: string };
				espnSyncMeta?: { leagueId: string };
			}>("fantasyState");
			expect(stored?.activeRoster.teamName).toBe("Beta Club");
			expect(stored?.espnSyncMeta?.leagueId).toBe("123");
		});
	});

	it("broadcasts a fantasy_update after ESPN sync and proxies /api/fantasy/espn/sync", async () => {
		const teamId = `espn-ws-${crypto.randomUUID()}`;
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(teamId),
		);

		const wsResponse = await stub.fetch(
			`https://do/fantasy?teamId=${teamId}`,
			{ headers: { Upgrade: "websocket" } },
		);
		const socket = wsResponse.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket");
		}

		const frames: Array<{ type?: string; payload?: { activeRoster?: { teamName?: string } } }> =
			[];
		const gotSecond = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for ESPN broadcast")),
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

		const originalFetch = globalThis.fetch;
		try {
			globalThis.fetch = espnFetch(TWO_TEAM_LEAGUE);
			const http = await fetchWorker("/api/fantasy/espn/sync?teamId=" + teamId, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leagueId: "12345678",
					teamId: "2",
					espnS2: "s2",
					swid: "{S}",
				}),
			});
			expect(http.status).toBe(200);
			const body = (await http.json()) as {
				activeRoster: { teamName: string };
			};
			expect(body.activeRoster.teamName).toBe("Beta Club");

			await gotSecond;
			expect(frames[0]?.type).toBe("fantasy_update");
			expect(frames[1]?.type).toBe("fantasy_update");
			expect(frames[1]?.payload?.activeRoster?.teamName).toBe("Beta Club");
		} finally {
			globalThis.fetch = originalFetch;
			socket.close(1000, "done");
		}
	});

	it("maps a non-iterable roster entries payload to HTTP 500 ESPN_REQUEST_FAILED", async () => {
		const originalFetch = globalThis.fetch;
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(`espn-500-${crypto.randomUUID()}`),
		);

		try {
			globalThis.fetch = espnFetch({
				id: 1,
				seasonId: 2024,
				teams: [{ id: 1, roster: { entries: { not: "an-array" } } }],
			});
			const res = await stub.fetch("https://do/espn/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leagueId: "1" }),
			});
			expect(res.status).toBe(500);
			await expect(res.json()).resolves.toMatchObject({
				code: "ESPN_REQUEST_FAILED",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
