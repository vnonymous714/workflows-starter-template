import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	parseGrokVerdict,
	recId,
	resolvePlayer,
} from "../src/grok-client";
import { sanitizeEspnTeamRoster } from "../src/espn-client";
import {
	importSleeperRoster,
	mapSleeperPlayerIdToPlayer,
} from "../src/sleeper-client";
import worker from "../worker/index";

const MOCK_USAGE = {
	prompt_tokens: 100,
	completion_tokens: 40,
	total_tokens: 140,
};

const MOCK_VERDICT = {
	act: "SIT",
	delta: -4.2,
	conf: 0.81,
	why: "Ankle DNP in Buffalo wind",
	flags: ["INJ", "WX"],
};

function uniqueName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function fetchWorker(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return worker.fetch(new Request(`https://example.com${path}`, init), env);
}

function mockXaiFetch(
	overrides: {
		content?: string | null;
		choices?: unknown;
	} = {},
): typeof fetch {
	return async (input, init) => {
		const url = String(input);
		if (!url.includes("api.x.ai")) {
			throw new Error(`Unexpected fetch: ${url}`);
		}
		expect(init?.method).toBe("POST");
		return Response.json({
			model: "grok-4",
			choices:
				overrides.choices ??
				[
					{
						message: {
							content:
								overrides.content === undefined
									? JSON.stringify(MOCK_VERDICT)
									: overrides.content,
						},
					},
				],
			usage: MOCK_USAGE,
		});
	};
}

describe("Grok leftover coercions", () => {
	it("treats string useLegacy \"false\" as truthy and posts the verbose roster dump", async () => {
		let packet = "";
		const state = buildCommandCenterState();

		await executeGrokDecision(state, "p_kyren", "p_charbonnet", {
			apiKey: "test-xai-key",
			useLegacy: "false" as unknown as boolean,
			fetchImpl: async (input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					messages?: Array<{ content?: string }>;
				};
				packet = body.messages?.[1]?.content ?? "";
				return mockXaiFetch()(input, init);
			},
		});

		expect(packet).toContain("Week 14 full roster dump for start/sit.");
		expect(packet).toContain("Ja'Marr Chase");
		expect(packet).not.toContain("Q: Williams vs Charbonnet");
	});

	it("resolves the shared p_ prefix to Josh Allen instead of unknown-player", async () => {
		const state = buildCommandCenterState();
		expect(resolvePlayer(state, "p_")?.id).toBe("p_jallen");
		expect(resolvePlayer(state, "p_")?.name).toBe("Josh Allen");

		let packet = "";
		const decision = await executeGrokDecision(state, "p_", "p_charbonnet", {
			apiKey: "test-xai-key",
			fetchImpl: async (input, init) => {
				const body = JSON.parse(String(init?.body)) as {
					messages?: Array<{ content?: string }>;
				};
				packet = body.messages?.[1]?.content ?? "";
				return mockXaiFetch()(input, init);
			},
		});

		expect(packet).toContain("Q: Allen vs Charbonnet");
		expect(packet).toContain("Josh Allen");
		expect(decision.recs[0].id).toBe("Allen");
		expect(decision.recs[1].id).toBe("Charbonnet");
	});

	it("maps whitespace-only xAI content to did-not-return-JSON, not missing content", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: mockXaiFetch({ content: "   \n\t  " }),
				},
			),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_INVALID_RESPONSE",
			message: "Grok did not return JSON.",
		});
	});

	it("ignores a valid verdict in choices[1] when choices[0] has no content", async () => {
		await expect(
			executeGrokDecision(
				buildCommandCenterState(),
				"p_kyren",
				"p_charbonnet",
				{
					apiKey: "test-xai-key",
					fetchImpl: mockXaiFetch({
						choices: [
							{ message: {} },
							{
								message: {
									content: JSON.stringify(MOCK_VERDICT),
								},
							},
						],
					}),
				},
			),
		).rejects.toMatchObject({
			name: "GrokRequestError",
			code: "XAI_INVALID_RESPONSE",
			message: "xAI response was missing message content.",
		});
	});

	it("keeps an empty recs src and NEWS flags instead of defaulting them away", () => {
		const state = buildCommandCenterState();
		const kyren = resolvePlayer(state, "p_kyren")!;
		const charbonnet = resolvePlayer(state, "p_charbonnet")!;

		const recs = parseGrokVerdict(
			{
				recs: [
					{
						id: "Williams",
						act: "SIT",
						delta: -2,
						src: "",
						flags: ["NEWS", "BOGUS"],
					},
				],
			},
			kyren,
			charbonnet,
		);

		expect(recs[0].src).toBe("");
		expect(recs[0].src).not.toBe("grok");
		expect(recs[0].flags).toEqual(["NEWS"]);
	});
});

