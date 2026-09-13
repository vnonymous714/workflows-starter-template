import type {
	FantasyPlayer,
	InjuryReportIntel,
	LeagueRoster,
	Position,
	SleeperErrorCode,
	SleeperLeagueOption,
} from "./types/fantasy";

export const SLEEPER_API_BASE = "https://api.sleeper.app/v1";
export const ESPN_SCOREBOARD_URL =
	"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export class SleeperRequestError extends Error {
	readonly code: SleeperErrorCode;
	readonly status: number;

	constructor(message: string, code: SleeperErrorCode, status = 502) {
		super(message);
		this.name = "SleeperRequestError";
		this.code = code;
		this.status = status;
	}
}

export interface SleeperImportInput {
	username: string;
	leagueId?: string;
	rosterId?: number;
}

export interface SleeperImportResult {
	week: number;
	season: string;
	roster: LeagueRoster;
	injuries: InjuryReportIntel[];
}

interface SleeperNflState {
	week?: number;
	display_week?: number;
	season?: string;
	league_season?: string;
}

interface SleeperUser {
	user_id: string;
	username?: string;
	display_name?: string;
}

interface SleeperLeague {
	league_id: string;
	name?: string;
	roster_positions?: string[];
	season?: string;
	scoring_settings?: { rec?: number };
}

interface SleeperRoster {
	roster_id: number;
	owner_id?: string | null;
	players?: string[] | null;
	starters?: string[] | null;
	reserve?: string[] | null;
	taxi?: string[] | null;
	settings?: {
		wins?: number;
		losses?: number;
		ties?: number;
		fpts?: number;
	};
}

interface SleeperLeagueUser {
	user_id: string;
	display_name?: string;
	metadata?: { team_name?: string };
}

interface SleeperPlayer {
	player_id?: string;
	first_name?: string;
	last_name?: string;
	full_name?: string;
	position?: string;
	team?: string | null;
	injury_status?: string | null;
	injury_body_part?: string | null;
	injury_notes?: string | null;
	status?: string | null;
}

interface EspnScoreboard {
	events?: Array<{
		competitions?: Array<{
			competitors?: Array<{
				homeAway?: string;
				team?: { abbreviation?: string };
			}>;
		}>;
	}>;
}

const STARTER_SLOT_SKIP = new Set(["BN", "IR", "TAXI"]);

export async function importSleeperRoster(
	input: SleeperImportInput,
	fetchImpl: typeof fetch = fetch,
): Promise<SleeperImportResult> {
	const username = input.username.trim();
	if (!username) {
		throw new SleeperRequestError(
			"Sleeper username is required.",
			"SLEEPER_USERNAME_REQUIRED",
			400,
		);
	}

	const nfl = await getJson<SleeperNflState>(
		fetchImpl,
		`${SLEEPER_API_BASE}/state/nfl`,
		"SLEEPER_REQUEST_FAILED",
	);
	const week = Number(nfl.display_week ?? nfl.week ?? 1) || 1;
	const season = String(nfl.league_season ?? nfl.season ?? new Date().getFullYear());

	const user = await getJson<SleeperUser | null>(
		fetchImpl,
		`${SLEEPER_API_BASE}/user/${encodeURIComponent(username)}`,
		"SLEEPER_USER_NOT_FOUND",
		404,
	);
	if (!user?.user_id) {
		throw new SleeperRequestError(
			`Sleeper user "${username}" was not found.`,
			"SLEEPER_USER_NOT_FOUND",
			404,
		);
	}

	const leagues = await getJson<SleeperLeague[]>(
		fetchImpl,
		`${SLEEPER_API_BASE}/user/${user.user_id}/leagues/nfl/${season}`,
		"SLEEPER_LEAGUE_NOT_FOUND",
	);
	if (!Array.isArray(leagues) || leagues.length === 0) {
		throw new SleeperRequestError(
			`No NFL leagues found for "${username}" in ${season}.`,
			"SLEEPER_LEAGUE_NOT_FOUND",
			404,
		);
	}

	const availableLeagues: SleeperLeagueOption[] = leagues.map((league) => ({
		leagueId: league.league_id,
		name: league.name || league.league_id,
	}));

	const league =
		(input.leagueId
			? leagues.find((item) => item.league_id === input.leagueId)
			: leagues[0]) ?? null;
	if (!league) {
		throw new SleeperRequestError(
			`Sleeper league ${input.leagueId} was not found for "${username}".`,
			"SLEEPER_LEAGUE_NOT_FOUND",
			404,
		);
	}

	const [rosters, leagueUsers, players, opponents] = await Promise.all([
		getJson<SleeperRoster[]>(
			fetchImpl,
			`${SLEEPER_API_BASE}/league/${league.league_id}/rosters`,
			"SLEEPER_REQUEST_FAILED",
		),
		getJson<SleeperLeagueUser[]>(
			fetchImpl,
			`${SLEEPER_API_BASE}/league/${league.league_id}/users`,
			"SLEEPER_REQUEST_FAILED",
		),
		getJson<Record<string, SleeperPlayer>>(
			fetchImpl,
			`${SLEEPER_API_BASE}/players/nfl`,
			"SLEEPER_REQUEST_FAILED",
		),
		loadOpponentMap(fetchImpl),
	]);

	const roster = pickRoster(rosters, user.user_id, input.rosterId);
	if (!roster) {
		throw new SleeperRequestError(
			`No Sleeper roster found for "${username}" in ${league.name ?? league.league_id}.`,
			"SLEEPER_ROSTER_NOT_FOUND",
			404,
		);
	}

	const owner =
		leagueUsers.find((item) => item.user_id === roster.owner_id) ??
		leagueUsers.find((item) => item.user_id === user.user_id);
	const mapped = mapLeagueRoster({
		roster,
		rosters,
		league,
		owner,
		user,
		username,
		players,
		opponents,
		availableLeagues,
	});

	return {
		week,
		season,
		roster: mapped.roster,
		injuries: mapped.injuries,
	};
}

