import type { FantasyPlayer, WeatherIntel } from "./types/fantasy";

const ESPN_SCOREBOARD_URL =
	"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

type WeatherTag = WeatherIntel["weatherTag"];

interface EspnGame {
	home: string;
	away: string;
	indoor: boolean;
	venueName: string;
	city: string;
	espnTempF?: number;
	espnCondition?: string;
}

const DOME_TEAMS = new Set([
	"ARI",
	"ATL",
	"DAL",
	"DET",
	"HOU",
	"IND",
	"LAC",
	"LAR",
	"LV",
	"MIN",
	"NO",
]);

/** Home stadium coordinates for weather.gov (outdoor / retractable treated as listed). */
const STADIUMS: Record<string, { lat: number; lon: number; name: string }> = {
	ARI: { lat: 33.5276, lon: -112.2626, name: "State Farm Stadium" },
	ATL: { lat: 33.7553, lon: -84.4006, name: "Mercedes-Benz Stadium" },
	BAL: { lat: 39.278, lon: -76.6227, name: "M&T Bank Stadium" },
	BUF: { lat: 42.7738, lon: -78.7869, name: "Highmark Stadium" },
	CAR: { lat: 35.2258, lon: -80.8528, name: "Bank of America Stadium" },
	CHI: { lat: 41.8623, lon: -87.6167, name: "Soldier Field" },
	CIN: { lat: 39.0954, lon: -84.516, name: "Paycor Stadium" },
	CLE: { lat: 41.5061, lon: -81.6995, name: "Huntington Bank Field" },
	DAL: { lat: 32.7473, lon: -97.0945, name: "AT&T Stadium" },
	DEN: { lat: 39.7439, lon: -105.0201, name: "Empower Field" },
	DET: { lat: 42.34, lon: -83.0456, name: "Ford Field" },
	GB: { lat: 44.5013, lon: -88.0622, name: "Lambeau Field" },
	HOU: { lat: 29.6847, lon: -95.4107, name: "NRG Stadium" },
	IND: { lat: 39.7601, lon: -86.1639, name: "Lucas Oil Stadium" },
	JAX: { lat: 30.3239, lon: -81.6373, name: "EverBank Stadium" },
	KC: { lat: 39.0489, lon: -94.4839, name: "Arrowhead Stadium" },
	LAC: { lat: 33.9535, lon: -118.339, name: "SoFi Stadium" },
	LAR: { lat: 33.9535, lon: -118.339, name: "SoFi Stadium" },
	LV: { lat: 36.0908, lon: -115.1833, name: "Allegiant Stadium" },
	MIA: { lat: 25.958, lon: -80.2389, name: "Hard Rock Stadium" },
	MIN: { lat: 44.9738, lon: -93.2575, name: "U.S. Bank Stadium" },
	NE: { lat: 42.0909, lon: -71.2643, name: "Gillette Stadium" },
	NO: { lat: 29.9511, lon: -90.0812, name: "Caesars Superdome" },
	NYG: { lat: 40.8128, lon: -74.0742, name: "MetLife Stadium" },
	NYJ: { lat: 40.8128, lon: -74.0742, name: "MetLife Stadium" },
	PHI: { lat: 39.9008, lon: -75.1675, name: "Lincoln Financial Field" },
	PIT: { lat: 40.4468, lon: -80.0158, name: "Acrisure Stadium" },
	SEA: { lat: 47.5952, lon: -122.3316, name: "Lumen Field" },
	SF: { lat: 37.403, lon: -121.9697, name: "Levi's Stadium" },
	TB: { lat: 27.9759, lon: -82.5033, name: "Raymond James Stadium" },
	TEN: { lat: 36.1665, lon: -86.7713, name: "Nissan Stadium" },
	WAS: { lat: 38.9077, lon: -76.8645, name: "Northwest Stadium" },
};

const WEATHER_GOV_UA =
	"FantasyCommandCenter/1.0 (https://github.com/vnonymous714/workflows-starter-template)";

export function normalizeTeam(abbr: string): string {
	const team = abbr.toUpperCase();
	if (team === "JAC") return "JAX";
	if (team === "WSH") return "WAS";
	return team;
}

function parseWindMph(text: string | null | undefined): number {
	if (!text) return 0;
	const match = String(text).match(/(\d+)/);
	return match ? Number(match[1]) : 0;
}

function tagWeather(input: {
	indoor: boolean;
	windMph: number;
	gustMph: number;
	precipPct: number;
	condition?: string;
}): WeatherTag {
	if (input.indoor) return "NONE";
	const condition = (input.condition ?? "").toLowerCase();
	const snow = condition.includes("snow") || condition.includes("sleet");
	const rain =
		condition.includes("rain") ||
		condition.includes("shower") ||
		condition.includes("storm");
	if (snow || input.precipPct >= 60) return "SLOP";
	if (input.windMph >= 18 || input.gustMph >= 28) return "PASS-FADE";
	if (input.windMph >= 15) return "K-FADE";
	if (input.precipPct >= 40 || rain) return "RB-BUMP";
	return "NONE";
}

function weatherLine(wx: WeatherIntel): string {
	if (wx.isDome) return "Dome";
	if (wx.weatherTag === "NONE") {
		return `${wx.tempF}F ${wx.location}`;
	}
	return `${wx.weatherTag} wind${wx.windMph} gust${wx.gustMph} ${wx.tempF}F`;
}

