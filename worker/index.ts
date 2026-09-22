export { WorkflowStatusDO } from "./durable-object";

/**
 * Main Worker fetch handler
 *
 * Handles API routes and WebSocket upgrade requests for
 * Fantasy Football Command Center (Durable Object state, Grok intel, and token optimization)
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Fantasy Football Command Center API endpoints (routed through Durable Object)
		if (url.pathname.startsWith("/api/fantasy/")) {
			const subpath = url.pathname.replace("/api/fantasy", "");
			const teamId = url.searchParams.get("teamId") || "default_team";
			const doId = env.WORKFLOW_STATUS.idFromName(teamId);
			const stub = env.WORKFLOW_STATUS.get(doId);

			const doRequest = new Request(
				new URL(subpath || "/state", request.url).toString(),
				{
					method: request.method,
					headers: request.headers,
					body:
						request.method !== "GET" && request.method !== "HEAD"
							? request.body
							: undefined,
				},
			);

			return stub.fetch(doRequest);
		}

		// WebSocket: Connect to fantasy status updates
		if (url.pathname === "/ws") {
			const teamId = url.searchParams.get("teamId") || "default_team";

			const upgradeHeader = request.headers.get("Upgrade");
			if (upgradeHeader !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}

			try {
				const doId = env.WORKFLOW_STATUS.idFromName(teamId);
				const stub = env.WORKFLOW_STATUS.get(doId);
				return stub.fetch(request);
			} catch {
				return new Response("Failed to establish WebSocket connection", {
					status: 500,
				});
			}
		}

		return new Response("Not found", { status: 404 });
	},

	async scheduled(
		_controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> {
		const doId = env.WORKFLOW_STATUS.idFromName("default_team");
		const stub = env.WORKFLOW_STATUS.get(doId);
		await stub.refreshIntel();
	},
};
