import type { FantasyPlayer, LeagueRoster, Position } from "./types/fantasy";

/**
 * ESPN Fantasy Football v3 API Constants & Interfaces
 */
export const ESPN_FFL_API_BASE =
	"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

/**
 * ESPN Slot Category IDs (lineupSlotId in ESPN API)
 * 0: QB, 2: RB, 4: WR, 6: TE, 16: D/ST, 17: K, 20: Bench, 21: IR, 23: Flex (RB/WR/TE)
 */
export const ESPN_SLOT_MAP: Record<number, { pos: Position; isStarter: boolean }> = {
	0: { pos: "QB", isStarter: true },
	2: { pos: "RB", isStarter: true },
	4: { pos: "WR", isStarter: true },
	6: { pos: "TE", isStarter: true },
	16: { pos: "DST", isStarter: true },
	17: { pos: "K", isStarter: true },
	23: { pos: "FLEX", isStarter: true },
	20: { pos: "RB", isStarter: false }, // Default bench pos resolved via defaultPositionId
	21: { pos: "RB", isStarter: false }, // IR
};

/**
 * ESPN Default Position IDs (defaultPositionId on player object)
 * 1: QB, 2: RB, 3: WR, 4: TE, 5: K, 16: D/ST
 */
export const ESPN_DEFAULT_POS_MAP: Record<number, Position> = {
	1: "QB",
	2: "RB",
	3: "WR",
	4: "TE",
	5: "K",
	16: "DST",
};

/**
 * ESPN Pro Team IDs mapping to NFL Tri-codes
 */
export const ESPN_PRO_TEAM_MAP: Record<number, string> = {
	1: "ATL",
	2: "BUF",
	3: "CHI",
	4: "CIN",
	5: "CLE",
	6: "DAL",
	7: "DEN",
	8: "DET",
	9: "GB",
	10: "TEN",
	11: "IND",
	12: "KC",
	13: "LV",
	14: "LAR",
	15: "MIA",
	16: "MIN",
	17: "NE",
	18: "NO",
	19: "NYG",
	20: "NYJ",
	21: "PHI",
	22: "ARI",
	23: "PIT",
	24: "LAC",
	25: "SF",
	26: "SEA",
	27: "TB",
	28: "WAS",
	29: "CAR",
	30: "JAX",
	33: "BAL",
	34: "HOU",
};

export class MissingEspnCredentialsError extends Error {
	readonly code = "ESPN_CREDENTIALS_MISSING" as const;

	constructor(details?: string) {
		super(
			details ||
				"ESPN credentials missing: espn_s2, SWID, and leagueId are required to fetch private ESPN leagues.",
		);
		this.name = "MissingEspnCredentialsError";
	}
}

export class EspnRequestError extends Error {
	readonly code:
		| "ESPN_REQUEST_FAILED"
		| "ESPN_INVALID_RESPONSE"
		| "ESPN_AUTH_UNAUTHORIZED";
	readonly status?: number;

	constructor(
		message: string,
		code:
			| "ESPN_REQUEST_FAILED"
			| "ESPN_INVALID_RESPONSE"
			| "ESPN_AUTH_UNAUTHORIZED" = "ESPN_REQUEST_FAILED",
		status?: number,
	) {
		super(message);
		this.name = "EspnRequestError";
		this.code = code;
		this.status = status;
	}
}

export interface EspnFetchOptions {
	leagueId: string | number;
	season?: number;
	espnS2?: string;
	swid?: string;
	fetchImpl?: typeof fetch;
}

export interface EspnRawPlayerEntry {
	lineupSlotId: number;
	playerPoolEntry?: {
		appliedStatTotal?: number;
		player?: {
			id: number;
			fullName: string;
			defaultPositionId: number;
			proTeamId: number;
			injuryStatus?: string;
			injured?: boolean;
		};
		ratings?: Record<string, { totalRating?: number }>;
	};
}