export function mapSleeperInjuryStatus(
	injury: string | null | undefined,
): FantasyPlayer["status"] {
	switch ((injury ?? "").trim().toUpperCase()) {
		case "QUESTIONABLE":
		case "Q":
			return "QUESTIONABLE";
		case "DOUBTFUL":
		case "D":
			return "DOUBTFUL";
		case "OUT":
			return "OUT";
		case "IR":
		case "PUP":
		case "SUS":
		case "NA":
			return "IR";
		default:
			return "ACTIVE";
	}
}

export function mapSleeperPosition(raw: string | undefined): Position {
	const pos = (raw ?? "").toUpperCase();
	if (pos === "DEF" || pos === "DST") return "DST";
	if (pos === "QB" || pos === "RB" || pos === "WR" || pos === "TE" || pos === "K") {
		return pos;
	}
	return "FLEX";
}

function pickRoster(
	rosters: SleeperRoster[],
	userId: string,
	rosterId?: number,
): SleeperRoster | undefined {
	if (typeof rosterId === "number") {
		return rosters.find((item) => item.roster_id === rosterId);
	}
	return (
		rosters.find((item) => item.owner_id === userId) ??
		rosters.find((item) => (item.players ?? []).length > 0)
	);
}

function mapLeagueRoster(args: {
	roster: SleeperRoster;
	rosters: SleeperRoster[];
	league: SleeperLeague;
	owner: SleeperLeagueUser | undefined;
	user: SleeperUser;
	username: string;
	players: Record<string, SleeperPlayer>;
	opponents: Map<string, string>;
	availableLeagues: SleeperLeagueOption[];
}): { roster: LeagueRoster; injuries: InjuryReportIntel[] } {
	const reserved = new Set(
		[...(args.roster.reserve ?? []), ...(args.roster.taxi ?? [])].filter(
			isRealPlayerId,
		),
	);
	const rawStarters = args.roster.starters ?? [];
	const starterSet = new Set(rawStarters.filter(isRealPlayerId));
	const benchIds = (args.roster.players ?? []).filter(
		(id) => isRealPlayerId(id) && !starterSet.has(id) && !reserved.has(id),
	);

	const slots = (args.league.roster_positions ?? []).filter(
		(slot) => !STARTER_SLOT_SKIP.has(slot),
	);

	const starters = rawStarters.flatMap((id, index) =>
		isRealPlayerId(id)
			? [toFantasyPlayer(id, args.players, args.opponents, slots[index])]
			: [],
	);
	const bench = benchIds.map((id) =>
		toFantasyPlayer(id, args.players, args.opponents),
	);

	const injuries: InjuryReportIntel[] = [...starters, ...bench]
		.filter((player) => player.status !== "ACTIVE")
		.map((player) => ({
			playerId: player.id,
			playerName: player.name,
			team: player.team,
			status:
				player.status === "QUESTIONABLE"
					? "Q"
					: player.status === "DOUBTFUL"
						? "D"
						: player.status === "OUT"
							? "OUT"
							: "IR",
			practiceReport: { wed: "-", thu: "-", fri: "-" },
			confidence: 0.7,
		}));

	const wins = args.roster.settings?.wins ?? 0;
	const losses = args.roster.settings?.losses ?? 0;
	const ties = args.roster.settings?.ties ?? 0;
	const record = ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;

	const ranked = [...args.rosters].sort((a, b) => {
		const winDiff = (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0);
		if (winDiff !== 0) return winDiff;
		return (b.settings?.fpts ?? 0) - (a.settings?.fpts ?? 0);
	});
	const rank =
		ranked.findIndex((item) => item.roster_id === args.roster.roster_id) + 1;

	const teamName =
		args.owner?.metadata?.team_name?.trim() ||
		args.owner?.display_name ||
		args.user.display_name ||
		args.username;
	const ownerName =
		args.owner?.display_name || args.user.display_name || args.username;

	return {
		roster: {
			teamId: `sleeper_${args.league.league_id}_${args.roster.roster_id}`,
			teamName,
			owner: ownerName,
			record,
			rank: rank || 1,
			starters,
			bench,
			source: {
				provider: "sleeper",
				username: args.username,
				userId: args.user.user_id,
				leagueId: args.league.league_id,
				leagueName: args.league.name || args.league.league_id,
				rosterId: args.roster.roster_id,
				importedAt: Date.now(),
				availableLeagues: args.availableLeagues,
			},
		},
		injuries,
	};
}

