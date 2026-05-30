import type { APIRoute } from "astro";
import { count, eq } from "drizzle-orm";
import { db } from "../../lib/db";
import { feedback, forms, rsvps } from "../../lib/schema";

const MAX_FORMS_PER_USER = 3;
const SLACK_CHANNEL_RE = /^[A-Z][A-Z0-9]{6,12}$/;

const RESERVED_SLUGS = new Set([
	"new",
	"auth",
	"api",
	"admin",
	"login",
	"logout",
	"callback",
	"dashboard",
]);

export const POST: APIRoute = async ({ request, locals, redirect }) => {
	if (!locals.user) {
		return redirect("/auth/login");
	}

	const isAdmin = locals.user.slackId === import.meta.env.ADMIN_ID;
	const data = await request.formData();
	const method = data.get("_method") as string;

	if (method === "PATCH") {
		const id = data.get("id") as string;
		const form = await db.select().from(forms).where(eq(forms.id, id)).get();

		if (!form || (form.creatorId !== locals.user.id && !isAdmin)) {
			return new Response("Not found", { status: 404 });
		}

		const slackChannelIdRaw =
			(data.get("slackChannelId") as string)?.trim() || null;
		if (slackChannelIdRaw && !SLACK_CHANNEL_RE.test(slackChannelIdRaw)) {
			return redirect(`/${form.slug}/manage?error=Invalid Slack channel ID`);
		}
		const slackChannelId = slackChannelIdRaw;
		const websiteRaw = (data.get("website") as string)?.trim() || null;
		const website = websiteRaw;

		const title = (data.get("title") as string)?.trim();
		if (!title) {
			return redirect(`/${form.slug}/manage?error=Title is required`);
		}

		const description = (data.get("description") as string)?.trim() || null;

		const newSlug = (data.get("slug") as string)?.toLowerCase().trim();
		if (!newSlug) {
			return redirect(`/${form.slug}/manage?error=URL slug is required`);
		}
		if (!/^[a-z0-9-]+$/.test(newSlug)) {
			return redirect(`/${form.slug}/manage?error=URL can only contain lowercase letters, numbers, and hyphens`);
		}
		if (RESERVED_SLUGS.has(newSlug)) {
			return redirect(`/${form.slug}/manage?error=That URL is reserved`);
		}
		if (newSlug !== form.slug) {
			const existing = await db.select().from(forms).where(eq(forms.slug, newSlug)).get();
			if (existing) {
				return redirect(`/${form.slug}/manage?error=That URL is already taken`);
			}
		}

		await db
			.update(forms)
			.set({
				title,
				description,
				slug: newSlug,
				isOpen: data.has("isOpen"),
				isPublic: data.has("isPublic"),
				feedbackEnabled: data.has("feedbackEnabled"),
				slackChannelId,
				website,
			})
			.where(eq(forms.id, id));

		return redirect(`/${newSlug}/manage`);
	}

	if (method === "DELETE") {
		const id = data.get("id") as string;
		const form = await db.select().from(forms).where(eq(forms.id, id)).get();

		if (!form || (form.creatorId !== locals.user.id && !isAdmin)) {
			return new Response("Not found", { status: 404 });
		}

		await db.delete(feedback).where(eq(feedback.formId, id));
		await db.delete(rsvps).where(eq(rsvps.formId, id));
		await db.delete(forms).where(eq(forms.id, id));

		return redirect("/");
	}

	if (!import.meta.env.DEV && !locals.user.isAllowed) {
		return redirect(
			"/new?error=Your account is not eligible for YSWS programs",
		);
	}

	const formCount =
		(
			await db
				.select({ value: count() })
				.from(forms)
				.where(eq(forms.creatorId, locals.user.id))
				.get()
		)?.value ?? 0;

	if (formCount >= MAX_FORMS_PER_USER) {
		return redirect(
			`/new?error=You can create up to ${MAX_FORMS_PER_USER} forms`,
		);
	}

	const title = (data.get("title") as string)?.trim();
	const slug = (data.get("slug") as string)?.toLowerCase().trim();
	const description = (data.get("description") as string)?.trim() || null;
	const feedbackEnabled = data.has("feedbackEnabled");
	const slackChannelId = (data.get("slackChannelId") as string)?.trim() || null;
	const website = (data.get("website") as string)?.trim() || null;

	if (slackChannelId && !SLACK_CHANNEL_RE.test(slackChannelId)) {
		return redirect("/new?error=Invalid Slack channel ID");
	}

	if (!title || !slug) {
		return redirect("/new?error=Title and URL are required");
	}

	if (!/^[a-z0-9-]+$/.test(slug)) {
		return redirect(
			"/new?error=URL can only contain lowercase letters, numbers, and hyphens",
		);
	}

	if (RESERVED_SLUGS.has(slug)) {
		return redirect("/new?error=That URL is reserved");
	}

	const existing = await db
		.select()
		.from(forms)
		.where(eq(forms.slug, slug))
		.get();
	if (existing) {
		return redirect("/new?error=That URL is already taken");
	}

	await db.insert(forms).values({
		id: crypto.randomUUID(),
		slug,
		title,
		description,
		creatorId: locals.user.id,
		feedbackEnabled,
		slackChannelId,
		website,
	});

	return redirect(`/${slug}/manage`);
};
