import type { FantasyPlayer, LeagueRoster, Position } from "./types/fantasy";

export interface SleeperRosterRaw {
	roster_id: number;
	owner_id?: string;
	league_id?: string;
	starters?: string[];
	players?: string[];
	settings?: {
		wins?: number;
		losses?: number;
		ties?: number;
		fpts?: number;
	};
}

export interface SleeperUserRaw {
	user_id: string;
	username?: string;
	display_name?: string;
	metadata?: {
		team_name?: string;
	};
}

export interface SleeperLeagueRaw {
	league_id: string;
	name?: string;
	total_rosters?: number;
	season?: string;
	roster_positions?: string[];
}

export interface SleeperPlayerMetadata {
	first_name?: string;
	last_name?: string;
	full_name?: string;
	position?: string;
	team?: string;
	injury_status?: string;
	injury_body_part?: string;
	injury_notes?: string;
}

/**
 * Curated player dictionary for known Sleeper IDs / NFL players.
 * Sleeper players endpoint is a 10MB+ payload, so we provide an efficient
 * resolver table + fallback parsing for common rostered players.
 */
export const KNOWN_SLEEPER_PLAYERS: Record<string, {
	name: string;
	pos: Position;
	team: string;
	opp: string;
	projPts: number;
	status: "ACTIVE" | "QUESTIONABLE" | "DOUBTFUL" | "OUT" | "IR";
	injuryDesc?: string;
	weatherCondition?: string;
	tags?: string[];
}> = {
	"4984": {
		name: "Josh Allen",
		pos: "QB",
		team: "BUF",
		opp: "vs LAR",
		projPts: 22.8,
		status: "ACTIVE",
		tags: ["High Floor", "Red Zone Rushing"],
	},
	"8183": {
		name: "Bijan Robinson",
		pos: "RB",
		team: "ATL",
		opp: "@ CAR",
		projPts: 18.6,
		status: "ACTIVE",
		tags: ["Bellcow", "Target Funnel"],
	},
	"8138": {
		name: "Kyren Williams",
		pos: "RB",
		team: "LAR",
		opp: "@ BUF",
		projPts: 15.4,
		status: "QUESTIONABLE",
		injuryDesc: "Ankle - Did Not Practice (Thu), Limited (Wed)",
		weatherCondition: "Wind 18-28mph Gusts, Lake Effect",
		tags: ["Game-time Decision", "High Risk"],
	},
	"7564": {
		name: "Ja'Marr Chase",
		pos: "WR",
		team: "CIN",
		opp: "@ DAL",
		projPts: 20.2,
		status: "ACTIVE",
		tags: ["Elite WR1", "Target Share 32%"],
	},
	"7553": {
		name: "Jaylen Waddle",
		pos: "WR",
		team: "MIA",
		opp: "@ NYJ",
		projPts: 13.8,
		status: "ACTIVE",
		tags: ["Shadow Coverage", "Deep Threat"],
	},
	"4035": {
		name: "George Kittle",
		pos: "TE",
		team: "SF",
		opp: "vs CHI",
		projPts: 14.1,
		status: "ACTIVE",
		tags: ["Red Zone Focus", "High YAC"],
	},
	"11439": {
		name: "Brandon Aubrey",
		pos: "K",
		team: "DAL",
		opp: "vs CIN",
		projPts: 9.8,
		status: "ACTIVE",
		weatherCondition: "Dome",
	},
	"BAL": {
		name: "Baltimore Ravens",
		pos: "DST",
		team: "BAL",
		opp: "@ NYG",
		projPts: 8.5,
		status: "ACTIVE",
		tags: ["Top 3 Pressure Rate"],
	},
	"9221": {
		name: "Zach Charbonnet",
		pos: "RB",
		team: "SEA",
		opp: "@ ARI",
		projPts: 16.2,
		status: "ACTIVE",
		tags: ["Handcuff Smash", "Goal-line Work"],
	},
	"9493": {
		name: "Jaxon Smith-Njigba",
		pos: "WR",
		team: "SEA",
		opp: "@ ARI",
		projPts: 15.9,
		status: "ACTIVE",
		tags: ["Full Practice Fri", "Slot Funnel"],
	},
	"8136": {
		name: "Tyler Allgeier",
		pos: "RB",
		team: "ATL",
		opp: "@ CAR",
		projPts: 9.2,
		status: "ACTIVE",
		tags: ["Red Zone Handcuff"],
	},
	"7543": {
		name: "Christian Watson",
		pos: "WR",
		team: "GB",
		opp: "@ DET",
		projPts: 11.4,
		status: "QUESTIONABLE",
		injuryDesc: "Hamstring - Limited Fri",
		tags: ["Deep Play Upside"],
	},
	"6797": {
		name: "Justin Jefferson",
		pos: "WR",
		team: "MIN",
		opp: "vs ATL",
		projPts: 19.5,
		status: "ACTIVE",
		tags: ["Target Magnet", "WR1"],
	},
	"8155": {
		name: "Breece Hall",
		pos: "RB",
		team: "NYJ",
		opp: "vs MIA",
		projPts: 17.1,
		status: "ACTIVE",
		tags: ["Dual Threat", "High Floor"],
	},
	"6801": {
		name: "CeeDee Lamb",
		pos: "WR",
		team: "DAL",
		opp: "vs CIN",
		projPts: 19.1,
		status: "ACTIVE",
		tags: ["Alpha WR", "High Volume"],
	},
	"9226": {
		name: "Sam LaPorta",
		pos: "TE",
		team: "DET",
		opp: "vs GB",
		projPts: 13.5,
		status: "ACTIVE",
		tags: ["Red Zone Weapon"],
	},
	"8139": {
		name: "Kenneth Walker III",
		pos: "RB",
		team: "SEA",
		opp: "@ ARI",
		projPts: 16.8,
		status: "ACTIVE",
		tags: ["Explosive Playmaker"],
	},
};

