// @ts-expect-error
import { Database } from "bun:sqlite";
import { App } from "@slack/bolt";

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
	console.warn("slack: bot and app token required");
	process.exit(0);
}

const sqlite = new Database(process.env.DATABASE_URL || "./data/rsvp.db");
sqlite.exec("PRAGMA journal_mode=WAL");
sqlite.exec("PRAGMA foreign_keys=ON");

const getForm = sqlite.prepare<
	{
		id: string;
		title: string;
		slug: string;
		is_open: number;
		description: string | null;
		slack_channel_id: string | null;
		creator_id: string;
	},
	[string]
>(
	"SELECT id, title, slug, is_open, description, slack_channel_id, creator_id FROM forms WHERE slug = ?",
);

const getUserBySlackId = sqlite.prepare<
	{ id: string; is_allowed: number },
	[string]
>("SELECT id, is_allowed FROM users WHERE slack_id = ?");

const getExistingRsvp = sqlite.prepare<{ id: string }, [string, string]>(
	"SELECT id FROM rsvps WHERE form_id = ? AND user_id = ?",
);

const insertUser = sqlite.prepare(
	"INSERT INTO users (id, hackclub_id, name, email, avatar_url, slack_id, is_allowed, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
);

const insertRsvp = sqlite.prepare(
	"INSERT INTO rsvps (id, form_id, user_id, created_at) VALUES (?, ?, ?, ?)",
);

async function resolveUser(
	slackUserId: string,
	client: App["client"],
): Promise<{ id: string; is_allowed: number } | null> {
	const existing = getUserBySlackId.get(slackUserId);
	if (existing) return existing;

	// dey not in da db
	const check = await fetch(
		`https://identity.hackclub.com/api/external/check?slack_id=${slackUserId}`,
	)
		.then((r) => r.json())
		.catch(() => null);

	if (check?.result !== "verified_eligible") return null;

	// profile from slakc
	const info = await client.users.info({ user: slackUserId }).catch(() => null);
	const profile = (info as any)?.user?.profile;
	const name: string =
		profile?.display_name || profile?.real_name || slackUserId;
	const avatarUrl: string | null =
		profile?.image_192 || profile?.image_72 || null;
	const hackclubId: string = String(check.id ?? `slack_${slackUserId}`); // TEMPORARY id!! gets overwritten if logged in since we lookup by slack id

	const userId = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	insertUser.run(userId, hackclubId, name, "", avatarUrl, slackUserId, now);

	return { id: userId, is_allowed: 1 };
}

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true,
});

const rawPublicUrl = process.env.DEV
	? "https://rsvp.hackclub.community"
	: process.env.PUBLIC_URL || "https://rsvp.hackclub.community";

const publicUrls = rawPublicUrl
	.split(",")
	.map((u) => u.trim().replace(/\/$/, ""))
	.filter(Boolean);

if (publicUrls.length === 0) {
	throw new Error("PUBLIC_URL must contain at least one valid URL");
}

const escapedUrls = publicUrls.map((u) =>
	u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
);
const linkRegex = new RegExp(`^(?:${escapedUrls.join("|")})/([\\w-]+)$`);

app.event("link_shared", async ({ event, client }) => {
	const unfurls: Record<string, object> = {};

	for (const link of event.links) {
		const match = linkRegex.exec(link.url);
		if (!match) continue;

		const slug = match[1];
		const form = getForm.get(slug);
		if (!form || !form.is_open) continue;

		unfurls[link.url] = {
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*${form.title}*${form.description ? `\n${form.description}` : ""}`,
					},
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "RSVP", emoji: true },
							value: form.slug,
							action_id: "rsvp_open",
							style: "danger",
						},
					],
				},
			],
		};
	}

	if (Object.keys(unfurls).length === 0) return;

	const unfurlArgs = event.unfurl_id
		? {
				unfurl_id: event.unfurl_id,
				source: event.source as "composer" | "conversations_history",
			}
		: { channel: event.channel, ts: event.message_ts };

	const result = await client.chat.unfurl({ ...unfurlArgs, unfurls });
	if (!result.ok) console.error("slack: chat.unfurl failed", result.error);
});

app.action("rsvp_open", async ({ ack, body, client }) => {
	await ack();

	const slackUserId = body.user.id;
	const channelId = (body as any).channel?.id;
	const slug = (body as any).actions?.[0]?.value;
	if (!slug || !channelId) return;

	const ephemeral = (text: string) =>
		client.chat.postEphemeral({ channel: channelId, user: slackUserId, text });

	const user = await resolveUser(slackUserId, client);
	if (!user) {
		await ephemeral("You're not currently eligible to RSVP for events.");
		return;
	}
	if (!user.is_allowed) {
		await ephemeral("You're not currently eligible to RSVP for events.");
		return;
	}

	const form = getForm.get(slug);
	if (!form || !form.is_open) {
		await ephemeral("This form is no longer open.");
		return;
	}

	if (form.creator_id === user.id) {
		await ephemeral("You can't RSVP to your own event.");
		return;
	}

	if (getExistingRsvp.get(form.id, user.id)) {
		await ephemeral(`You're already RSVP'd for *${form.title}*!`);
		return;
	}

	insertRsvp.run(
		crypto.randomUUID(),
		form.id,
		user.id,
		Math.floor(Date.now() / 1000),
	);

	if (form.slack_channel_id) {
		await client.conversations
			.invite({ channel: form.slack_channel_id, users: slackUserId })
			.catch(() => {});
	}

	await ephemeral(`You're RSVP'd for *${form.title}*!`);
});

await app.start();
console.log("slack: running");
