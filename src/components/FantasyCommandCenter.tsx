import { useState, useEffect } from "react";
import type {
	CommandCenterState,
	FantasyPlayer,
	GrokDecisionResponse,
	GrokRecommendation,
	BeatReporterIntel,
	TokenMetrics,
	WeatherIntel,
} from "../types/fantasy";
import {
	INITIAL_ROSTER,
	INITIAL_INTEL,
	INITIAL_TOKEN_METRICS,
} from "../fantasy-intel";
import { recommendationMatchesPlayer } from "../grok-client";

export function FantasyCommandCenter() {
	const [activeTab, setActiveTab] = useState<
		"lineup" | "grok" | "token" | "weather" | "espn"
	>("lineup");
	const [selectedStarter, setSelectedStarter] = useState<string>("p_kyren");
	const [selectedBench, setSelectedBench] = useState<string>("p_charbonnet");
	const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
	const [isSwapping, setIsSwapping] = useState<boolean>(false);
	const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
	const [isSyncingEspn, setIsSyncingEspn] = useState<boolean>(false);
	const [espnSyncError, setEspnSyncError] = useState<string | null>(null);
	const [espnSyncSuccess, setEspnSyncSuccess] = useState<string | null>(null);
	const [espnLeagueId, setEspnLeagueId] = useState<string>("");
	const [espnSeason, setEspnSeason] = useState<string>("2024");
	const [espnS2Input, setEspnS2Input] = useState<string>("");
	const [espnSwidInput, setEspnSwidInput] = useState<string>("");
	const [showEspnModal, setShowEspnModal] = useState<boolean>(false);
	const [showSleeperModal, setShowSleeperModal] = useState<boolean>(false);
	const [sleeperLeagueId, setSleeperLeagueId] = useState<string>("");
	const [sleeperUser, setSleeperUser] = useState<string>("");
	const [isImportingSleeper, setIsImportingSleeper] = useState<boolean>(false);
	const [sleeperError, setSleeperError] = useState<string | null>(null);
	const [latestDecision, setLatestDecision] =
		useState<GrokDecisionResponse | null>(null);
	const [evaluateError, setEvaluateError] = useState<string | null>(null);
	const [wsConnected, setWsConnected] = useState<boolean>(false);
	const [useLegacySimulation, setUseLegacySimulation] =
		useState<boolean>(false);

	const [state, setState] = useState<CommandCenterState>({
		selectedWeek: 14,
		activeRoster: INITIAL_ROSTER,
		intelPacket: INITIAL_INTEL,
		recommendations: [
			{
				id: "Kyren",
				act: "SIT",
				vs: "Charbonnet",
				delta: -4.2,
				conf: 0.78,
				why: "Ankle DNP + game-time tag in 28mph freezing wind.",
				src: "@RapSheet",
				flags: ["INJ", "WX"],
			},
			{
				id: "Charbonnet",
				act: "START",
				vs: "Kyren",
				delta: 4.2,
				conf: 0.85,
				why: "Dome smash spot vs bottom-3 run defense.",
				src: "@JFowlerNFL",
				flags: ["INJ"],
			},
			{
				id: "Waddle",
				act: "SIT",
				vs: "JSN",
				delta: -2.1,
				conf: 0.68,
				why: "Sauce shadow coverage with MetLife crosswinds.",
				src: "@AdamSchefter",
				flags: ["SPLIT"],
			},
			{
				id: "JSN",
				act: "START",
				vs: "Waddle",
				delta: 2.1,
				conf: 0.88,
				why: "Full practice; slot target funnel in climate-controlled dome.",
				src: "@bcondotta",
				flags: ["NEWS"],
			},
		],
		tokenMetrics: INITIAL_TOKEN_METRICS,
		lastDecision: null,
		liveAlerts: [
			{
				id: "alt_1",
				time: "10:14 AM",
				type: "INJURY",
				message:
					"Grok Alert: Kyren Williams hobbled in early warmups in Orchard Park. Recommend immediate bench swap.",
				severity: "danger",
			},
			{
				id: "alt_2",
				time: "09:45 AM",
				type: "WEATHER",
				message:
					"Highmark Stadium wind sustained at 18mph with 28mph gusts. Kicking and deep passing downgraded.",
				severity: "warning",
			},
			{
				id: "alt_3",
				time: "08:30 AM",
				type: "GROK",
				message:
					"20-Handle Beat Intelligence Synced: All 12 rostered player injury updates verified fresh.",
				severity: "success",
			},
		],
	});

	// Fetch live state from Worker API / DO on mount
	useEffect(() => {
		fetch("/api/fantasy/state")
			.then((res) => (res.ok ? res.json() : null))
			.then((data: CommandCenterState | null) => {
				if (data) {
					setState(data);
					if (data.lastDecision) setLatestDecision(data.lastDecision);
				}
			})
			.catch(() => {
				// Keep fallback initial state if API is offline
			});
	}, []);

	// Subscribe to Durable Object fantasy_update so evaluate/swap stays live
	useEffect(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(
			`${protocol}//${window.location.host}/ws?teamId=default_team`,
		);

		ws.onopen = () => setWsConnected(true);
		ws.onclose = () => setWsConnected(false);
		ws.onerror = () => setWsConnected(false);
		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as {
					type?: string;
					payload?: CommandCenterState;
				};
				if (data.type === "fantasy_update" && data.payload) {
					setState(data.payload);
					if (data.payload.lastDecision) {
						setLatestDecision(data.payload.lastDecision);
					}
				}
			} catch {
				// Ignore malformed frames
			}
		};

		return () => {
			ws.close();
		};
	}, []);

	// Run Grok Evaluation
	const handleRunGrokDecision = async () => {
		setIsEvaluating(true);
		setEvaluateError(null);
		try {
			const res = await fetch("/api/fantasy/decide", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					playerA: selectedStarter,
					playerB: selectedBench,
					useLegacy: useLegacySimulation,
				}),
			});

			const body: unknown = await res.json().catch(() => null);
			if (!res.ok) {
				const err = body as { error?: string } | null;
				setEvaluateError(
					err?.error ?? `Evaluate failed (${res.status}).`,
				);
				return;
			}

			const decision = body as GrokDecisionResponse;
			setLatestDecision(decision);
			setState((prev: CommandCenterState) => {
				const existingIds = new Set(
					decision.recs.map((r: GrokRecommendation) => r.id),
				);
				return {
					...prev,
					lastDecision: decision,
					recommendations: [
						...decision.recs,
						...prev.recommendations.filter(
							(r: GrokRecommendation) => !existingIds.has(r.id),
						),
					],
				};
			});
		} catch (e) {
			setEvaluateError(
				e instanceof Error ? e.message : "Decision evaluation failed",
			);
		} finally {
			setIsEvaluating(false);
		}
	};

	// Swap Roster Starters
	const handleSwapRoster = async () => {
		setIsSwapping(true);
		try {
			const res = await fetch("/api/fantasy/roster/swap", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					starterId: selectedStarter,
					benchId: selectedBench,
				}),
			});

			if (res.ok) {
				const updated: CommandCenterState = await res.json();
				setState(updated);
			}
		} catch (e) {
			console.error("Roster swap failed", e);
		} finally {
			setIsSwapping(false);
		}
	};

	// Refresh Intel
	const handleRefreshIntel = async () => {
		setIsRefreshing(true);
		try {
			const res = await fetch("/api/fantasy/intel/refresh", {
				method: "POST",
			});
			if (res.ok) {
				const updated: CommandCenterState = await res.json();
				setState(updated);
			}
		} catch (e) {
			console.error("Intel refresh failed", e);
		} finally {
			setIsRefreshing(false);
		}
	};

	// Sync ESPN League Roster
	const handleSyncEspn = async (e?: React.FormEvent) => {
		if (e) e.preventDefault();
		setIsSyncingEspn(true);
		setEspnSyncError(null);
		setEspnSyncSuccess(null);

		try {
			const payload: {
				leagueId?: string;
				season?: number;
				espnS2?: string;
				swid?: string;
			} = {};

			if (espnLeagueId.trim()) payload.leagueId = espnLeagueId.trim();
			if (espnSeason.trim()) payload.season = parseInt(espnSeason.trim(), 10) || 2024;
			if (espnS2Input.trim()) payload.espnS2 = espnS2Input.trim();
			if (espnSwidInput.trim()) payload.swid = espnSwidInput.trim();

			const res = await fetch("/api/fantasy/espn/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			const body = await res.json().catch(() => null);

			if (!res.ok) {
				const err = body as { error?: string } | null;
				setEspnSyncError(
					err?.error || `ESPN sync failed with status ${res.status}. Check league ID and cookie credentials.`,
				);
				return;
			}

			const updated = body as CommandCenterState;
			setState(updated);
			if (updated.activeRoster.starters.length > 0) {
				setSelectedStarter(updated.activeRoster.starters[0].id);
			}
			if (updated.activeRoster.bench.length > 0) {
				setSelectedBench(updated.activeRoster.bench[0].id);
			}
			setEspnSyncSuccess(
				`Successfully synced ESPN league: ${updated.activeRoster.starters.length} starters, ${updated.activeRoster.bench.length} bench players loaded.`,
			);
			setShowEspnModal(false);
		} catch (err) {
			setEspnSyncError(
				err instanceof Error ? err.message : "ESPN sync request failed.",
			);
		} finally {
			setIsSyncingEspn(false);
		}
	};

	// Import Sleeper Roster
	const handleImportSleeper = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!sleeperLeagueId.trim()) {
			setSleeperError("Please enter a valid Sleeper League ID");
			return;
		}
		setIsImportingSleeper(true);
		setSleeperError(null);
		try {
			const res = await fetch("/api/fantasy/roster/sleeper-import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leagueId: sleeperLeagueId.trim(),
					userOrRosterId: sleeperUser.trim() || undefined,
				}),
			});
			const body: unknown = await res.json().catch(() => null);
			if (!res.ok) {
				const err = body as { error?: string } | null;
				setSleeperError(err?.error ?? `Import failed (${res.status})`);
				return;
			}
			const updated = body as CommandCenterState;
			setState(updated);
			if (updated.activeRoster.starters.length > 0) {
				setSelectedStarter(updated.activeRoster.starters[0].id);
			}
			if (updated.activeRoster.bench.length > 0) {
				setSelectedBench(updated.activeRoster.bench[0].id);
			}
			setShowSleeperModal(false);
			setSleeperLeagueId("");
			setSleeperUser("");
		} catch (err) {
			setSleeperError(
				err instanceof Error ? err.message : "Sleeper import request failed",
			);
		} finally {
			setIsImportingSleeper(false);
		}
	};

	const starterPlayer = state.activeRoster.starters.find(
		(p: FantasyPlayer) => p.id === selectedStarter,
	);
	const benchPlayer = state.activeRoster.bench.find(
		(p: FantasyPlayer) => p.id === selectedBench,
	);

	return (
		<div className="flex flex-col h-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden shadow-sm">
			{/* Top Bar */}
			<div className="px-5 py-3.5 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/60 flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-3">
					<div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-600 text-white font-bold text-xs shadow-sm">
						FF
					</div>
					<div>
						<div className="flex items-center gap-2">
							<span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
								{state.activeRoster.teamName}
							</span>
							<span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300">
								{state.activeRoster.record} · #{state.activeRoster.rank}
							</span>
							<span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-neutral-600 dark:text-neutral-400 bg-neutral-200 dark:bg-neutral-800">
								Wk {state.selectedWeek}
							</span>
						</div>
						<div className="text-xs text-neutral-500 dark:text-neutral-400">
							Intel Hash:{" "}
							<code className="font-mono text-[11px]">
								{state.intelPacket.hash}
							</code>{" "}
							· Updated {state.intelPacket.asOf}
						</div>
					</div>
				</div>

				{/* Right controls */}
				<div className="flex items-center gap-2">
					<button
						onClick={() => setShowEspnModal(true)}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors shadow-sm"
					>
						<svg
							className="w-3.5 h-3.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M13 10V3L4 14h7v7l9-11h-7z"
							/>
						</svg>
						Sync ESPN League
					</button>

					<button
						onClick={() => setShowSleeperModal(true)}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors"
					>
						<svg
							className="w-3.5 h-3.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
							/>
						</svg>
						Import Sleeper Roster
					</button>

					<button
						onClick={handleRefreshIntel}
						disabled={isRefreshing}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-200 transition-colors disabled:opacity-50"
					>
						<svg
							className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
							/>
						</svg>
						Sync 20-Handle Intel
					</button>

					<a
						href="/cursor/stores/user/canvases/516d73d0-c4b9-4ca4-9cf0-cab3403f8f8c/source.canvas.tsx"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 hover:opacity-90 transition-opacity"
					>
						<svg
							className="w-3.5 h-3.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
							/>
						</svg>
						Open Canvas Architecture
					</a>
				</div>
			</div>

			{/* Navigation Tabs */}
			<div className="px-5 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/30 dark:bg-neutral-900/30 flex items-center justify-between">
				<div className="flex gap-4">
					<button
						onClick={() => setActiveTab("lineup")}
						className={`py-2.5 text-xs font-medium border-b-2 transition-colors ${
							activeTab === "lineup"
								? "border-emerald-600 text-emerald-600 dark:text-emerald-400 dark:border-emerald-400"
								: "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
						}`}
					>
						Lineup & Matchup Optimizer
					</button>
					<button
						onClick={() => setActiveTab("grok")}
						className={`py-2.5 text-xs font-medium border-b-2 transition-colors ${
							activeTab === "grok"
								? "border-emerald-600 text-emerald-600 dark:text-emerald-400 dark:border-emerald-400"
								: "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
						}`}
					>
						Grok Beat Radar (20 Handles)
					</button>
					<button
						onClick={() => setActiveTab("token")}
						className={`py-2.5 text-xs font-medium border-b-2 transition-colors ${
							activeTab === "token"
								? "border-emerald-600 text-emerald-600 dark:text-emerald-400 dark:border-emerald-400"
								: "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
						}`}
					>
						Token Optimization Inspector
					</button>
					<button
						onClick={() => setActiveTab("weather")}
						className={`py-2.5 text-xs font-medium border-b-2 transition-colors ${
							activeTab === "weather"
								? "border-emerald-600 text-emerald-600 dark:text-emerald-400 dark:border-emerald-400"
								: "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
						}`}
					>
						Weather & Stadium Conditions
					</button>
					<button
						onClick={() => setActiveTab("espn")}
						className={`py-2.5 text-xs font-medium border-b-2 transition-colors ${
							activeTab === "espn"
								? "border-red-600 text-red-600 dark:text-red-400 dark:border-red-400"
								: "border-transparent text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
						}`}
					>
						ESPN Fantasy Ingestion
					</button>
				</div>

				<div className="flex items-center gap-2">
					<span
						className={`w-2 h-2 rounded-full ${
							wsConnected
								? "bg-emerald-500 animate-pulse"
								: "bg-neutral-400"
						}`}
					/>
					<span className="text-[11px] text-neutral-500 dark:text-neutral-400">
						{wsConnected
							? "Durable Object live"
							: "Connecting to Durable Object…"}
					</span>
				</div>
			</div>

			{/* Main Tab Views */}
			<div className="flex-1 overflow-y-auto p-5">
				{activeTab === "lineup" && (
					<div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
						{/* Starters List */}
						<div className="lg:col-span-7 flex flex-col gap-4">
							<div className="flex items-center justify-between">
								<h2 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
									Active Starters ({state.activeRoster.starters.length})
								</h2>
								<span className="text-xs text-neutral-500">
									Total Proj:{" "}
									<strong className="text-neutral-900 dark:text-neutral-100">
										{state.activeRoster.starters
											.reduce((acc: number, p: FantasyPlayer) => acc + p.projPts, 0)
											.toFixed(1)}{" "}
										pts
									</strong>
								</span>
							</div>

							<div className="space-y-2">
								{state.activeRoster.starters.map((player: FantasyPlayer) => {
									const isSelected = selectedStarter === player.id;
									const rec = state.recommendations.find(
										(r: GrokRecommendation) =>
											recommendationMatchesPlayer(r, player),
									);

									return (
										<div
											key={player.id}
											onClick={() => setSelectedStarter(player.id)}
											className={`p-3 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${
												isSelected
													? "border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20 shadow-sm"
													: "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 bg-white dark:bg-neutral-900"
											}`}
										>
											<div className="flex items-center gap-3">
												<span className="w-8 h-8 rounded-md bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center font-mono text-xs font-bold text-neutral-700 dark:text-neutral-300">
													{player.pos}
												</span>
												<div>
													<div className="flex items-center gap-2">
														<span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
															{player.name}
														</span>
														<span className="text-xs text-neutral-500">
															{player.team} · {player.opp}
														</span>
														{player.status !== "ACTIVE" && (
															<span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300">
																{player.status}
															</span>
														)}
													</div>
													{player.injuryDesc && (
														<p className="text-[11px] text-red-600 dark:text-red-400 mt-0.5">
															⚠️ {player.injuryDesc}
														</p>
													)}
													{player.weatherCondition && (
														<p className="text-[11px] text-blue-600 dark:text-blue-400 mt-0.5">
															💨 {player.weatherCondition}
														</p>
													)}
												</div>
											</div>

											<div className="flex items-center gap-3">
												{rec && (
													<span
														className={`px-2 py-0.5 rounded text-[11px] font-bold tracking-wide ${
															rec.act === "START"
																? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300"
																: rec.act === "SIT"
																	? "bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300"
																	: "bg-neutral-100 dark:bg-neutral-800 text-neutral-700"
														}`}
													>
														{rec.act} ({rec.delta > 0 ? `+${rec.delta}` : rec.delta})
													</span>
												)}
												<span className="font-mono text-sm font-semibold text-neutral-900 dark:text-neutral-100">
													{player.projPts.toFixed(1)}
												</span>
											</div>
										</div>
									);
								})}
							</div>

							{/* Bench Section */}
							<div className="mt-4">
								<h2 className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
									Bench Roster (Swap Candidates)
								</h2>
								<div className="space-y-2">
									{state.activeRoster.bench.map((player: FantasyPlayer) => {
										const isSelected = selectedBench === player.id;
										const rec = state.recommendations.find(
											(r: GrokRecommendation) =>
												recommendationMatchesPlayer(r, player),
										);

										return (
											<div
												key={player.id}
												onClick={() => setSelectedBench(player.id)}
												className={`p-3 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${
													isSelected
														? "border-blue-500 bg-blue-50/40 dark:bg-blue-950/20 shadow-sm"
														: "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 bg-white dark:bg-neutral-900"
												}`}
											>
												<div className="flex items-center gap-3">
													<span className="w-8 h-8 rounded-md bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center font-mono text-xs font-bold text-neutral-500">
														{player.pos}
													</span>
													<div>
														<div className="flex items-center gap-2">
															<span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
																{player.name}
															</span>
															<span className="text-xs text-neutral-500">
																{player.team} · {player.opp}
															</span>
														</div>
														{player.tags && (
															<div className="flex gap-1.5 mt-0.5">
																{player.tags.map((t: string) => (
																	<span
																		key={t}
																		className="text-[10px] text-neutral-500 bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.2 rounded"
																	>
																		{t}
																	</span>
																))}
															</div>
														)}
													</div>
												</div>

												<div className="flex items-center gap-3">
													{rec && (
														<span
															className={`px-2 py-0.5 rounded text-[11px] font-bold tracking-wide ${
																rec.act === "START"
																	? "bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300"
																	: "bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300"
															}`}
														>
															{rec.act} ({rec.delta > 0 ? `+${rec.delta}` : rec.delta})
														</span>
													)}
													<span className="font-mono text-sm font-semibold text-neutral-900 dark:text-neutral-100">
														{player.projPts.toFixed(1)}
													</span>
												</div>
											</div>
										);
									})}
								</div>
							</div>
						</div>

						{/* Right Panel: Grok Matchup Evaluator */}
						<div className="lg:col-span-5 flex flex-col gap-4">
							<div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
								<div className="flex items-center justify-between mb-3">
									<h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
										Grok Matchup Evaluator
									</h3>
									<span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200">
										CSSP Protocol Active
									</span>
								</div>

								{/* Compare Boxes */}
								<div className="grid grid-cols-2 gap-2 mb-3">
									<div className="p-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
										<div className="text-[10px] font-medium text-neutral-500 uppercase">
											Starter Target
										</div>
										<div className="text-sm font-bold text-neutral-900 dark:text-neutral-100 mt-0.5">
											{starterPlayer?.name || "None"}
										</div>
										<div className="text-xs text-neutral-500 font-mono">
											{starterPlayer?.projPts.toFixed(1)} pts · {starterPlayer?.team}
										</div>
									</div>

									<div className="p-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
										<div className="text-[10px] font-medium text-neutral-500 uppercase">
											Bench Contender
										</div>
										<div className="text-sm font-bold text-neutral-900 dark:text-neutral-100 mt-0.5">
											{benchPlayer?.name || "None"}
										</div>
										<div className="text-xs text-neutral-500 font-mono">
											{benchPlayer?.projPts.toFixed(1)} pts · {benchPlayer?.team}
										</div>
									</div>
								</div>

								{/* Toggle Legacy vs Optimized */}
								<div className="flex items-center justify-between p-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 mb-3 text-xs">
									<span className="text-neutral-700 dark:text-neutral-300">
										Simulate Legacy Verbose Dump:
									</span>
									<button
										onClick={() => setUseLegacySimulation(!useLegacySimulation)}
										className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
											useLegacySimulation
												? "bg-rose-600 text-white"
												: "bg-neutral-300 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
										}`}
									>
										{useLegacySimulation
											? "ON (verbose dump)"
											: "OFF (compact CSSP)"}
									</button>
								</div>

								{/* Action Buttons */}
								<div className="flex gap-2">
									<button
										onClick={handleRunGrokDecision}
										disabled={isEvaluating}
										className="flex-1 py-2 px-3 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
									>
										{isEvaluating
											? "Grok Evaluating..."
											: "Evaluate Matchup with Grok"}
									</button>

									<button
										onClick={handleSwapRoster}
										disabled={isSwapping}
										className="py-2 px-3 rounded-lg text-xs font-semibold border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-200 transition-colors"
									>
										{isSwapping ? "Swapping..." : "Apply Lineup Swap"}
									</button>
								</div>

								{evaluateError && (
									<p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">
										{evaluateError}
									</p>
								)}

								{/* Latest Decision Card */}
								{latestDecision && (
									<div className="mt-4 p-3 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30">
										<div className="flex items-center justify-between text-xs mb-2">
											<span className="font-bold text-emerald-900 dark:text-emerald-200">
												Grok Verdict ({latestDecision.task})
											</span>
											<span className="font-mono text-[10px] text-neutral-600 dark:text-neutral-400">
												{latestDecision.tokensUsed} tokens
												{latestDecision.model
													? ` · ${latestDecision.model}`
													: ""}
											</span>
										</div>

										<div className="space-y-2">
											{latestDecision.recs.map((rec: GrokRecommendation) => (
												<div
													key={rec.id}
													className="p-2 rounded bg-white dark:bg-neutral-900 text-xs border border-emerald-100 dark:border-emerald-900"
												>
													<div className="flex items-center justify-between">
														<span className="font-bold text-neutral-900 dark:text-neutral-100">
															{rec.id}:{" "}
															<span
																className={
																	rec.act === "START"
																		? "text-emerald-600"
																		: "text-rose-600"
																}
															>
																{rec.act}
															</span>
														</span>
														<span className="font-mono text-[11px] font-semibold text-neutral-600 dark:text-neutral-400">
															Delta: {rec.delta > 0 ? `+${rec.delta}` : rec.delta} pts (conf:{" "}
															{(rec.conf * 100).toFixed(0)}%)
														</span>
													</div>
													<p className="text-neutral-600 dark:text-neutral-400 text-[11px] mt-1">
														"{rec.why}"
													</p>
													<div className="flex items-center justify-between mt-1 pt-1 border-t border-neutral-100 dark:border-neutral-800 text-[10px] text-neutral-500">
														<span>Source: {rec.src}</span>
														<div className="flex gap-1">
															{rec.flags.map((f: string) => (
																<span
																	key={f}
																	className="px-1 bg-neutral-100 dark:bg-neutral-800 rounded font-mono"
																>
																	{f}
																</span>
															))}
														</div>
													</div>
												</div>
											))}
										</div>
										<p className="mt-2 text-[10px] font-mono text-neutral-500 dark:text-neutral-400">
											xAI usage: {latestDecision.tokensUsed} tokens
											{latestDecision.cacheHit ? " · cache" : ""}
											{" · vs "}
											{latestDecision.legacyTokensEquivalent} legacy
										</p>
									</div>
								)}
							</div>

							{/* Live Ticker Feed */}
							<div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
								<h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-300 mb-3">
									Live Intelligence Stream
								</h3>
								<div className="space-y-2">
									{state.liveAlerts.map(
										(alert: {
											id: string;
											time: string;
											type: string;
											message: string;
											severity: string;
										}) => (
											<div
												key={alert.id}
												className="p-2.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-xs flex gap-2.5 items-start"
											>
												<span className="font-mono text-[10px] text-neutral-500 mt-0.5">
													{alert.time}
												</span>
												<div>
													<span
														className={`inline-block px-1 py-0.2 rounded text-[9px] font-bold mr-1.5 ${
															alert.type === "INJURY"
																? "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
																: alert.type === "WEATHER"
																	? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"
																	: alert.type === "ESPN"
																		? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
																		: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
														}`}
													>
														{alert.type}
													</span>
													<span className="text-neutral-700 dark:text-neutral-300">
														{alert.message}
													</span>
												</div>
											</div>
										),
									)}
								</div>
							</div>
						</div>
					</div>
				)}

				{activeTab === "grok" && (
					<div className="space-y-4">
						<div className="flex items-center justify-between">
							<div>
								<h2 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
									Curated Beat Reporter 20-Handle Allowlist
								</h2>
								<p className="text-xs text-neutral-500">
									Ingested in real-time by Grok 4.6. No noise, no open web firehose.
								</p>
							</div>
							<span className="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-xs text-neutral-600 dark:text-neutral-300">
								4 Verified Signals Synced
							</span>
						</div>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							{state.intelPacket.beatReports.map((report: BeatReporterIntel) => (
								<div
									key={report.id}
									className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
								>
									<div className="flex items-center justify-between mb-2">
										<div className="flex items-center gap-2">
											<span className="font-semibold text-xs text-neutral-900 dark:text-neutral-100">
												{report.authorName}
											</span>
											<span className="font-mono text-xs text-neutral-500">
												{report.handle}
											</span>
										</div>
										<span className="text-[10px] text-neutral-400">
											{report.timestamp}
										</span>
									</div>
									<p className="text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed mb-3">
										{report.claim}
									</p>
									<div className="flex items-center justify-between pt-2 border-t border-neutral-100 dark:border-neutral-800 text-[11px]">
										<span className="font-mono text-neutral-500">
											Team: <strong>{report.team}</strong>
										</span>
										<span className="font-semibold text-emerald-600 dark:text-emerald-400">
											Confidence: {(report.confidence * 100).toFixed(0)}%
										</span>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{activeTab === "token" && (
					<div className="space-y-5">
						<div>
							<h2 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
								Token Efficiency Benchmark & Audit
							</h2>
							<p className="text-xs text-neutral-500">
								Metrics comparing legacy conversational LLM dumps against our CSSP + Durable Object architecture.
							</p>
						</div>

						{/* Metric Grid */}
						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
							{state.tokenMetrics.map((metric: TokenMetrics) => (
								<div
									key={metric.queryType}
									className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
								>
									<div className="text-[11px] font-semibold text-neutral-500 truncate">
										{metric.queryType}
									</div>
									<div className="text-2xl font-black text-emerald-600 dark:text-emerald-400 mt-1">
										-{metric.savingsPercent}%
									</div>
									<div className="mt-2 text-[11px] text-neutral-600 dark:text-neutral-400 space-y-0.5">
										<div>
											Legacy:{" "}
											<span className="font-mono">{metric.legacyTokens} tokens</span>
										</div>
										<div>
											Optimized:{" "}
											<span className="font-mono font-bold text-neutral-900 dark:text-neutral-100">
												{metric.optimizedTokens} tokens
											</span>
										</div>
										<div>
											Latency delta:{" "}
											<span className="font-mono text-emerald-600">
												-{metric.latencyReductionMs}ms
											</span>
										</div>
									</div>
								</div>
							))}
						</div>

						{/* Protocol Comparison Card */}
						<div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
							<h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-300 mb-2">
								Token Optimization Architecture Contract
							</h3>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
								<div className="p-3 rounded bg-red-50/50 dark:bg-red-950/20 border border-red-200 dark:border-red-900">
									<div className="font-bold text-red-700 dark:text-red-400 mb-1">
										❌ Legacy Chat Anti-Pattern (4,200+ tokens)
									</div>
									<pre className="text-[11px] text-neutral-600 dark:text-neutral-400 overflow-x-auto whitespace-pre-wrap">
{`"Hey, can you look at my 16 players:
Player 1: Kyren Williams, 15.4 pts, ankle injury,
played for Rams vs Bills, stats: 18 carries, 89 yards...
Player 2: Zach Charbonnet, 16.2 pts...
[14 more players + full schedules + 5 paragraph explanation]"`}
									</pre>
								</div>

								<div className="p-3 rounded bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900">
									<div className="font-bold text-emerald-700 dark:text-emerald-400 mb-1">
										✓ CSSP Compact Protocol (~380 tokens)
									</div>
									<pre className="text-[11px] text-neutral-600 dark:text-neutral-400 overflow-x-auto whitespace-pre-wrap">
{`WK:14 PPR:0.5 LEAGUE:12
Q: Kyren vs Charbonnet
INTEL:
- INJ: Kyren Q(ankle) Thu-DNP | conf0.7 @RapSheet
- WX: LAR@BUF wind18 gust28 PASS-FADE
FRESH:1`}
									</pre>
								</div>
							</div>
						</div>
					</div>
				)}

				{activeTab === "weather" && (
					<div className="space-y-4">
						<div className="flex items-center justify-between">
							<div>
								<h2 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
									Stadium Weather Feeds & Impact Tags
								</h2>
								<p className="text-xs text-neutral-500">
									Only extreme weather conditions qualify for Grok qualitative adjustments.
								</p>
							</div>
						</div>

						<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
							{state.intelPacket.weather.map((w: WeatherIntel) => (
								<div
									key={w.game}
									className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
								>
									<div className="flex items-center justify-between mb-1">
										<span className="font-bold text-sm text-neutral-900 dark:text-neutral-100">
											{w.game}
										</span>
										<span
											className={`px-2 py-0.5 rounded text-[10px] font-bold ${
												w.weatherTag === "PASS-FADE"
													? "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
													: w.weatherTag === "K-FADE"
														? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
														: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
											}`}
										>
											{w.weatherTag}
										</span>
									</div>
									<div className="text-xs text-neutral-500 mb-3">
										{w.location}
									</div>

									<div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-neutral-100 dark:border-neutral-800">
										<div>
											<span className="text-neutral-400">Temp:</span>{" "}
											<strong>{w.tempF}°F</strong>
										</div>
										<div>
											<span className="text-neutral-400">Precip:</span>{" "}
											<strong>{w.precipPct}%</strong>
										</div>
										<div>
											<span className="text-neutral-400">Wind:</span>{" "}
											<strong>{w.windMph} mph</strong>
										</div>
										<div>
											<span className="text-neutral-400">Gusts:</span>{" "}
											<strong>{w.gustMph} mph</strong>
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				{activeTab === "espn" && (
					<div className="space-y-5">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div>
								<h2 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
									ESPN Fantasy League Sync & Sanitization
								</h2>
								<p className="text-xs text-neutral-500">
									Authenticate with ESPN private league cookies (<code className="font-mono">espn_s2</code> + <code className="font-mono">SWID</code>) and sanitize raw payloads into CSSP state.
								</p>
							</div>
							<button
								onClick={() => setShowEspnModal(true)}
								className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors shadow-sm"
							>
								Configure & Sync League
							</button>
						</div>

						{/* ESPN Sync Status Banner */}
						{state.espnSyncMeta ? (
							<div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20">
								<div className="flex items-center justify-between mb-2">
									<span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
										<span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
										ESPN League {state.espnSyncMeta.leagueId} Active
									</span>
									<span className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400">
										Season {state.espnSyncMeta.season} · Week {state.selectedWeek}
									</span>
								</div>
								<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs pt-2 border-t border-emerald-200/60 dark:border-emerald-800/60">
									<div>
										<span className="text-neutral-500">Raw ESPN JSON:</span>{" "}
										<strong>{(state.espnSyncMeta.rawBytes / 1024).toFixed(1)} KB</strong>
									</div>
									<div>
										<span className="text-neutral-500">CSSP Tokens:</span>{" "}
										<strong>~{state.espnSyncMeta.sanitizedTokens}</strong>
									</div>
									<div>
										<span className="text-neutral-500">Token Reduction:</span>{" "}
										<strong className="text-emerald-600 dark:text-emerald-400">
											-{state.espnSyncMeta.savingsPercent}%
										</strong>
									</div>
									<div>
										<span className="text-neutral-500">Last Synced:</span>{" "}
										<span className="font-mono text-[11px]">
											{new Date(state.espnSyncMeta.syncedAt).toLocaleTimeString()}
										</span>
									</div>
								</div>
							</div>
						) : (
							<div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50 text-xs text-neutral-600 dark:text-neutral-400">
								<p className="font-semibold text-neutral-800 dark:text-neutral-200 mb-1">
									No live ESPN league connected yet
								</p>
								<p>
									Currently using initial sample roster. Click <strong>Configure & Sync League</strong> or set <code className="font-mono">ESPN_S2</code>, <code className="font-mono">SWID</code>, and <code className="font-mono">ESPN_LEAGUE_ID</code> in Cloudflare Worker secrets.
								</p>
							</div>
						)}

						{/* Cookie Retrieval Guidance */}
						<div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 space-y-3">
							<h3 className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
								How to Retrieve ESPN Cookie Credentials
							</h3>
							<ol className="list-decimal list-inside text-xs text-neutral-600 dark:text-neutral-400 space-y-1.5">
								<li>Log into your ESPN account at <code className="font-mono">fantasy.espn.com</code>.</li>
								<li>Open Browser DevTools (<kbd className="font-mono px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800">F12</kbd> or <kbd className="font-mono px-1 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800">Ctrl+Shift+I</kbd>).</li>
								<li>Navigate to <strong>Application</strong> (Chrome/Edge) or <strong>Storage</strong> (Firefox) &rarr; <strong>Cookies</strong> &rarr; <code className="font-mono">https://espn.com</code>.</li>
								<li>Locate and copy the value of <strong><code className="font-mono">espn_s2</code></strong> (long ~200-char string).</li>
								<li>Locate and copy the value of <strong><code className="font-mono">SWID</code></strong> (UUID wrapped in braces like <code className="font-mono">&#123;A872...&#125;</code>).</li>
								<li>Find your <strong><code className="font-mono">leagueId</code></strong> from the ESPN URL: <code className="font-mono">leagues/YOUR_LEAGUE_ID</code>.</li>
							</ol>

							<div className="p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 font-mono text-[11px] text-neutral-700 dark:text-neutral-300 overflow-x-auto">
								<p className="text-neutral-500 mb-1"># Command line setup for persistent Worker secrets:</p>
								<code>npx wrangler secret put ESPN_S2</code><br />
								<code>npx wrangler secret put SWID</code><br />
								<code>npx wrangler secret put ESPN_LEAGUE_ID</code>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* ESPN League Sync Modal */}
			{showEspnModal && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
					<div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl max-w-md w-full p-5 shadow-xl space-y-4">
						<div className="flex items-center justify-between pb-2 border-b border-neutral-200 dark:border-neutral-800">
							<h3 className="text-sm font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
								<span className="w-2 h-2 rounded-full bg-red-600" />
								Sync ESPN Fantasy League
							</h3>
							<button
								onClick={() => setShowEspnModal(false)}
								className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 text-sm"
							>
								✕
							</button>
						</div>

						{espnSyncError && (
							<div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
								{espnSyncError}
							</div>
						)}

						{espnSyncSuccess && (
							<div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-700 dark:text-emerald-300">
								{espnSyncSuccess}
							</div>
						)}

						<form onSubmit={handleSyncEspn} className="space-y-3">
							<div>
								<label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
									ESPN League ID <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									placeholder="e.g. 12345678"
									value={espnLeagueId}
									onChange={(e) => setEspnLeagueId(e.target.value)}
									className="w-full px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-red-500"
								/>
								<span className="text-[10px] text-neutral-500">
									Or leave blank if ESPN_LEAGUE_ID is set in Worker secrets.
								</span>
							</div>

							<div>
								<label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
									Season Year
								</label>
								<input
									type="text"
									placeholder="2024"
									value={espnSeason}
									onChange={(e) => setEspnSeason(e.target.value)}
									className="w-full px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-red-500"
								/>
							</div>

							<div>
								<label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
									espn_s2 Cookie (Private Leagues)
								</label>
								<input
									type="password"
									placeholder="AEC... (optional if in secrets)"
									value={espnS2Input}
									onChange={(e) => setEspnS2Input(e.target.value)}
									className="w-full px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-red-500"
								/>
							</div>

							<div>
								<label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
									SWID Cookie (Private Leagues)
								</label>
								<input
									type="text"
									placeholder="{12345678-ABCD-...} (optional if in secrets)"
									value={espnSwidInput}
									onChange={(e) => setEspnSwidInput(e.target.value)}
									className="w-full px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs font-mono text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-red-500"
								/>
							</div>

							<div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-200 dark:border-neutral-800">
								<button
									type="button"
									onClick={() => setShowEspnModal(false)}
									className="px-3 py-1.5 rounded-lg text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
								>
									Cancel
								</button>
								<button
									type="submit"
									disabled={isSyncingEspn}
									className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 flex items-center gap-1.5"
								>
									{isSyncingEspn ? (
										<>
											<svg
												className="w-3.5 h-3.5 animate-spin"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
												/>
											</svg>
											Syncing & Sanitizing…
										</>
									) : (
										"Sync League Now"
									)}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Sleeper Import Modal */}
			{showSleeperModal && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
					<div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl max-w-md w-full p-6 shadow-xl relative animate-in fade-in zoom-in-95 duration-150">
						<button
							onClick={() => setShowSleeperModal(false)}
							className="absolute top-4 right-4 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
						>
							<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>

						<div className="flex items-center gap-3 mb-4">
							<div className="w-10 h-10 rounded-xl bg-emerald-600/10 text-emerald-600 flex items-center justify-center font-bold text-lg">
								🏈
							</div>
							<div>
								<h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
									Import Sleeper Roster
								</h3>
								<p className="text-xs text-neutral-500">
									Drop hardcoded teams and load your real league into the Durable Object.
								</p>
							</div>
						</div>

						<form onSubmit={handleImportSleeper} className="space-y-4">
							<div>
								<label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
									Sleeper League ID <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									required
									placeholder="e.g. 1125514649712000000"
									value={sleeperLeagueId}
									onChange={(e) => setSleeperLeagueId(e.target.value)}
									className="w-full px-3 py-2 text-xs rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
								/>
								<span className="text-[10px] text-neutral-400 mt-1 block">
									Found in your Sleeper league URL: sleeper.app/leagues/&lt;LEAGUE_ID&gt;
								</span>
							</div>

							<div>
								<label className="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
									Username, User ID, or Roster # (Optional)
								</label>
								<input
									type="text"
									placeholder="e.g. your_sleeper_username or roster number (default 1)"
									value={sleeperUser}
									onChange={(e) => setSleeperUser(e.target.value)}
									className="w-full px-3 py-2 text-xs rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
								/>
							</div>

							{sleeperError && (
								<div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-600 dark:text-red-400">
									{sleeperError}
								</div>
							)}

							<div className="flex gap-2 pt-2">
								<button
									type="button"
									onClick={() => setShowSleeperModal(false)}
									className="flex-1 py-2 px-3 rounded-lg text-xs font-medium border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
								>
									Cancel
								</button>
								<button
									type="submit"
									disabled={isImportingSleeper}
									className="flex-1 py-2 px-3 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
								>
									{isImportingSleeper ? "Importing Roster..." : "Fetch & Save Roster"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
