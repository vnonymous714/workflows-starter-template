import { describe, it, expect } from "vitest";
import { parseWindMph, tagWeather, weatherLine } from "../src/nfl-intel";
import type { WeatherIntel } from "../src/types/fantasy";

describe("NFL weather tagging", () => {
	it("parses NWS wind strings", () => {
		expect(parseWindMph("18 mph")).toBe(18);
		expect(parseWindMph("7 to 12 mph")).toBe(7);
		expect(parseWindMph(null)).toBe(0);
	});

	it("uses discrete tags instead of prose", () => {
		expect(tagWeather({ indoor: true, windMph: 40, gustMph: 50, precipPct: 90 })).toBe(
			"NONE",
		);
		expect(
			tagWeather({ indoor: false, windMph: 18, gustMph: 28, precipPct: 10 }),
		).toBe("PASS-FADE");
		expect(
			tagWeather({ indoor: false, windMph: 15, gustMph: 16, precipPct: 10 }),
		).toBe("K-FADE");
		expect(
			tagWeather({
				indoor: false,
				windMph: 5,
				gustMph: 5,
				precipPct: 70,
				condition: "Snow",
			}),
		).toBe("SLOP");
		expect(
			tagWeather({ indoor: false, windMph: 4, gustMph: 4, precipPct: 45 }),
		).toBe("RB-BUMP");
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
		expect(weatherLine(wx)).toBe("PASS-FADE wind18 gust28 27F");
	});
});