describe("Sleeper leftover known-player and query coercions", () => {
	it("copies Kenneth Walker III metadata so recId stays Kenneth after import", () => {
		const walker = mapSleeperPlayerIdToPlayer("8139");
		expect(walker).toMatchObject({
			id: "p_8139",
			name: "Kenneth Walker III",
			pos: "RB",
			team: "SEA",
			opp: "@ ARI",
			projPts: 16.8,
			status: "ACTIVE",
			tags: ["Explosive Playmaker"],
		});
		expect(recId(walker)).toBe("Kenneth");
	});

	it("formats an empty settings object as 0-0 and treats query 0 as first-roster fallthrough", async () => {
		const fetchImpl: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/league/1122334455")) {
				return Response.json({
					league_id: "1122334455",
					name: "Champions League",
				});
			}
			if (url.endsWith("/league/1122334455/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "user_101",
						starters: ["4984"],
						players: ["4984"],
						settings: {},
					},
					{
						roster_id: 2,
						owner_id: "user_102",
						starters: ["8138"],
						players: ["8138"],
						settings: { wins: 9, losses: 4 },
					},
				]);
			}
			if (url.endsWith("/league/1122334455/users")) {
				return Response.json([
					{
						user_id: "user_101",
						username: "gridiron_king",
						display_name: "Gridiron King",
					},
				]);
			}
			return new Response("Not found", { status: 404 });
		};

		const roster = await importSleeperRoster(
			{ leagueId: "1122334455", userOrRosterId: "0" },
			fetchImpl,
		);

		expect(roster.rank).toBe(1);
		expect(roster.record).toBe("0-0");
		expect(roster.starters[0]?.name).toBe("Josh Allen");
		expect(roster.starters[0]?.name).not.toBe("Kyren Williams");
	});
});

describe("ESPN leftover sanitizer skips", () => {
	it("skips roster entries that omit player and ignores injured when status is ACTIVE", () => {
		const { roster } = sanitizeEspnTeamRoster(
			{
				id: 99,
				seasonId: 2024,
				teams: [
					{
						id: 3,
						name: "Sparse Caps",
						roster: {
							entries: [
								{ lineupSlotId: 0 },
								{ lineupSlotId: 2, playerPoolEntry: {} },
								{
									lineupSlotId: 4,
									playerPoolEntry: {
										appliedStatTotal: 16.4,
										player: {
											id: 4262921,
											fullName: "Amon-Ra St. Brown",
											defaultPositionId: 3,
											proTeamId: 8,
											injuryStatus: "ACTIVE",
											injured: true,
										},
									},
								},
							],
						},
					},
				],
			},
			3,
		);

		expect(roster.starters).toHaveLength(1);
		expect(roster.bench).toHaveLength(0);
		expect(roster.starters[0]).toMatchObject({
			id: "espn_4262921",
			name: "Amon-Ra St. Brown",
			pos: "WR",
			team: "DET",
			status: "ACTIVE",
		});
		expect(roster.starters[0]?.injuryDesc).toBeUndefined();
		expect(roster.starters[0]?.tags).toBeUndefined();
	});
});

