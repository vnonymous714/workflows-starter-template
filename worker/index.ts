// Export the Workflow and Durable Object classes
export { MyWorkflow } from "./workflow";
export { WorkflowStatusDO } from "./durable-object";

/**
 * Main Worker fetch handler
 *
 * Handles API routes and WebSocket upgrade requests for:
 * - Fantasy Football Command Center (Durable Object state, Grok intel, and token optimization)
 * - Cloudflare Workflows orchestration
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Fantasy Football Command Center API endpoints (routed through Durable Object)
		if (url.pathname.startsWith("/api/fantasy/")) {
			const subpath = url.pathname.replace("/api", "");
			const teamId = url.searchParams.get("teamId") || "default_team";
			const doId = env.WORKFLOW_STATUS.idFromName(teamId);
			const stub = env.WORKFLOW_STATUS.get(doId);

			const doRequest = new Request(
				new URL(subpath, request.url).toString(),
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

		// API: Start a new workflow instance
		if (url.pathname === "/api/workflow/start" && request.method === "POST") {
			try {
				const instance = await env.MY_WORKFLOW.create({
					params: {
						timestamp: Date.now(),
					},
				});

				return Response.json({
					instanceId: instance.id,
					message: "Workflow started successfully",
				});
			} catch {
				return Response.json(
					{ error: "Failed to start workflow" },
					{ status: 500 },
				);
			}
		}

		// API: Get workflow status
		if (url.pathname.startsWith("/api/workflow/status/")) {
			const instanceId = url.pathname.split("/").pop();
			if (!instanceId) {
				return Response.json(
					{ error: "Instance ID required" },
					{ status: 400 },
				);
			}

			try {
				const instance = await env.MY_WORKFLOW.get(instanceId);
				const status = await instance.status();
				return Response.json(status);
			} catch {
				return Response.json(
					{ error: "Failed to get workflow status" },
					{ status: 500 },
				);
			}
		}

		// API: Send event to workflow instance
		if (
			url.pathname.startsWith("/api/workflow/event/") &&
			request.method === "POST"
		) {
			const instanceId = url.pathname.split("/").pop();
			if (!instanceId) {
				return Response.json(
					{ error: "Instance ID required" },
					{ status: 400 },
				);
			}

			try {
				const body = (await request.json()) as {
					approved: boolean;
					comment?: string;
				};
				const instance = await env.MY_WORKFLOW.get(instanceId);

				await instance.sendEvent({
					type: "user-approval",
					payload: body,
				});

				return Response.json({
					success: true,
					message: "Event sent successfully",
				});
			} catch {
				return Response.json(
					{ error: "Failed to send event" },
					{ status: 500 },
				);
			}
		}

		// WebSocket: Connect to workflow or fantasy status updates
		if (url.pathname === "/ws") {
			const instanceId =
				url.searchParams.get("instanceId") ||
				url.searchParams.get("teamId");

			if (!instanceId) {
				return new Response("instanceId query parameter required", {
					status: 400,
				});
			}

			const upgradeHeader = request.headers.get("Upgrade");
			if (upgradeHeader !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}

			try {
				const doId = env.WORKFLOW_STATUS.idFromName(instanceId);
				const stub = env.WORKFLOW_STATUS.get(doId);
				return stub.fetch(request);
			} catch {
				return new Response("Failed to establish WebSocket connection", {
					status: 500,
				});
			}
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ error: "Not Found" }, { status: 404 });
		}

		return new Response("Not found", { status: 404 });
	},
};