export function applyWeatherToPlayers(
	players: FantasyPlayer[],
	weather: WeatherIntel[],
): void {
	for (const player of players) {
		const wx = weather.find((item) => item.game.includes(player.team));
		if (wx) {
			player.weatherCondition = weatherLine(wx);
		}
	}
}

export async function loadEspnGames(
	fetchImpl: typeof fetch = fetch,
): Promise<{ opponents: Map<string, string>; games: EspnGame[] }> {
	const opponents = new Map<string, string>();
	const games: EspnGame[] = [];
	try {
		const response = await fetchImpl(ESPN_SCOREBOARD_URL);
		if (!response.ok) return { opponents, games };
		const board = (await response.json()) as {
			events?: Array<{
				weather?: { temperature?: number; displayValue?: string };
				competitions?: Array<{
					venue?: {
						indoor?: boolean;
						fullName?: string;
						address?: { city?: string };
					};
					competitors?: Array<{
						homeAway?: string;
						team?: { abbreviation?: string };
					}>;
				}>;
			}>;
		};
		for (const event of board.events ?? []) {
			const competition = event.competitions?.[0];
			const competitors = competition?.competitors ?? [];
			const home = normalizeTeam(
				competitors.find((item) => item.homeAway === "home")?.team
					?.abbreviation ?? "",
			);
			const away = normalizeTeam(
				competitors.find((item) => item.homeAway === "away")?.team
					?.abbreviation ?? "",
			);
			if (!home || !away) continue;
			opponents.set(home, `vs ${away}`);
			opponents.set(away, `@ ${home}`);
			const indoor = Boolean(competition?.venue?.indoor) || DOME_TEAMS.has(home);
			games.push({
				home,
				away,
				indoor,
				venueName: competition?.venue?.fullName || STADIUMS[home]?.name || home,
				city: competition?.venue?.address?.city || "",
				espnTempF:
					typeof event.weather?.temperature === "number"
						? event.weather.temperature
						: undefined,
				espnCondition: event.weather?.displayValue,
			});
		}
	} catch {
		// ESPN is optional.
	}
	return { opponents, games };
}

export async function buildWeatherIntel(
	fetchImpl: typeof fetch,
	games: EspnGame[],
	teams: string[],
): Promise<WeatherIntel[]> {
	const wanted = new Set(teams.map(normalizeTeam).filter(Boolean));
	const relevant = games.filter(
		(game) => wanted.has(game.home) || wanted.has(game.away),
	);
	const weather: WeatherIntel[] = [];

	for (const game of relevant) {
		const indoor = game.indoor || DOME_TEAMS.has(game.home);
		let windMph = 0;
		let gustMph = 0;
		let precipPct = 0;
		let tempF = game.espnTempF ?? 0;
		let condition = game.espnCondition ?? "";

		if (!indoor) {
			const nws = await fetchNwsHourly(fetchImpl, game.home);
			if (nws) {
				windMph = nws.windMph;
				gustMph = nws.gustMph;
				precipPct = nws.precipPct;
				tempF = nws.tempF || tempF;
				condition = nws.condition || condition;
			}
		}

		const weatherTag = tagWeather({
			indoor,
			windMph,
			gustMph,
			precipPct,
			condition,
		});
		weather.push({
			game: `${game.away} @ ${game.home}`,
			location: [game.venueName, game.city].filter(Boolean).join(" · "),
			isDome: indoor,
			windMph,
			gustMph,
			tempF,
			precipPct,
			weatherTag,
		});
	}

	return weather;
}

async function fetchNwsHourly(
	fetchImpl: typeof fetch,
	homeTeam: string,
): Promise<{
	windMph: number;
	gustMph: number;
	precipPct: number;
	tempF: number;
	condition: string;
} | null> {
	const stadium = STADIUMS[homeTeam];
	if (!stadium) return null;
	try {
		const pointsUrl = `https://api.weather.gov/points/${stadium.lat},${stadium.lon}`;
		const pointsRes = await fetchImpl(pointsUrl, {
			headers: { "User-Agent": WEATHER_GOV_UA, Accept: "application/geo+json" },
		});
		if (!pointsRes.ok) return null;
		const points = (await pointsRes.json()) as {
			properties?: { forecastHourly?: string };
		};
		const hourlyUrl = points.properties?.forecastHourly;
		if (!hourlyUrl) return null;
		const hourlyRes = await fetchImpl(hourlyUrl, {
			headers: { "User-Agent": WEATHER_GOV_UA, Accept: "application/geo+json" },
		});
		if (!hourlyRes.ok) return null;
		const hourly = (await hourlyRes.json()) as {
			properties?: {
				periods?: Array<{
					temperature?: number;
					windSpeed?: string;
					windGust?: string | null;
					shortForecast?: string;
					probabilityOfPrecipitation?: { value?: number | null };
				}>;
			};
		};
		const period = hourly.properties?.periods?.[0];
		if (!period) return null;
		return {
			windMph: parseWindMph(period.windSpeed),
			gustMph: parseWindMph(period.windGust),
			precipPct: Number(period.probabilityOfPrecipitation?.value ?? 0) || 0,
			tempF: Number(period.temperature ?? 0) || 0,
			condition: period.shortForecast ?? "",
		};
	} catch {
		return null;
	}
}
