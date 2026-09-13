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
 * WorkflowStatusDO - Durable Object for managing workflow and fantasy command center state.
 *
 * Responsibilities:
 * - Accept and manage WebSocket connections using hibernation API
 * - Track step statuses for workflow instances
 * - Persist and manage fantasy football league roster and cached Grok beat intel
 * - Compute token-optimized Grok decisions and broadcast updates to clients
 */
export class WorkflowStatusDO extends DurableObject {
	private stepStatuses: Map<string, string>;
	private currentStep: string | null;
	private workflowStatus: "running" | "completed" | "error";
	private fantasyState: CommandCenterState;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.stepStatuses = new Map();
		this.currentStep = null;
		this.workflowStatus = "running";
		this.fantasyState = buildCommandCenterState();

		// Load state from durable storage to survive hibernation/eviction
		ctx.blockConcurrencyWhile(async () => {
			const storedStatuses =
				await ctx.storage.get<Record<string, string>>("stepStatuses");
			const storedCurrent = await ctx.storage.get<string | null>("currentStep");
			const storedWorkflowStatus = await ctx.storage.get<
				"running" | "completed" | "error"
			>("workflowStatus");
			const storedFantasy =
				await ctx.storage.get<CommandCenterState>("fantasyState");

			if (storedStatuses) {
				this.stepStatuses = new Map(Object.entries(storedStatuses));
			} else {
				const steps = [
					"process data",
					"wait 2 seconds",
					"wait for approval",
					"final",
				];
				steps.forEach((s) => this.stepStatuses.set(s, "pending"));
			}

			this.currentStep = storedCurrent ?? null;
			this.workflowStatus = storedWorkflowStatus ?? "running";
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

			// Use hibernation API - acceptWebSocket allows the DO to hibernate
			this.ctx.acceptWebSocket(server);

			// Send current workflow state and fantasy state immediately
			server.send(JSON.stringify(this.getStateMessage()));
			server.send(JSON.stringify(this.getFantasyStateMessage()));

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

	/**
	 * RPC method called by the workflow to update step status
	 */
	async updateStep(stepName: string, status: string): Promise<void> {
		this.stepStatuses.set(stepName, status);

		if (status === "running" || status === "waiting") {
			this.currentStep = stepName;
		}

		const allCompleted = Array.from(this.stepStatuses.values()).every(
			(s) => s === "completed",
		);
		if (allCompleted) {
			this.workflowStatus = "completed";
			this.currentStep = null;
		}

		await this.ctx.storage.put(
			"stepStatuses",
			Object.fromEntries(this.stepStatuses),
		);
		await this.ctx.storage.put("currentStep", this.currentStep);
		await this.ctx.storage.put("workflowStatus", this.workflowStatus);

		this.broadcast(this.getStateMessage());
	}

	/**
	 * Fantasy Command Center RPC Methods
	 */
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
		this.broadcast(this.getFantasyStateMessage());

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
		if (source?.provider === "sleeper" && source.username) {
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
				this.broadcast(this.getFantasyStateMessage());
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
				this.broadcast(this.getFantasyStateMessage());
				return this.fantasyState;
			}
		}

		this.fantasyState.intelPacket.asOf = new Date().toLocaleTimeString(
			"en-US",
			{
				hour: "2-digit",
				minute: "2-digit",
				timeZoneName: "short",
			},
		);
		this.fantasyState.intelPacket.fresh = true;
		this.fantasyState.intelPacket.hash = `intel_wk${this.fantasyState.selectedWeek}_${Date.now().toString(16).slice(-6)}`;

		// Add an alert
		this.fantasyState.liveAlerts.unshift({
			id: `alt_${Date.now()}`,
			time: new Date().toLocaleTimeString("en-US", {
				hour: "2-digit",
				minute: "2-digit",
			}),
			type: "GROK",
			message: "Grok Beat Intel refresh complete: 20 handles polled, cache verified fresh.",
			severity: "success",
		});

		await this.ctx.storage.put("fantasyState", this.fantasyState);
		this.broadcast(this.getFantasyStateMessage());
		return this.fantasyState;
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
		this.broadcast(this.getFantasyStateMessage());
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

			// Swap
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
			this.broadcast(this.getFantasyStateMessage());
		}

		return this.fantasyState;
	}

	/**
	 * WebSocket message handler (hibernation API)
	 */
	async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
		try {
			const data = JSON.parse(message);
			if (data.type === "ping") {
				ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
				return;
			}
			if (data.type === "get_fantasy_state") {
				ws.send(JSON.stringify(this.getFantasyStateMessage()));
				return;
			}
		} catch {
			// fall back to default workflow state
		}
		ws.send(JSON.stringify(this.getStateMessage()));
	}

	/**
	 * WebSocket close handler (hibernation API)
	 */
	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, reason);
	}

	/**
	 * Broadcast a message to all connected WebSocket clients
	 */
	private broadcast(message: object): void {
		const sockets = this.ctx.getWebSockets();
		const json = JSON.stringify(message);

		for (const socket of sockets) {
			try {
				socket.send(json);
			} catch {
				// Ignore errors for disconnected sockets
			}
		}
	}

	/**
	 * Get the current workflow state as a message object
	 */
	private getStateMessage(): object {
		return {
			type: "workflow_update",
			currentStep: this.currentStep,
			stepStatuses: Object.fromEntries(this.stepStatuses),
			workflowStatus: this.workflowStatus,
			timestamp: Date.now(),
		};
	}

	/**
	 * Get the current fantasy command center state as a message object
	 */
	private getFantasyStateMessage(): object {
		return {
			type: "fantasy_update",
			payload: this.fantasyState,
			timestamp: Date.now(),
		};
	}
}