export interface EspnRawTeam {
	id: number;
	name?: string;
	location?: string;
	nickname?: string;
	abbrev?: string;
	owners?: string[];
	primaryOwner?: string;
	record?: {
		overall?: {
			wins: number;
			losses: number;
			ties: number;
			pointsFor?: number;
			pointsAgainst?: number;
		};
	};
	playoffSeed?: number;
	roster?: {
		entries?: EspnRawPlayerEntry[];
	};
}

export interface EspnRawLeagueResponse {
	id: number;
	seasonId: number;
	scoringPeriodId?: number;
	currentPeriodId?: number;
	status?: {
		currentMatchupPeriod?: number;
		latestScoringPeriod?: number;
	};
	teams?: EspnRawTeam[];
	members?: Array<{
		id: string;
		displayName: string;
		firstName?: string;
		lastName?: string;
	}>;
}

/**
 * Builds standard ESPN API URL for league view
 */
export function buildEspnApiUrl(
	season: number | string,
	leagueId: number | string,
): string {
	return `${ESPN_FFL_API_BASE}/${season}/segments/0/leagues/${leagueId}?view=mRoster&view=mTeam`;
}

/**
 * Builds Cookie header string for authenticated ESPN API requests
 */
export function buildEspnCookieHeader(espnS2?: string, swid?: string): string {
	const cookies: string[] = [];
	if (espnS2) {
		cookies.push(`espn_s2=${espnS2.trim()}`);
	}
	if (swid) {
		cookies.push(`SWID=${swid.trim()}`);
	}
	return cookies.join("; ");
}

/**
 * Fetch raw ESPN League JSON dump
 */
export async function fetchEspnLeagueData(
	options: EspnFetchOptions,
): Promise<{ rawJson: EspnRawLeagueResponse; rawBytes: number }> {
	const season = options.season || 2024;
	const leagueId = options.leagueId;

	if (!leagueId) {
		throw new MissingEspnCredentialsError("ESPN leagueId is required.");
	}

	const url = buildEspnApiUrl(season, leagueId);
	const cookieHeader = buildEspnCookieHeader(options.espnS2, options.swid);

	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (cookieHeader) {
		headers.Cookie = cookieHeader;
	}

	const fetcher = options.fetchImpl || fetch;
	let response: Response;

	try {
		response = await fetcher(url, {
			method: "GET",
			headers,
		});
	} catch (err) {
		throw new EspnRequestError(
			`Network fetch to ESPN API failed: ${err instanceof Error ? err.message : String(err)}`,
			"ESPN_REQUEST_FAILED",
		);
	}

	if (response.status === 401 || response.status === 403) {
		throw new EspnRequestError(
			`ESPN API authentication failed (${response.status}). Ensure espn_s2 and SWID cookies are valid for private league ${leagueId}.`,
			"ESPN_AUTH_UNAUTHORIZED",
			response.status,
		);
	}

	if (!response.ok) {
		throw new EspnRequestError(
			`ESPN API returned status ${response.status} for league ${leagueId}.`,
			"ESPN_REQUEST_FAILED",
			response.status,
		);
	}

	const rawText = await response.text();
	const rawBytes = new TextEncoder().encode(rawText).length;

	try {
		const rawJson = JSON.parse(rawText) as EspnRawLeagueResponse;
		return { rawJson, rawBytes };
	} catch {
		throw new EspnRequestError(
			"Failed to parse ESPN API response as JSON.",
			"ESPN_INVALID_RESPONSE",
		);
	}
}

/**
 * Sanitizes and compresses verbose ESPN raw JSON payload into compact CSSP LeagueRoster
 */
