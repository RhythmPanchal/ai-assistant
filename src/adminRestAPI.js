import { Router } from "express";

import { getDB } from "./tools/mongo/mongoClient.js";
import { USERS } from "./tools/mongo/schema/usersSchema.js";
import { USER_IDENTITY } from "./tools/mongo/schema/userIdentitySchema.js";
import { CHAT_HISTORY } from "./tools/mongo/schema/chatHistorySchema.js";
import { runWithUserContext } from "./identity/userContext.js";
import { runAgent } from "./agent/agent.js";
import { IST_TIMEZONE } from "./tools/mongo/dateUtils.js";

/*
=============================== ADMIN ENDPOINTS ================================

A development console: list the people the bot knows, talk to the agent AS any
one of them, and read back their conversations day by day. It is the same
runAgent every Telegram turn goes through — no shortcut path, no second
instruction set — so what you see here is what the bot actually does.

WHY IT IS BEHIND A TOKEN, AND WHY IT FAILS CLOSED

This router is mounted on the same Express app as the OAuth callbacks, which
means it is served from BASE_URL and is publicly reachable whenever the bot is.
Every route here either impersonates a user or reads their whole conversation
history, so an unauthenticated version is a total compromise of every account
the bot holds — strictly worse than the forged-update hole the Telegram webhook
secret exists to close.

So ADMIN_API_TOKEN is not optional. With it unset every route answers 503 and
the console does not work at all, which is the correct behaviour on a
deployment that never meant to turn this on. The alternative — defaulting to
open, or to a known token — is how a debug console ends up live in production.
*/

const router = Router();

const ADMIN_CHANNEL = "app";

/**
 * Source recorded on every turn this console produces.
 *
 * Deliberately NOT "telegram". It is written into chatHistory.source and read
 * back by the day transcript and the summarizer, and an unknown source is
 * treated as an ordinary conversation everywhere (resolveTask falls through to
 * "conversation", SOURCE_LABELS has no entry so the turn renders as a plain
 * user/assistant exchange). That is exactly right: this IS a real conversation,
 * it just did not arrive over Telegram — and labelling it honestly means a day
 * summarised later cannot mistake a console test for something the person said
 * on their phone.
 */
const ADMIN_SOURCE = "app";

// A day list has to read a user's whole history to be a day list, but a single
// day does not. Bracketing the instant query a day either side of the target
// keeps it on the (userId, createdAt) index while the exact local-day match
// below does the real filtering — no timezone can push a turn further out than
// this, and UTC-14..UTC+14 is only 28 hours of the 72 this allows.
const DAY_BRACKET_MS = 86400000;

function unauthorized(res, message) {
    return res.status(401).json({ error: message });
}

/**
 * Token gate. Reads the header first and the query string second, because a
 * token in a URL lands in access logs and browser history — the query form
 * exists only so a link can be pasted into a browser while debugging.
 */
function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_API_TOKEN;

    if (!expected) {
        return res.status(503).json({
            error: "Admin API is disabled. Set ADMIN_API_TOKEN in .env to enable it.",
        });
    }

    const presented = req.get("x-admin-token") || req.query.token;
    if (!presented) return unauthorized(res, "Missing admin token.");
    if (presented !== expected) return unauthorized(res, "Bad admin token.");

    next();
}

/**
 * CORS for the local console only.
 *
 * The UI is a Vite dev server on another origin, so the browser will not call
 * these routes without this. Restricted to loopback (plus an explicit
 * ADMIN_UI_ORIGIN) rather than "*" so a page on the open internet cannot make
 * a logged-in browser useful to it — belt and braces, since the token is sent
 * as a header and a cross-origin page cannot read one it does not already know.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function adminCors(req, res, next) {
    const origin = req.get("origin");
    const allowed = origin && (LOOPBACK_ORIGIN.test(origin) || origin === process.env.ADMIN_UI_ORIGIN);

    if (allowed) {
        res.set("Access-Control-Allow-Origin", origin);
        res.set("Access-Control-Allow-Headers", "content-type, x-admin-token");
        res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.set("Access-Control-Max-Age", "600");
    }
    // Always, even when the origin was refused: the answer varies by origin and
    // a shared cache must not serve one origin's response to another.
    res.set("Vary", "Origin");

    if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
    next();
}

/* ───────────────────────────── per-user serialisation ─────────────────────── */

