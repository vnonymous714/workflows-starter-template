import { DurableObject } from "cloudflare:workers";
import type {
	CommandCenterState,
	GrokApiErrorBody,
	GrokDecisionResponse,
	SleeperApiErrorBody,
} from "../src/types/fantasy";
import { buildCommandCenterState } from "../src/fantasy-intel";
import {
	executeGrokDecision,
	GrokRequestError,
	MissingXaiApiKeyError,
} from "../src/grok-client";
import {
	importSleeperRoster,
	SleeperRequestError,
	type SleeperImportInput,
} from "../src/sleeper-client";

/**
 * WorkflowStatusDO - Durable Object for Fantasy Command Center state.
 *
 * Responsibilities:
 * - Accept WebSocket connections (hibernation API) for cron intel refresh
 * - Persist league roster and cached Grok beat intel
 * - Compute token-optimized Grok decisions
 */
export class WorkflowStatusDO extends DurableObject {
	private fantasyState: CommandCenterState;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.fantasyState = buildCommandCenterState();

		ctx.blockConcurrencyWhile(async () => {
			const storedFantasy =
				await ctx.storage.get<CommandCenterState>("fantasyState");
			if (storedFantasy) {
				this.fantasyState = storedFantasy;
			}
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			this.ctx.acceptWebSocket(server);

			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === "/state" && request.method === "GET") {
			return Response.json(this.fantasyState);
		}

		if (url.pathname === "/decide" && request.method === "POST") {
			const body = (await request.json()) as {
				playerA: string;
				playerB: string;
				useLegacy?: boolean;
			};
			try {
				const decision = await this.decide(
					body.playerA,
					body.playerB,
					!!body.useLegacy,
				);
				return Response.json(decision);
			} catch (error) {
				return this.grokErrorResponse(error);
			}
		}

		if (url.pathname === "/intel/refresh" && request.method === "POST") {
			const state = await this.refreshIntel();
			return Response.json(state);
		}

		if (url.pathname === "/roster/swap" && request.method === "POST") {
			const body = (await request.json()) as {
				starterId: string;
				benchId: string;
			};
			const state = await this.swapRoster(body.starterId, body.benchId);
			return Response.json(state);
		}

		if (url.pathname === "/roster/import" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as SleeperImportInput;
			try {
				const state = await this.importRoster(body);
				return Response.json(state);
			} catch (error) {
				return this.sleeperErrorResponse(error);
			}
		}

		return new Response("Expected WebSocket or API route", { status: 400 });
	}

	async updateStep(_stepName: string, _status: string): Promise<void> {}

	async getFantasyState(): Promise<CommandCenterState> {
		return this.fantasyState;
	}

	async decide(
		playerAId: string,
		playerBId: string,
		useLegacy = false,
		grok?: { apiKey?: string; fetchImpl?: typeof fetch },
	): Promise<GrokDecisionResponse> {
		const decision = await executeGrokDecision(
			this.fantasyState,
			playerAId,
			playerBId,
			{
				apiKey: grok?.apiKey ?? this.env.XAI_API_KEY,
				useLegacy,
				fetchImpl: grok?.fetchImpl,
			},
		);

		const existingIds = new Set(decision.recs.map((r) => r.id));
		this.fantasyState.recommendations = [
			...decision.recs,
			...this.fantasyState.recommendations.filter(
				(r) => !existingIds.has(r.id),
			),
		];
		this.fantasyState.lastDecision = decision;

		await this.ctx.storage.put("fantasyState", this.fantasyState);

		return decision;
	}

	private sleeperErrorResponse(error: unknown): Response {
		if (error instanceof SleeperRequestError) {
			const body: SleeperApiErrorBody = {
				error: error.message,
				code: error.code,
			};
			return Response.json(body, { status: error.status });
		}
		const body: SleeperApiErrorBody = {
			error: error instanceof Error ? error.message : "Sleeper import failed.",
			code: "SLEEPER_REQUEST_FAILED",
		};
		return Response.json(body, { status: 502 });
	}

	private grokErrorResponse(error: unknown): Response {
		if (error instanceof MissingXaiApiKeyError) {
			const body: GrokApiErrorBody = {
				error: error.message,
				code: error.code,
			};
			return Response.json(body, { status: 503 });
		}
		if (error instanceof GrokRequestError) {
			const body: GrokApiErrorBody = {
				error: error.message,
				code: error.code,
			};
			return Response.json(body, { status: 502 });
		}
		const body: GrokApiErrorBody = {
			error: error instanceof Error ? error.message : "Grok evaluation failed.",
			code: "XAI_REQUEST_FAILED",
		};
		return Response.json(body, { status: 500 });
	}

