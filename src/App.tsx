import { FantasyCommandCenter } from "./components/FantasyCommandCenter";

function App() {
	return (
		<div className="min-h-screen bg-neutral-50/30 dark:bg-neutral-950 flex flex-col text-neutral-900 dark:text-neutral-100">
			<main className="flex-1 p-6 flex flex-col">
				<FantasyCommandCenter />
			</main>
		</div>
	);
}

export default App;
