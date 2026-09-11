import { useState, useEffect } from "react";
import { WorkflowDiagram } from "./components/WorkflowDiagram";
import { CodeDisplay } from "./components/CodeDisplay";
import { BackgroundDots } from "./components/BackgroundDots";
import { FantasyCommandCenter } from "./components/FantasyCommandCenter";
import { useWorkflowWebSocket } from "./hooks/useWorkflowWebSocket";
import { WORKFLOW_STEPS } from "./types";

function App() {
	const [viewMode, setViewMode] = useState<"fantasy" | "workflows">("fantasy");
	const [instanceId, setInstanceId] = useState<string | null>(null);
	const [isStarting, setIsStarting] = useState(false);
	const workflowState = useWorkflowWebSocket(instanceId);

	useEffect(() => {
		if (workflowState.workflowStatus === "completed") {
			const timer = setTimeout(() => {
				setInstanceId(null);
			}, 1500);
			return () => clearTimeout(timer);
		}
	}, [workflowState.workflowStatus]);

	useEffect(() => {
		if (
			workflowState.workflowStatus === "running" &&
			workflowState.currentStep
		) {
			setIsStarting(false);
		}
	}, [workflowState.workflowStatus, workflowState.currentStep]);

	const handleStartWorkflow = async () => {
		setIsStarting(true);

		try {
			const response = await fetch("/api/workflow/start", {
				method: "POST",
			});

			if (!response.ok) {
				throw new Error("Failed to start workflow");
			}

			const data = await response.json();
			setInstanceId(data.instanceId);
		} catch {
			alert("Failed to start workflow. Please try again.");
			setIsStarting(false);
		}
	};

	return (
		<div className="min-h-screen bg-neutral-50/30 dark:bg-neutral-950 flex flex-col relative text-neutral-900 dark:text-neutral-100">
			{/* Background dots across entire page */}
			<div className="absolute inset-0 text-neutral-200/50 dark:text-neutral-700/40 overflow-hidden pointer-events-none">
				<BackgroundDots />
			</div>

			{/* Minimal Integrated Header */}
			<header className="px-6 pt-5 pb-3 relative z-10 border-b border-neutral-200/60 dark:border-neutral-800/60 backdrop-blur-sm">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center font-bold text-white shadow-sm text-sm">
							⚡
						</div>
						<div>
							<h1 className="text-sm font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
								Fantasy Football Command Center
								<span className="px-1.5 py-0.2 rounded text-[10px] font-mono font-medium bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
									Grok 4.6 + Cloudflare DO
								</span>
							</h1>
							<p className="text-xs text-neutral-500">
								High-performance agent orchestration with token-optimized CSSP protocols
							</p>
						</div>
					</div>

					{/* View Switcher & Canvas Link */}
					<div className="flex items-center gap-2">
						<div className="flex p-0.5 rounded-lg bg-neutral-200/60 dark:bg-neutral-800/60 text-xs">
							<button
								onClick={() => setViewMode("fantasy")}
								className={`px-3 py-1 rounded-md font-medium transition-colors ${
									viewMode === "fantasy"
										? "bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-sm"
										: "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
								}`}
							>
								Command Center
							</button>
							<button
								onClick={() => setViewMode("workflows")}
								className={`px-3 py-1 rounded-md font-medium transition-colors ${
									viewMode === "workflows"
										? "bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-sm"
										: "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
								}`}
							>
								Underlying Workflows
							</button>
						</div>

						<a
							href="/cursor/stores/user/canvases/516d73d0-c4b9-4ca4-9cf0-cab3403f8f8c/source.canvas.tsx"
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs font-medium px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
						>
							Canvas Architecture ↗
						</a>
					</div>
				</div>
			</header>

			{/* Main Content Area */}
			{viewMode === "fantasy" ? (
				<main className="flex-1 p-6 relative z-10 overflow-hidden flex flex-col">
					<FantasyCommandCenter />
				</main>
			) : (
				<main className="flex-1 flex flex-col lg:flex-row overflow-hidden relative z-10 pt-4">
					{/* Left side - Code */}
					<div className="w-full lg:w-[60%] overflow-hidden px-6 pb-6">
						<CodeDisplay
							currentStep={workflowState.currentStep}
							workflowStatus={workflowState.workflowStatus}
							onStartWorkflow={handleStartWorkflow}
							isStarting={isStarting}
						/>
					</div>

					{/* Right side - Diagram */}
					<div className="flex-1 overflow-hidden px-6 lg:pl-8 lg:pr-6 pb-6">
						<WorkflowDiagram
							steps={WORKFLOW_STEPS}
							stepStatuses={workflowState.stepStatuses}
							currentStep={workflowState.currentStep}
							instanceId={instanceId}
							workflowStatus={workflowState.workflowStatus}
							onStartWorkflow={handleStartWorkflow}
							isStarting={isStarting}
						/>
					</div>
				</main>
			)}
		</div>
	);
}

export default App;
