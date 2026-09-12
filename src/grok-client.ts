import type {
	CommandCenterState,
	FantasyPlayer,
	GrokDecisionAction,
	GrokDecisionResponse,
	GrokRecommendation,
	GrokStartSitVerdict,
	IntelFlag,
} from "./types/fantasy";

export const XAI_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";
export const GROK_START_SIT_MODEL = "grok-4";
export const LEGACY_TOKENS_EQUIVALENT = 4250;
export const DEFAULT_START_SIT_QUERY = {
	playerAId: "p_kyren",
	playerBId: "p_charbonnet",
} as const;

const ACTIONS: GrokDecisionAction[] = [
	"START",
	"SIT",
	"HOLD",
	"ADD",
	"DROP",
	"TRADE_Y",
	"TRADE_N",
	"SMASH",
];
const FLAGS: IntelFlag[] = ["INJ", "WX", "NEWS", "SPLIT", "STALE"];

export const START_SIT_JSON_SCHEMA = {
	name: "start_sit_verdict",
	strict: true,
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			act: {
				type: "string",
				enum: ACTIONS,
				description: "Start/sit action for the starter (player A).",
			},
			delta: {
				type: "number",
				description:
					"Projected-point edge for player A vs player B. Negative means sit A.",
			},
			conf: {
				type: "number",
				description: "Confidence from 0 to 1.",
			},
			why: {
				type: "string",
				description: "Rationale in 12 words or fewer.",
			},
			flags: {
				type: "array",
				items: { type: "string", enum: FLAGS },
				description: "Compact intel flags.",
			},
		},
		required: ["act", "delta", "conf", "why", "flags"],
	},
} as const;

const SYSTEM_PROMPT =
	"Fantasy start/sit analyst. Use only the compact INTEL packet. why <= 12 words. JSON only.";

export class MissingXaiApiKeyError extends Error {
	readonly code = "XAI_API_KEY_MISSING" as const;

	constructor() {
		super(
			"XAI_API_KEY is not configured. Set it with `npx wrangler secret put XAI_API_KEY` or add it to `.dev.vars` for local development.",
		);
		this.name = "MissingXaiApiKeyError";
	}
}

export class GrokRequestError extends Error {
	readonly code: "XAI_REQUEST_FAILED" | "XAI_INVALID_RESPONSE";

	constructor(
		message: string,
		code: "XAI_REQUEST_FAILED" | "XAI_INVALID_RESPONSE" = "XAI_REQUEST_FAILED",
	) {
		super(message);
		this.name = "GrokRequestError";
		this.code = code;
	}
}

export interface ExecuteGrokDecisionOptions {
	apiKey?: string;
	useLegacy?: boolean;
	fetchImpl?: typeof fetch;
	model?: string;
}

interface XaiUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
}

interface XaiChatCompletion {
	choices?: Array<{ message?: { content?: string | null } }>;
	usage?: XaiUsage;
	model?: string;
}

export function resolvePlayer(
	state: CommandCenterState,
	token: string,
): FantasyPlayer | undefined {
	const roster = [
		...state.activeRoster.starters,
		...state.activeRoster.bench,
	];
	const lower = token.toLowerCase();
	return (
		roster.find((p) => p.id.toLowerCase() === lower) ??
		roster.find(
			(p) =>
				p.id.toLowerCase().includes(lower) ||
				p.name.toLowerCase().includes(lower),
		)
	);
}

export function recId(player: FantasyPlayer): string {
	const parts = player.name.trim().split(/\s+/);
	if (parts.length === 1) {
		return parts[0];
	}
	const last = parts[parts.length - 1];
	if (last.length > 3) {
		return last;
	}
	return parts[0];
}

export function clipWhy(why: string, maxWords = 12): string {
	const words = why.trim().split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) {
		return words.join(" ");
	}
	return words.slice(0, maxWords).join(" ");
}

export function extractTokenUsage(usage: XaiUsage | undefined): number {
	if (!usage) {
		throw new GrokRequestError(
			"xAI response did not include token usage.",
			"XAI_INVALID_RESPONSE",
		);
	}
	if (typeof usage.total_tokens === "number") {
		return usage.total_tokens;
	}
	const prompt = usage.prompt_tokens ?? usage.input_tokens;
	const completion = usage.completion_tokens ?? usage.output_tokens;
	if (typeof prompt === "number" && typeof completion === "number") {
		return prompt + completion;
	}
	throw new GrokRequestError(
		"xAI response usage was missing prompt/completion token counts.",
		"XAI_INVALID_RESPONSE",
	);
}

function practiceLine(
	report: CommandCenterState["intelPacket"]["injuries"][number]["practiceReport"],
): string {
	const parts: string[] = [];
	if (report.wed !== "-") parts.push(`Wed-${report.wed}`);
	if (report.thu !== "-") parts.push(`Thu-${report.thu}`);
	if (report.fri !== "-") parts.push(`Fri-${report.fri}`);
	return parts.join(" ");
}