describe("Worker leftover routing contracts", () => {
	it("treats a trailing slash after a workflow instance id as a missing id", async () => {
		const instanceId = uniqueName("slash");

		const statusResponse = await fetchWorker(
			`/api/workflow/status/${instanceId}/`,
		);
		expect(statusResponse.status).toBe(400);
		await expect(statusResponse.json()).resolves.toEqual({
			error: "Instance ID required",
		});

		const eventResponse = await fetchWorker(
			`/api/workflow/event/${instanceId}/`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ approved: true }),
			},
		);
		expect(eventResponse.status).toBe(400);
		await expect(eventResponse.json()).resolves.toEqual({
			error: "Instance ID required",
		});
	});

	it("does not treat /ws/ as the websocket upgrade route", async () => {
		const response = await fetchWorker("/ws/?instanceId=demo", {
			headers: { Upgrade: "websocket" },
		});
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not found");
		expect(response.webSocket).toBeNull();
	});

	it("returns text 404 for /api and JSON 404 for /api/", async () => {
		const bare = await fetchWorker("/api");
		expect(bare.status).toBe(404);
		expect(await bare.text()).toBe("Not found");

		const slashed = await fetchWorker("/api/");
		expect(slashed.status).toBe(404);
		await expect(slashed.json()).resolves.toEqual({ error: "Not Found" });
	});

	it("maps empty teamId to default_team and does not collapse a whitespace teamId", async () => {
		const omitted = await fetchWorker("/api/fantasy/state");
		const empty = await fetchWorker("/api/fantasy/state?teamId=");
		expect(omitted.status).toBe(200);
		expect(empty.status).toBe(200);
		const omittedBody = (await omitted.json()) as {
			activeRoster: { teamName: string; teamId: string };
		};
		const emptyBody = (await empty.json()) as {
			activeRoster: { teamName: string; teamId: string };
		};
		expect(emptyBody.activeRoster.teamId).toBe(omittedBody.activeRoster.teamId);
		expect(emptyBody.activeRoster.teamName).toBe(omittedBody.activeRoster.teamName);

		const paddedTeamId = `  ${uniqueName("pad")}  `;
		const neighborTeamId = uniqueName("neighbor");
		const sleeperFetch: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("/rosters")) {
				return Response.json([
					{
						roster_id: 1,
						owner_id: "user_101",
						starters: ["4984"],
						players: ["4984"],
						settings: { wins: 1, losses: 0 },
					},
				]);
			}
			if (url.includes("/users")) {
				return Response.json([
					{
						user_id: "user_101",
						username: "gridiron_king",
						display_name: "Gridiron King",
						metadata: { team_name: "Whitespace Island" },
					},
				]);
			}
			if (url.includes("/league/")) {
				return Response.json({
					league_id: "9988776655",
					name: "Pad League",
				});
			}
			return new Response("Not found", { status: 404 });
		};

		const previousFetch = globalThis.fetch;
		globalThis.fetch = sleeperFetch;
		try {
			const imported = await fetchWorker(
				`/api/fantasy/roster/sleeper-import?teamId=${encodeURIComponent(paddedTeamId)}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ leagueId: "9988776655" }),
				},
			);
			expect(imported.status).toBe(200);
			const importedBody = (await imported.json()) as {
				activeRoster: { teamName: string };
			};
			expect(importedBody.activeRoster.teamName).toContain("Whitespace Island");
		} finally {
			globalThis.fetch = previousFetch;
		}

		const neighbor = (await (
			await fetchWorker(
				`/api/fantasy/state?teamId=${encodeURIComponent(neighborTeamId)}`,
			)
		).json()) as { activeRoster: { teamName: string } };
		expect(neighbor.activeRoster.teamName).toBe("Neural Gridiron Pulse");
		expect(neighbor.activeRoster.teamName).not.toContain("Whitespace Island");
	});
});

describe("Durable Object leftover websocket frame matching", () => {
	it("does not treat uppercase PING as a ping (case-sensitive type)", async () => {
		const stub = env.WORKFLOW_STATUS.get(
			env.WORKFLOW_STATUS.idFromName(uniqueName("ping-case")),
		);
		const response = await stub.fetch("https://example.com/", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		if (!socket) {
			throw new Error("Expected WebSocket response");
		}

		const frames: Array<{ type?: string }> = [];
		const gotSecond = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timed out waiting for PING echo")),
				3000,
			);
			socket.addEventListener("message", (event) => {
				frames.push(JSON.parse(event.data as string) as { type?: string });
				if (frames.length >= 2) {
					clearTimeout(timer);
					resolve();
				}
			});
		});

		socket.accept();
		socket.send(JSON.stringify({ type: "PING" }));
		await gotSecond;
		socket.close(1000, "done");

		expect(frames[0]?.type).toBe("workflow_update");
		expect(frames[1]?.type).toBe("workflow_update");
		expect(frames.some((frame) => frame.type === "pong")).toBe(false);
	});
});
