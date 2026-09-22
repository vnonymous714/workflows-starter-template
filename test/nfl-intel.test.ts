import { describe, it, expect } from "vitest";
import { applyWeatherToPlayers, buildWeatherIntel } from "../src/nfl-intel";
import type { FantasyPlayer, WeatherIntel } from "../src/types/fantasy";

const BUF_LAR = {
	home: "BUF",
	away: "LAR",
	indoor: false,
	venueName: "Highmark Stadium",
	city: "Orchard Park",
};

function nws(period: Record<string, unknown>): typeof fetch {
	return async (input) => {
		const url = String(input);
		if (url.includes("/points/")) {
			return Response.json({
				properties: { forecastHourly: "https://api.weather.gov/gridpoints/x" },
			});
		}
		if (url.includes("/gridpoints/")) {
			return Response.json({ properties: { periods: [period] } });
		}
		throw new Error(`Unexpected fetch: ${url}`);
	};
}

describe("NFL weather tagging", () => {
	it("uses discrete tags instead of prose", async () => {
		const indoor = await buildWeatherIntel(
			async () => {
				throw new Error("NWS should not run for indoor games");
			},
			[{ ...BUF_LAR, home: "DAL", away: "CIN", indoor: true }],
			["DAL"],
		);
		expect(indoor[0].weatherTag).toBe("NONE");

		const passFade = await buildWeatherIntel(
			nws({
				temperature: 27,
				windSpeed: "18 mph",
				windGust: "28 mph",
				shortForecast: "Windy",
				probabilityOfPrecipitation: { value: 10 },
			}),
			[BUF_LAR],
			["LAR"],
		);
		expect(passFade[0].weatherTag).toBe("PASS-FADE");

		const kFade = await buildWeatherIntel(
			nws({
				windSpeed: "15 mph",
				windGust: "16 mph",
				probabilityOfPrecipitation: { value: 10 },
			}),
			[BUF_LAR],
			["LAR"],
		);
		expect(kFade[0].weatherTag).toBe("K-FADE");

		const slop = await buildWeatherIntel(
			nws({
				windSpeed: "5 mph",
				windGust: "5 mph",
				shortForecast: "Snow",
				probabilityOfPrecipitation: { value: 70 },
			}),
			[BUF_LAR],
			["LAR"],
		);
		expect(slop[0].weatherTag).toBe("SLOP");

		const rbBump = await buildWeatherIntel(
			nws({
				windSpeed: "4 mph",
				windGust: "4 mph",
				probabilityOfPrecipitation: { value: 45 },
			}),
			[BUF_LAR],
			["LAR"],
		);
		expect(rbBump[0].weatherTag).toBe("RB-BUMP");
	});

	it("renders a compact weather line for CSSP", () => {
		const wx: WeatherIntel = {
			game: "LAR @ BUF",
			location: "Highmark Stadium",
			isDome: false,
			windMph: 18,
			gustMph: 28,
			tempF: 27,
			precipPct: 45,
			weatherTag: "PASS-FADE",
		};
		const players: FantasyPlayer[] = [
			{
				id: "p_kyren",
				name: "Kyren Williams",
				pos: "RB",
				team: "LAR",
				opp: "@ BUF",
				projPts: 15.4,
				status: "QUESTIONABLE",
			},
		];
		applyWeatherToPlayers(players, [wx]);
		expect(players[0].weatherCondition).toBe("PASS-FADE wind18 gust28 27F");
	});
});