function playerLine(player: FantasyPlayer): string {
	const inj = player.injuryDesc ? ` inj:${player.injuryDesc}` : "";
	const wx = player.weatherCondition ? ` wx:${player.weatherCondition}` : "";
	const tags = player.tags?.length ? ` tags:${player.tags.join(",")}` : "";
	return `${player.name} ${player.pos} ${player.team} ${player.opp} ${player.projPts} ${player.status}${inj}${wx}${tags}`;
}

function relatedIntel(
	state: CommandCenterState,
	players: FantasyPlayer[],
): string[] {
	const ids = new Set(players.map((p) => p.id));
	const teams = new Set(players.map((p) => p.team));
	const games = new Set(players.map((p) => `${p.team} ${p.opp}`));
	const lines: string[] = [];

	for (const inj of state.intelPacket.injuries) {
		if (!ids.has(inj.playerId) && !teams.has(inj.team)) continue;
		const hc = inj.handcuffName ? ` hc:${inj.handcuffName}` : "";
		lines.push(
			`- INJ: ${inj.playerName} ${inj.status} ${practiceLine(inj.practiceReport)} conf${inj.confidence}${hc}`,
		);
	}

	for (const wx of state.intelPacket.weather) {
		const relevant = [...games].some((g) => {
			const [team, , opp] = g.split(" ");
			return (
				wx.game.includes(team) &&
				(wx.game.includes(opp) || players.some((p) => wx.game.includes(p.team)))
			);
		});
		if (!relevant && !players.some((p) => wx.game.includes(p.team))) continue;
		const dome = wx.isDome ? "DOME" : `wind${wx.windMph} gust${wx.gustMph}`;
		lines.push(
			`- WX: ${wx.game} ${dome} ${wx.tempF}F ${wx.weatherTag}`,
		);
	}

	for (const beat of state.intelPacket.beatReports) {
		if (
			(beat.playerId && ids.has(beat.playerId)) ||
			teams.has(beat.team)
		) {
			const claim = beat.claim.length > 140
				? `${beat.claim.slice(0, 137)}...`
				: beat.claim;
			lines.push(`- BEAT ${beat.handle}: ${claim}`);
		}
	}

	return lines;
}

export function buildCsspPacket(
	state: CommandCenterState,
	playerA: FantasyPlayer,
	playerB: FantasyPlayer,
	useLegacy = false,
): string {
	if (useLegacy) {
		const roster = [
			...state.activeRoster.starters.map((p) => `STARTER ${playerLine(p)}`),
			...state.activeRoster.bench.map((p) => `BENCH ${playerLine(p)}`),
		];
		const injuries = state.intelPacket.injuries.map(
			(inj) =>
				`${inj.playerName} ${inj.status} ${practiceLine(inj.practiceReport)} conf${inj.confidence}`,
		);
		const weather = state.intelPacket.weather.map(
			(wx) =>
				`${wx.game} ${wx.location} wind${wx.windMph} gust${wx.gustMph} ${wx.tempF}F precip${wx.precipPct} ${wx.weatherTag}`,
		);
		const beats = state.intelPacket.beatReports.map(
			(b) => `${b.handle} ${b.authorName} ${b.timestamp} ${b.claim}`,
		);
		return [
			`Week ${state.selectedWeek} full roster dump for start/sit.`,
			`Question: start ${playerA.name} or ${playerB.name}?`,
			"All rostered players:",
			...roster,
			"Injuries:",
			...injuries,
			"Weather:",
			...weather,
			"Beat reports:",
			...beats,
		].join("\n");
	}

	const intel = relatedIntel(state, [playerA, playerB]);
	return [
		`WK:${state.selectedWeek} PPR:0.5 LEAGUE:12`,
		`Q: ${recId(playerA)} vs ${recId(playerB)}`,
		`A: ${playerLine(playerA)}`,
		`B: ${playerLine(playerB)}`,
		"INTEL:",
		...(intel.length > 0 ? intel : ["- none"]),
		`FRESH:${state.intelPacket.fresh ? 1 : 0} HASH:${state.intelPacket.hash}`,
	].join("\n");
}

function parseJsonContent(content: string): unknown {
	const trimmed = content.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (!match) {
			throw new GrokRequestError(
				"Grok did not return JSON.",
				"XAI_INVALID_RESPONSE",
			);
		}
		try {
			return JSON.parse(match[0]);
		} catch {
			throw new GrokRequestError(
				"Grok JSON verdict could not be parsed.",
				"XAI_INVALID_RESPONSE",
			);
		}
	}
}

function asAction(value: unknown): GrokDecisionAction {
	if (typeof value === "string" && ACTIONS.includes(value as GrokDecisionAction)) {
		return value as GrokDecisionAction;
	}
	throw new GrokRequestError(
		"Grok verdict had an invalid act.",
		"XAI_INVALID_RESPONSE",
	);
}