/**
 * One agent turn at a time per user.
 *
 * runAgent reads the day's chatHistory at the start of a turn and writes a
 * single document at the end, so two turns for one user running at once both
 * read the same history and neither sees the other — the second reply is
 * written as though the first never happened. The console makes that easy to
 * hit: a double-tap on send, or two browser tabs on the same user.
 *
 * Keyed by userId so different users still run concurrently, and the chain is
 * dropped once it drains so this map cannot grow forever.
 */
const turnChains = new Map();

function runSerially(userId, fn) {
    const previous = turnChains.get(userId) ?? Promise.resolve();

    // Same handler for both outcomes: a turn that threw must not stop the next
    // one from running. The caller still receives the rejection via runNext.
    const runNext = previous.then(fn, fn);

    // The queue holds the SETTLED form, so a rejection is never unhandled and
    // never propagates into the turn queued behind it.
    const settled = runNext.then(() => {}, () => {});
    turnChains.set(userId, settled);

    settled.then(() => {
        // Drop the chain once nothing queued behind this turn, so the map does
        // not keep one entry per user for the life of the process.
        if (turnChains.get(userId) === settled) turnChains.delete(userId);
    });

    return runNext;
}

/* ─────────────────────────────────── routes ───────────────────────────────── */

router.use("/admin", adminCors, requireAdmin);

/** Cheap probe so the console can validate its token before doing anything. */
router.get("/admin/health", (req, res) => {
    res.json({ ok: true, channel: ADMIN_CHANNEL });
});

/**
 * Everyone the bot knows, newest first.
 *
 * Identities are folded in because the internal userId is meaningless on its
 * own — "user 4" is only recognisable once you can see it is the Telegram
 * account called Rhythm.
 */
