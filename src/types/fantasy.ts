/**
 * Fantasy Football Command Center Types
 * Compact Schema Syntax Protocol (CSSP), Grok Bot Intel, and State Storage
 */

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DST" | "FLEX";

export interface FantasyPlayer {
	id: string;
	name: string;
	pos: Position;
	team: string;
	opp: string;
	projPts: number;
	status: "ACTIVE" | "QUESTIONABLE" | "DOUBTFUL" | "OUT" | "IR";
	injuryDesc?: string;
	weatherCondition?: string;
	tags?: string[];
}

export type GrokDecisionAction =
	| "START"
	| "SIT"
	| "HOLD"
	| "ADD"
	| "DROP"
	| "TRADE_Y"
	| "TRADE_N"
	| "SMASH";

export type IntelFlag = "INJ" | "WX" | "NEWS" | "SPLIT" | "STALE";

export interface GrokRecommendation {
	id: string;
	act: GrokDecisionAction;
	vs: string;
	delta: number;
	conf: number;
	why: string; // Enforced <= 12 words
	src: string;
	flags: IntelFlag[];
}

export interface GrokDecisionResponse {
	task: string;
	wk: number;
	recs: GrokRecommendation[];
	tokensUsed: number;
	legacyTokensEquivalent: number;
	cacheHit: boolean;
	timestamp: number;
	model?: string;
}

export interface GrokApiErrorBody {
	error: string;
	code: "XAI_API_KEY_MISSING" | "XAI_REQUEST_FAILED" | "XAI_INVALID_RESPONSE";
}

export interface GrokStartSitVerdict {
	act: GrokDecisionAction;
	delta: number;
	conf: number;
	why: string;
	flags: IntelFlag[];
}

export interface BeatReporterIntel {
	id: string;
	handle: string; // e.g. "@RapSheet", "@AdamSchefter"
	authorName: string;
	timestamp: string;
	claim: string;
	playerId?: string;
	team: string;
	confidence: number;
	impactLevel: "HIGH" | "MEDIUM" | "LOW";
}

export interface WeatherIntel {
	game: string;
	location: string;
	isDome: boolean;
	windMph: number;
	gustMph: number;
	tempF: number;
	precipPct: number;
	weatherTag: "NONE" | "PASS-FADE" | "K-FADE" | "RB-BUMP" | "SLOP";
}

export interface InjuryReportIntel {
	playerId: string;
	playerName: string;
	team: string;
	status: "Q" | "D" | "OUT" | "IR" | "FULL";
	practiceReport: {
		wed: "DNP" | "LP" | "FP" | "-";
		thu: "DNP" | "LP" | "FP" | "-";
		fri: "DNP" | "LP" | "FP" | "-";
	};
	handcuffId?: string;
	handcuffName?: string;
	confidence: number;
}

export interface IntelCachePacket {
	week: number;
	asOf: string;
	fresh: boolean;
	hash: string;
	injuries: InjuryReportIntel[];
	weather: WeatherIntel[];
	beatReports: BeatReporterIntel[];
}

export interface TokenMetrics {
	queryType: string;
	legacyTokens: number;
	optimizedTokens: number;
	savingsPercent: number;
	latencyReductionMs: number;
}

export interface LeagueRoster {
	teamId: string;
	teamName: string;
	owner: string;
	record: string;
	rank: number;
	starters: FantasyPlayer[];
	bench: FantasyPlayer[];
}

export interface CommandCenterState {
	selectedWeek: number;
	activeRoster: LeagueRoster;
	intelPacket: IntelCachePacket;
	recommendations: GrokRecommendation[];
	tokenMetrics: TokenMetrics[];
	lastDecision: GrokDecisionResponse | null;
	liveAlerts: {
		id: string;
		time: string;
		type: "INJURY" | "WEATHER" | "LINEUP" | "GROK";
		message: string;
		severity: "warning" | "danger" | "info" | "success";
	}[];
}