function asFlags(value: unknown): IntelFlag[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((flag): flag is IntelFlag =>
		FLAGS.includes(flag as IntelFlag),
	);
}

function inverseAction(act: GrokDecisionAction): GrokDecisionAction {
	if (act === "START" || act === "SMASH" || act === "ADD") {
		return "SIT";
	}
	if (act === "SIT" || act === "DROP") {
		return "START";
	}
	return "HOLD";
}

export function parseGrokVerdict(
	payload: unknown,
	playerA: FantasyPlayer,
	playerB: FantasyPlayer,
): GrokRecommendation[] {
	if (!payload || typeof payload !== "object") {
		throw new GrokRequestError(
			"Grok verdict was empty.",
			"XAI_INVALID_RESPONSE",
		);
	}

	const body = payload as {
		act?: unknown;
		delta?: unknown;
		conf?: unknown;
		why?: unknown;
		flags?: unknown;
		recs?: unknown;
	};

	if (Array.isArray(body.recs) && body.recs.length > 0) {
		return body.recs.map((raw) => {
			const rec = raw as Partial<GrokRecommendation>;
			if (typeof rec.id !== "string" || rec.delta === undefined) {
				throw new GrokRequestError(
					"Grok recs were missing required fields.",
					"XAI_INVALID_RESPONSE",
				);
			}
			return {
				id: rec.id,
				act: asAction(rec.act),
				vs: typeof rec.vs === "string" ? rec.vs : "",
				delta: Number(rec.delta),
				conf: Number(rec.conf ?? 0),
				why: clipWhy(String(rec.why ?? "")),
				src: rec.src ?? "grok",
				flags: asFlags(rec.flags),
			};
		});
	}

	if (body.act === undefined || body.delta === undefined || body.conf === undefined) {
		throw new GrokRequestError(
			"Grok verdict was missing act, delta, or conf.",
			"XAI_INVALID_RESPONSE",
		);
	}

	const verdict: GrokStartSitVerdict = {
		act: asAction(body.act),
		delta: Number(body.delta),
		conf: Number(body.conf),
		why: clipWhy(String(body.why ?? "")),
		flags: asFlags(body.flags),
	};

	return [
		{
			id: recId(playerA),
			act: verdict.act,
			vs: recId(playerB),
			delta: verdict.delta,
			conf: verdict.conf,
			why: verdict.why,
			src: "grok",
			flags: verdict.flags,
		},
		{
			id: recId(playerB),
			act: inverseAction(verdict.act),
			vs: recId(playerA),
			delta: Number((-verdict.delta).toFixed(2)),
			conf: verdict.conf,
			why: verdict.why,
			src: "grok",
			flags: verdict.flags,
		},
	];
}

export function recommendationMatchesPlayer(
	rec: GrokRecommendation,
	player: FantasyPlayer,
): boolean {
	const recKey = rec.id.toLowerCase();
	const parts = player.name.toLowerCase().split(/\s+/);
	return (
		recKey === player.id.toLowerCase() ||
		parts.includes(recKey) ||
		recKey === parts[0] ||
		recKey === parts[parts.length - 1]
	);
}

export async function executeGrokDecision(
	state: CommandCenterState,
	playerAId: string,
	playerBId: string,
	options: ExecuteGrokDecisionOptions = {},
): Promise<GrokDecisionResponse> {
	const apiKey = options.apiKey?.trim();
	if (!apiKey) {
		throw new MissingXaiApiKeyError();
	}

	const playerA = resolvePlayer(state, playerAId);
	const playerB = resolvePlayer(state, playerBId);
	if (!playerA || !playerB) {
		throw new GrokRequestError(
			"Unknown player in start/sit query.",
			"XAI_INVALID_RESPONSE",
		);
	}

	const model = options.model ?? GROK_START_SIT_MODEL;
	const packet = buildCsspPacket(state, playerA, playerB, !!options.useLegacy);
	const fetchImpl = options.fetchImpl ?? fetch;

	const response = await fetchImpl(XAI_CHAT_COMPLETIONS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: packet },
			],
			response_format: {
				type: "json_schema",
				json_schema: START_SIT_JSON_SCHEMA,
			},
		}),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new GrokRequestError(
			`xAI request failed (${response.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
		);
	}

	const payload = (await response.json()) as XaiChatCompletion;
	const content = payload.choices?.[0]?.message?.content;
	if (!content) {
		throw new GrokRequestError(
			"xAI response was missing message content.",
			"XAI_INVALID_RESPONSE",
		);
	}

	const recs = parseGrokVerdict(parseJsonContent(content), playerA, playerB);
	const tokensUsed = extractTokenUsage(payload.usage);

	return {
		task: `WK${state.selectedWeek}_DECISION`,
		wk: state.selectedWeek,
		recs,
		tokensUsed,
		legacyTokensEquivalent: LEGACY_TOKENS_EQUIVALENT,
		cacheHit: false,
		timestamp: Date.now(),
		model: payload.model ?? model,
	};
}