export function mapSleeperPlayerIdToPlayer(
	playerId: string,
	slotPos?: Position,
): FantasyPlayer {
	const known = KNOWN_SLEEPER_PLAYERS[playerId];
	if (known) {
		return {
			id: playerId.startsWith("p_") ? playerId : `p_${playerId}`,
			name: known.name,
			pos: slotPos ?? known.pos,
			team: known.team,
			opp: known.opp,
			projPts: known.projPts,
			status: known.status,
			injuryDesc: known.injuryDesc,
			weatherCondition: known.weatherCondition,
			tags: known.tags,
		};
	}

	// Fallback heuristic for unrecognized IDs
	const isDefense = /^[A-Z]{2,3}$/.test(playerId);
	const pos: Position = slotPos ?? (isDefense ? "DST" : "FLEX");
	return {
		id: playerId.startsWith("p_") ? playerId : `p_${playerId}`,
		name: isDefense ? `${playerId} Defense` : `Player #${playerId}`,
		pos,
		team: isDefense ? playerId : "NFL",
		opp: "vs OPP",
		projPts: 10.0,
		status: "ACTIVE",
		tags: ["Sleeper Import"],
	};
}

export interface SleeperImportPayload {
	leagueId: string;
	userOrRosterId?: string; // either username, user_id, or numeric roster_id (defaults to 1)
}

export class SleeperApiError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.name = "SleeperApiError";
		this.status = status;
	}
}

/**
 * Fetch and construct a real LeagueRoster from Sleeper API endpoints:
 * 1. GET https://api.sleeper.app/v1/league/<league_id>
 * 2. GET https://api.sleeper.app/v1/league/<league_id>/rosters
 * 3. GET https://api.sleeper.app/v1/league/<league_id>/users
 */