	async refreshIntel(sleeper?: {
		fetchImpl?: typeof fetch;
	}): Promise<CommandCenterState> {
		const source = this.fantasyState.activeRoster.source;
		if (source?.provider !== "sleeper" || !source.username) {
			return this.fantasyState;
		}

		try {
			const state = await this.importRoster(
				{
					username: source.username,
					leagueId: source.leagueId,
					rosterId: source.rosterId,
				},
				sleeper,
			);
			if (state.liveAlerts[0]) {
				state.liveAlerts[0].message = `Re-synced ${state.activeRoster.teamName} from Sleeper (@${source.username}).`;
			}
			await this.ctx.storage.put("fantasyState", this.fantasyState);
			this.broadcastFantasyState();
			return state;
		} catch (error) {
			this.fantasyState.liveAlerts.unshift({
				id: `alt_${Date.now()}`,
				time: new Date().toLocaleTimeString("en-US", {
					hour: "2-digit",
					minute: "2-digit",
				}),
				type: "GROK",
				message:
					error instanceof Error
						? `Sleeper re-sync failed: ${error.message}`
						: "Sleeper re-sync failed.",
				severity: "danger",
			});
			await this.ctx.storage.put("fantasyState", this.fantasyState);
			this.broadcastFantasyState();
			return this.fantasyState;
		}
	}

	async importRoster(
		input: SleeperImportInput,
		sleeper?: { fetchImpl?: typeof fetch },
	): Promise<CommandCenterState> {
		const imported = await importSleeperRoster(input, sleeper?.fetchImpl ?? fetch);
		const asOf = new Date().toLocaleTimeString("en-US", {
			hour: "2-digit",
			minute: "2-digit",
			timeZoneName: "short",
		});
		const leagueId = imported.roster.source?.leagueId ?? "league";
		const rosterId = imported.roster.source?.rosterId ?? imported.roster.teamId;

		this.fantasyState.selectedWeek = imported.week;
		this.fantasyState.activeRoster = imported.roster;
		this.fantasyState.intelPacket = {
			week: imported.week,
			asOf,
			fresh: false,
			hash: `sleeper_${leagueId}_${rosterId}_wk${imported.week}`,
			injuries: imported.injuries,
			weather: imported.weather,
			beatReports: [],
		};
		this.fantasyState.recommendations = [];
		this.fantasyState.lastDecision = null;
		this.fantasyState.liveAlerts = [
			{
				id: `alt_${Date.now()}`,
				time: new Date().toLocaleTimeString("en-US", {
					hour: "2-digit",
					minute: "2-digit",
				}),
				type: "LINEUP",
				message: `Imported ${imported.roster.teamName} from Sleeper (@${imported.roster.source?.username ?? input.username}). Demo Neural Gridiron Pulse roster replaced.`,
				severity: "success",
			},
		];
		const flaggedWeather = imported.weather.filter(
			(wx) => wx.weatherTag !== "NONE",
		);
		if (flaggedWeather.length > 0) {
			this.fantasyState.liveAlerts.unshift({
				id: `alt_wx_${Date.now()}`,
				time: new Date().toLocaleTimeString("en-US", {
					hour: "2-digit",
					minute: "2-digit",
				}),
				type: "WEATHER",
				message: flaggedWeather
					.map((wx) => `${wx.game} ${wx.weatherTag}`)
					.join(" · "),
				severity: "warning",
			});
		}

		await this.ctx.storage.put("fantasyState", this.fantasyState);
		return this.fantasyState;
	}

	async swapRoster(
		starterId: string,
		benchId: string,
	): Promise<CommandCenterState> {
		const starterIdx = this.fantasyState.activeRoster.starters.findIndex(
			(p) => p.id === starterId,
		);
		const benchIdx = this.fantasyState.activeRoster.bench.findIndex(
			(p) => p.id === benchId,
		);

		if (starterIdx !== -1 && benchIdx !== -1) {
			const starter = this.fantasyState.activeRoster.starters[starterIdx];
			const bench = this.fantasyState.activeRoster.bench[benchIdx];

			this.fantasyState.activeRoster.starters[starterIdx] = {
				...bench,
				pos: starter.pos,
			};
			this.fantasyState.activeRoster.bench[benchIdx] = {
				...starter,
				pos: bench.pos,
			};

			this.fantasyState.liveAlerts.unshift({
				id: `alt_${Date.now()}`,
				time: new Date().toLocaleTimeString("en-US", {
					hour: "2-digit",
					minute: "2-digit",
				}),
				type: "LINEUP",
				message: `Lineup adjustment: Started ${bench.name} over ${starter.name} (${starter.pos}).`,
				severity: "info",
			});

			await this.ctx.storage.put("fantasyState", this.fantasyState);
		}

		return this.fantasyState;
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, reason);
	}

	private broadcastFantasyState(): void {
		const sockets = this.ctx.getWebSockets();
		const json = JSON.stringify({
			type: "fantasy_update",
			payload: this.fantasyState,
			timestamp: Date.now(),
		});

		for (const socket of sockets) {
			try {
				socket.send(json);
			} catch {
				// Ignore errors for disconnected sockets
			}
		}
	}
}
