import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ cookies, redirect, url }) => {
	const clientId = import.meta.env.HCA_CLIENT_ID;
	if (!clientId) {
		return new Response("HCA_CLIENT_ID not configured in .env", {
			status: 500,
		});
	}

	const returnTo = url.searchParams.get("return") || "/";
	const action = url.searchParams.get("action") || "";

	const state = crypto.randomUUID();
	cookies.set("oauth_state", JSON.stringify({ state, returnTo, action }), {
		httpOnly: true,
		secure: import.meta.env.PROD,
		sameSite: "lax",
		path: "/",
		maxAge: 600,
	});

	const authUrl = new URL("https://auth.hackclub.com/oauth/authorize");
	authUrl.searchParams.set("client_id", clientId);
	authUrl.searchParams.set(
		"redirect_uri",
		new URL("/auth/callback", url).toString(),
	);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("scope", "verification_status slack_id");
	authUrl.searchParams.set("state", state);

	return redirect(authUrl.toString());
};