export function sanitizeEspnTeamRoster(
	raw: EspnRawLeagueResponse,
	targetTeamId?: number | string,
): { roster: LeagueRoster; week: number; sanitizedTokensEstimate: number } {
	if (!raw.teams || !Array.isArray(raw.teams) || raw.teams.length === 0) {
		throw new EspnRequestError(
			"Invalid ESPN response: no teams found in league payload.",
			"ESPN_INVALID_RESPONSE",
		);
	}

	// Select team: by targetTeamId, or the first team if omitted
	let team: EspnRawTeam | undefined;
	if (targetTeamId !== undefined && targetTeamId !== "") {
		team = raw.teams.find((t) => String(t.id) === String(targetTeamId));
	}
	if (!team) {
		team = raw.teams[0];
	}

	const teamName =
		team.name ||
		(team.location && team.nickname ? `${team.location} ${team.nickname}` : "") ||
		`ESPN Team ${team.id}`;

	// Find owner name from members array
	let ownerName = "ESPN Team Owner";
	const ownerId = team.primaryOwner || (team.owners && team.owners[0]);
	if (ownerId && raw.members) {
		const member = raw.members.find((m) => m.id === ownerId);
		if (member) {
			ownerName =
				member.displayName ||
				`${member.firstName || ""} ${member.lastName || ""}`.trim() ||
				ownerName;
		}
	}

	const wins = team.record?.overall?.wins ?? 0;
	const losses = team.record?.overall?.losses ?? 0;
	const ties = team.record?.overall?.ties ?? 0;
	const record = ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
	const rank = team.playoffSeed ?? 1;

	const starters: FantasyPlayer[] = [];
	const bench: FantasyPlayer[] = [];

	const entries = team.roster?.entries || [];

	for (const entry of entries) {
		const poolEntry = entry.playerPoolEntry;
		const player = poolEntry?.player;
		if (!player) continue;

		const slotConfig = ESPN_SLOT_MAP[entry.lineupSlotId] || {
			pos: "RB",
			isStarter: false,
		};
		const defaultPos = ESPN_DEFAULT_POS_MAP[player.defaultPositionId] || "RB";
		const assignedPos: Position = slotConfig.isStarter
			? slotConfig.pos
			: defaultPos;

		const proTeam = ESPN_PRO_TEAM_MAP[player.proTeamId] || "NFL";
		const projPts =
			typeof poolEntry.appliedStatTotal === "number"
				? Math.round(poolEntry.appliedStatTotal * 10) / 10
				: 10.0;

		let status: FantasyPlayer["status"] = "ACTIVE";
		const espnStatus = (player.injuryStatus || "").toUpperCase();
		if (espnStatus === "QUESTIONABLE") status = "QUESTIONABLE";
		else if (espnStatus === "DOUBTFUL") status = "DOUBTFUL";
		else if (espnStatus === "OUT") status = "OUT";
		else if (espnStatus === "INJURY_RESERVE" || espnStatus === "IR")
			status = "IR";

		const tags: string[] = [];
		if (status !== "ACTIVE") {
			tags.push(status);
		}
		if (projPts >= 18) {
			tags.push("High Floor");
		}

		const fantasyPlayer: FantasyPlayer = {
			id: `espn_${player.id}`,
			name: player.fullName,
			pos: assignedPos,
			team: proTeam,
			opp: `vs NFL`,
			projPts,
			status,
			injuryDesc:
				status !== "ACTIVE"
					? `${player.injuryStatus || status} on ESPN injury wire`
					: undefined,
			tags: tags.length > 0 ? tags : undefined,
		};

		if (slotConfig.isStarter) {
			starters.push(fantasyPlayer);
		} else {
			bench.push(fantasyPlayer);
		}
	}

	const week =
		raw.scoringPeriodId ||
		raw.currentPeriodId ||
		raw.status?.latestScoringPeriod ||
		14;

	const roster: LeagueRoster = {
		teamId: `espn_team_${team.id}`,
		teamName,
		owner: ownerName,
		record,
		rank,
		starters,
		bench,
	};

	// Approximate CSSP token footprint (~4 tokens per player + roster envelope)
	const sanitizedTokensEstimate = (starters.length + bench.length) * 12 + 60;

	return {
		roster,
		week,
		sanitizedTokensEstimate,
	};
}