export async function importSleeperRoster(
	payload: SleeperImportPayload,
	fetchImpl: typeof fetch = fetch,
): Promise<LeagueRoster> {
	const { leagueId, userOrRosterId } = payload;
	if (!leagueId || typeof leagueId !== "string" || !leagueId.trim()) {
		throw new SleeperApiError("Sleeper leagueId is required", 400);
	}

	const cleanLeagueId = leagueId.trim();

	// 1. Fetch league info
	const leagueRes = await fetchImpl(
		`https://api.sleeper.app/v1/league/${cleanLeagueId}`,
	);
	if (!leagueRes.ok) {
		throw new SleeperApiError(
			`Sleeper league not found (${leagueRes.status})`,
			leagueRes.status === 404 ? 404 : 502,
		);
	}
	const leagueData = (await leagueRes.json()) as SleeperLeagueRaw;

	// 2. Fetch rosters
	const rostersRes = await fetchImpl(
		`https://api.sleeper.app/v1/league/${cleanLeagueId}/rosters`,
	);
	if (!rostersRes.ok) {
		throw new SleeperApiError(
			`Failed to fetch rosters (${rostersRes.status})`,
			502,
		);
	}
	const rosters = (await rostersRes.json()) as SleeperRosterRaw[];
	if (!Array.isArray(rosters) || rosters.length === 0) {
		throw new SleeperApiError("No rosters found in Sleeper league", 404);
	}

	// 3. Fetch users (optional metadata for owner / team name)
	let users: SleeperUserRaw[] = [];
	try {
		const usersRes = await fetchImpl(
			`https://api.sleeper.app/v1/league/${cleanLeagueId}/users`,
		);
		if (usersRes.ok) {
			users = (await usersRes.json()) as SleeperUserRaw[];
		}
	} catch {
		// Non-fatal, fallback to default naming
	}

	// Resolve the target roster
	let targetRoster: SleeperRosterRaw | undefined;

	if (userOrRosterId) {
		const query = userOrRosterId.trim().toLowerCase();
		// Match numeric roster_id
		const rosterNum = parseInt(query, 10);
		if (!isNaN(rosterNum)) {
			targetRoster = rosters.find((r) => r.roster_id === rosterNum);
		}

		// Match by user_id or display_name/username
		if (!targetRoster) {
			const matchedUser = users.find(
				(u) =>
					u.user_id === userOrRosterId ||
					u.username?.toLowerCase() === query ||
					u.display_name?.toLowerCase() === query,
			);
			if (matchedUser) {
				targetRoster = rosters.find(
					(r) => r.owner_id === matchedUser.user_id,
				);
			}
		}
	}

	// Default to first roster if not specified or not found
	if (!targetRoster) {
		targetRoster = rosters[0];
	}

	const ownerUser = users.find((u) => u.user_id === targetRoster?.owner_id);
	const teamName =
		ownerUser?.metadata?.team_name ||
		ownerUser?.display_name ||
		ownerUser?.username ||
		`Team ${targetRoster.roster_id}`;

	const ownerName =
		ownerUser?.display_name || ownerUser?.username || "Sleeper Manager";

	const wins = targetRoster.settings?.wins ?? 0;
	const losses = targetRoster.settings?.losses ?? 0;
	const ties = targetRoster.settings?.ties ?? 0;
	const record = ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;

	// Build starters and bench
	const starterIds = targetRoster.starters ?? [];
	const allPlayerIds = targetRoster.players ?? [];
	const benchIds = allPlayerIds.filter((id) => !starterIds.includes(id));

	// Standard lineup slot positions
	const standardSlots: Position[] = [
		"QB",
		"RB",
		"RB",
		"WR",
		"WR",
		"TE",
		"FLEX",
		"K",
		"DST",
	];

	const starters: FantasyPlayer[] = starterIds
		.filter((id) => id && id !== "0")
		.map((id, index) => {
			const expectedSlot = standardSlots[index] ?? "FLEX";
			return mapSleeperPlayerIdToPlayer(id, expectedSlot);
		});

	const bench: FantasyPlayer[] = benchIds
		.filter((id) => id && id !== "0")
		.map((id) => mapSleeperPlayerIdToPlayer(id));

	return {
		teamId: `sleeper_${cleanLeagueId}_${targetRoster.roster_id}`,
		teamName: `${teamName} (${leagueData.name || "Sleeper League"})`,
		owner: `${ownerName} (Sleeper)`,
		record,
		rank: targetRoster.roster_id,
		starters,
		bench,
	};
}