function toFantasyPlayer(
	id: string,
	players: Record<string, SleeperPlayer>,
	opponents: Map<string, string>,
	slot?: string,
): FantasyPlayer {
	const raw = players[id] ?? {};
	const name =
		raw.full_name?.trim() ||
		[raw.first_name, raw.last_name].filter(Boolean).join(" ").trim() ||
		(raw.position === "DEF" && raw.team ? `${raw.team} Defense` : id);
	const team = (raw.team ?? "FA").toUpperCase();
	const pos = mapSleeperPosition(slot === "FLEX" ? raw.position : (slot ?? raw.position));
	const status = mapSleeperInjuryStatus(raw.injury_status);
	const injuryDesc = [raw.injury_status, raw.injury_body_part, raw.injury_notes]
		.filter(Boolean)
		.join(" - ");

	return {
		id,
		name,
		pos: pos === "FLEX" ? mapSleeperPosition(raw.position) : pos,
		team,
		opp: opponents.get(normalizeTeam(team)) ?? "—",
		projPts: 0,
		status,
		injuryDesc: injuryDesc || undefined,
	};
}

function isRealPlayerId(id: string | null | undefined): id is string {
	return Boolean(id && id !== "0");
}

function normalizeTeam(abbr: string): string {
	const team = abbr.toUpperCase();
	if (team === "JAC") return "JAX";
	if (team === "WSH") return "WAS";
	return team;
}

async function loadOpponentMap(fetchImpl: typeof fetch): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	try {
		const board = await getJson<EspnScoreboard>(
			fetchImpl,
			ESPN_SCOREBOARD_URL,
			"SLEEPER_REQUEST_FAILED",
		);
		for (const event of board.events ?? []) {
			const competitors = event.competitions?.[0]?.competitors ?? [];
			const home = competitors.find((item) => item.homeAway === "home");
			const away = competitors.find((item) => item.homeAway === "away");
			const homeAbbr = normalizeTeam(home?.team?.abbreviation ?? "");
			const awayAbbr = normalizeTeam(away?.team?.abbreviation ?? "");
			if (!homeAbbr || !awayAbbr) continue;
			map.set(homeAbbr, `vs ${awayAbbr}`);
			map.set(awayAbbr, `@ ${homeAbbr}`);
		}
	} catch {
		// Opponent lines are optional; Sleeper import still succeeds without ESPN.
	}
	return map;
}

async function getJson<T>(
	fetchImpl: typeof fetch,
	url: string,
	failureCode: SleeperErrorCode,
	emptyStatus = 502,
): Promise<T> {
	let response: Response;
	try {
		response = await fetchImpl(url);
	} catch (error) {
		throw new SleeperRequestError(
			error instanceof Error ? error.message : `Failed to fetch ${url}`,
			"SLEEPER_REQUEST_FAILED",
			502,
		);
	}

	if (response.status === 404) {
		throw new SleeperRequestError(
			failureCode === "SLEEPER_USER_NOT_FOUND"
				? "Sleeper user was not found."
				: failureCode === "SLEEPER_LEAGUE_NOT_FOUND"
					? "Sleeper league was not found."
					: "Sleeper returned 404.",
			failureCode,
			404,
		);
	}

	if (!response.ok) {
		throw new SleeperRequestError(
			`Sleeper request failed (${response.status}).`,
			"SLEEPER_REQUEST_FAILED",
			emptyStatus,
		);
	}

	const text = await response.text();
	if (!text || text === "null") {
		throw new SleeperRequestError(
			failureCode === "SLEEPER_USER_NOT_FOUND"
				? "Sleeper user was not found."
				: failureCode === "SLEEPER_LEAGUE_NOT_FOUND"
					? "No NFL leagues found for that Sleeper user."
					: "Sleeper returned an empty response.",
			failureCode,
			404,
		);
	}

	return JSON.parse(text) as T;
}