router.get("/admin/users", async (req, res) => {
    try {
        const db = await getDB();

        const [users, identities] = await Promise.all([
            db.collection(USERS).find({}).sort({ createdAt: -1 }).toArray(),
            db.collection(USER_IDENTITY).find({}).toArray(),
        ]);

        const byUser = new Map();
        for (const identity of identities) {
            const list = byUser.get(identity.userId) ?? [];
            list.push({
                channel: identity.channel,
                externalId: identity.externalId,
                address: identity.address ?? null,
                displayName: identity.displayName ?? null,
                isPrimary: identity.isPrimary === true,
            });
            byUser.set(identity.userId, list);
        }

        res.json({
            users: users.map(user => ({
                userId: user.userId,
                name: user.name ?? `user${user.userId}`,
                timezone: user.timezone ?? IST_TIMEZONE,
                locale: user.locale ?? null,
                currency: user.currency ?? null,
                status: user.status ?? "active",
                onboardedAt: user.onboardedAt ?? null,
                routines: user.preferences?.triggersOptIn === true,
                createdAt: user.createdAt ?? null,
                identities: byUser.get(user.userId) ?? [],
            })),
        });
    } catch (err) {
        console.error("[admin] /admin/users failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

/**
 * Talk to the agent as a given user.
 *
 * The context bound here is the trust boundary, exactly as it is in the
 * Telegram handler — identity comes from the admin token having authenticated
 * the OPERATOR, and the operator naming a userId. It is never taken from
 * anything the model or the message text says.
 *
 * `address` stays null: there is no channel to deliver to. Anything that needs
 * to reach the person out of band (a connector button, a reminder) resolves
 * their Telegram address from userIdentity rather than from this context.
 */
router.post("/admin/chat", async (req, res) => {
    const userId = Number(req.body?.userId);
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

    if (!Number.isInteger(userId)) {
        return res.status(400).json({ error: "userId must be an integer." });
    }
    if (!message) {
        return res.status(400).json({ error: "message is required." });
    }

    try {
        const db = await getDB();
        // Refuse an id that owns nothing. Binding a context for a user that does
        // not exist would happily create rows under it and quietly build a
        // phantom account out of typos.
        const user = await db.collection(USERS).findOne({ userId });
        if (!user) return res.status(404).json({ error: `No user with userId ${userId}.` });

        const { text, metrics } = await runSerially(userId, () =>
            runWithUserContext(
                { userId, channel: ADMIN_CHANNEL, address: null },
                () => runAgent(userId, message, ADMIN_SOURCE)
            )
        );

        res.json({ userId, reply: text, metrics: metrics ?? null });
    } catch (err) {
        console.error("[admin] /admin/chat failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

/**
 * Which days this user has conversations on, newest first.
 *
 * Grouped in the USER's timezone, not the host's. A turn at 01:30 IST belongs
 * to that IST day; bucketing it by the server's UTC clock would file it under
 * the previous one, and the day a conversation is filed under is the one thing
 * this view exists to get right.
 */
router.get("/admin/users/:userId/days", async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId must be an integer." });

    try {
        const db = await getDB();
        const timeZone = (await db.collection(USERS).findOne({ userId }))?.timezone || IST_TIMEZONE;

        const days = await db.collection(CHAT_HISTORY).aggregate([
            { $match: { userId } },
            {
                $group: {
                    _id: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: timeZone } },
                    turns: { $sum: 1 },
                    firstAt: { $min: "$createdAt" },
                    lastAt: { $max: "$createdAt" },
                },
            },
            { $sort: { _id: -1 } },
        ]).toArray();

        res.json({
            userId,
            timezone: timeZone,
            days: days.map(d => ({ date: d._id, turns: d.turns, firstAt: d.firstAt, lastAt: d.lastAt })),
        });
    } catch (err) {
        console.error("[admin] /admin/users/:userId/days failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

/**
 * One day's conversation, oldest first.
 *
 * Returns the turns whole — user message, every tool call and result, the final
 * reply — because the point of reading history in a console is seeing what the
 * agent DID, which is the half the chat window necessarily hides.
 */
router.get("/admin/users/:userId/history", async (req, res) => {
    const userId = Number(req.params.userId);
    const date = String(req.query.date || "");

    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId must be an integer." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD." });
    }

    try {
        const db = await getDB();
        const timeZone = (await db.collection(USERS).findOne({ userId }))?.timezone || IST_TIMEZONE;

        const anchor = new Date(`${date}T00:00:00Z`).getTime();

        const turns = await db.collection(CHAT_HISTORY).aggregate([
            {
                $match: {
                    userId,
                    createdAt: {
                        $gte: new Date(anchor - DAY_BRACKET_MS),
                        $lt: new Date(anchor + 2 * DAY_BRACKET_MS),
                    },
                },
            },
            {
                $addFields: {
                    localDate: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: timeZone } },
                },
            },
            { $match: { localDate: date } },
            { $sort: { createdAt: 1 } },
            { $project: { llmConversationMetadata: 0 } },
        ]).toArray();

        res.json({
            userId,
            date,
            timezone: timeZone,
            turns: turns.map(turn => ({
                conversationId: turn.conversationId,
                source: turn.source ?? null,
                createdAt: turn.createdAt,
                messages: (turn.messages ?? []).map(msg => ({
                    role: msg.role,
                    content: msg.content ?? null,
                    toolName: msg.toolName ?? null,
                    functionCalls: msg.functionCalls ?? null,
                    result: msg.result ?? null,
                    timestamp: msg.timestamp ?? null,
                })),
            })),
        });
    } catch (err) {
        console.error("[admin] /admin/users/:userId/history failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

export default router;
