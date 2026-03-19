import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { db } from "../../lib/db";
import { forms, rsvps, users } from "../../lib/schema";
import { createSession } from "../../lib/session";
import { getSlackUser, inviteToChannel } from "../../lib/slack";

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");

	let storedState: { state: string; returnTo: string; action: string } | null =
		null;
	try {
		storedState = cookies.get("oauth_state")?.json() ?? null;
	} catch {
		storedState = null;
	}
	cookies.delete("oauth_state", { path: "/" });

	if (!code || !state || !storedState || state !== storedState.state) {
		return redirect("/?error=invalid_state");
	}

	const tokenRes = await fetch("https://auth.hackclub.com/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			client_id: import.meta.env.HCA_CLIENT_ID,
			client_secret: import.meta.env.HCA_CLIENT_SECRET,
			redirect_uri: new URL("/auth/callback", url).toString(),
		}),
	});

	if (!tokenRes.ok) {
		return redirect("/?error=token_exchange");
	}

	const tokenData = await tokenRes.json();

	const userRes = await fetch("https://auth.hackclub.com/api/v1/me", {
		headers: { Authorization: `Bearer ${tokenData.access_token}` },
	});

	if (!userRes.ok) {
		return redirect("/?error=userinfo");
	}

	const raw = await userRes.json();
	const identity = raw.identity ?? raw;

	const hcaId = String(identity.id);
	const slackId = identity.slack_id || null;
	const yswsEligible = import.meta.env.DEV || Boolean(identity.ysws_eligible);

	let name = "";
	const email = "";
	let avatarUrl: string | null = null;

	if (slackId) {
		const slackUser = await getSlackUser(slackId);
		if (slackUser) {
			name = slackUser.displayName;
			avatarUrl = slackUser.avatarUrl;
		}
	}

	// lookup by slack ID
	const existingUser =
		(await (slackId
			? db.select().from(users).where(eq(users.slackId, slackId)).get()
			: null)) ??
		(await db.select().from(users).where(eq(users.hackclubId, hcaId)).get());

	let userId: string;
	let isAllowed: boolean;

	if (existingUser) {
		// preserve isallowed if exists on user
		isAllowed = existingUser.isAllowed;
		await db
			.update(users)
			.set({ name, email, avatarUrl, slackId, hackclubId: hcaId })
			.where(eq(users.id, existingUser.id));
		userId = existingUser.id;
	} else {
		isAllowed = yswsEligible;
		userId = crypto.randomUUID();
		await db.insert(users).values({
			id: userId,
			hackclubId: hcaId,
			name,
			email,
			avatarUrl,
			slackId,
			isAllowed,
		});
	}

	const session = await createSession({
		id: userId,
		name,
		email,
		avatarUrl,
		isAllowed,
		slackId,
	});

	cookies.set("session", session, {
		httpOnly: true,
		secure: import.meta.env.PROD,
		sameSite: "lax",
		path: "/",
		maxAge: 60 * 60 * 24 * 7,
	});

	if (storedState.action === "rsvp" && storedState.returnTo) {
		const slug = storedState.returnTo.replace(/^\//, "").split("/")[0];
		const form = await db
			.select()
			.from(forms)
			.where(eq(forms.slug, slug))
			.get();

		if (form?.isOpen && isAllowed) {
			try {
				await db.insert(rsvps).values({
					id: crypto.randomUUID(),
					formId: form.id,
					userId,
				});

				if (form.slackChannelId && slackId) {
					await inviteToChannel(form.slackChannelId, slackId);
				}
			} catch {
				// also dupe
			}
		}

		return redirect(storedState.returnTo);
	}

	return redirect(storedState.returnTo || "/");
};
