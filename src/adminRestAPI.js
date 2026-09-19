import { Router } from "express";

import { getDB } from "./tools/mongo/mongoClient.js";
import { USERS } from "./tools/mongo/schema/usersSchema.js";
import { USER_IDENTITY } from "./tools/mongo/schema/userIdentitySchema.js";
import { CHAT_HISTORY } from "./tools/mongo/schema/chatHistorySchema.js";
import { runWithUserContext } from "./identity/userContext.js";
import { runAgent } from "./agent/agent.js";
import { IST_TIMEZONE } from "./tools/mongo/dateUtils.js";

const router = Router();

const ADMIN_CHANNEL = "app";

const ADMIN_SOURCE = "app";

const DAY_BRACKET_MS = 86400000;

function unauthorized(res, message) {
    return res.status(401).json({ error: message });
}

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
    res.set("Vary", "Origin");

    if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
    next();
}

const turnChains = new Map();

function runSerially(userId, fn) {
    const previous = turnChains.get(userId) ?? Promise.resolve();

    
    const runNext = previous.then(fn, fn);
    const settled = runNext.then(() => {}, () => {});
    turnChains.set(userId, settled);

    settled.then(() => {
       
        if (turnChains.get(userId) === settled) turnChains.delete(userId);
    });

    return runNext;
}

router.use("/admin", adminCors, requireAdmin);

router.get("/admin/health", (req, res) => {
    res.json({ ok: true, channel: ADMIN_CHANNEL });
});

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
