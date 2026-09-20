import { Router } from "express";

import { getDB } from "./tools/mongo/mongoClient.js";
import { USERS } from "./tools/mongo/schema/usersSchema.js";
import { USER_IDENTITY } from "./tools/mongo/schema/userIdentitySchema.js";
import { CHAT_HISTORY } from "./tools/mongo/schema/chatHistorySchema.js";
import { runWithUserContext } from "./identity/userContext.js";
import { runAgent } from "./agent/agent.js";
import {
    IST_TIMEZONE,
    DAY_START_HOUR,
    personalDayOf,
    personalDayRangeOf,
} from "./tools/mongo/dateUtils.js";
import { updateUserSettings, EDITABLE_SETTINGS } from "./tools/mongo/operation/userSettings.js";
import { getTrace } from "./tools/mongo/operation/llmTrace.js";
import { NOTE_SECTIONS } from "./tools/mongo/schema/usersSchema.js";

const router = Router();

const ADMIN_CHANNEL = "app";

const ADMIN_SOURCE = "app";

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

function allowedOrigins() {
    return String(process.env.ADMIN_UI_ORIGIN || "")
        .split(",")
        .map(origin => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

function adminCors(req, res, next) {
    const origin = req.get("origin");
    const allowed = origin && (LOOPBACK_ORIGIN.test(origin) || allowedOrigins().includes(origin));

    if (allowed) {
        res.set("Access-Control-Allow-Origin", origin);
        res.set("Access-Control-Allow-Headers", "content-type, x-admin-token");
        res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
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

function dayScope(user) {
    return {
        timeZone: user?.timezone || IST_TIMEZONE,
        dayStartHour: Number.isInteger(user?.preferences?.dayStartHour)
            ? user.preferences.dayStartHour
            : DAY_START_HOUR,
    };
}

async function findUser(userId) {
    const db = await getDB();
    return db.collection(USERS).findOne({ userId });
}

router.get("/admin/users/:userId", async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId must be an integer." });

    try {
        const db = await getDB();
        const user = await findUser(userId);
        if (!user) return res.status(404).json({ error: `No user with userId ${userId}.` });

        const identities = await db.collection(USER_IDENTITY).find({ userId }).toArray();
        const { timeZone, dayStartHour } = dayScope(user);

        res.json({
            userId: user.userId,
            name: user.name ?? `user${user.userId}`,
            settings: {
                timezone: timeZone,
                locale: user.locale ?? null,
                currency: user.currency ?? null,
                status: user.status ?? "active",
                morningHour: user.preferences?.morningHour ?? null,
                nightHour: user.preferences?.nightHour ?? null,
                dayStartHour,
                routines: user.preferences?.triggersOptIn === true,
                llmTrace: user.preferences?.llmTrace === true,
            },
            editableSettings: EDITABLE_SETTINGS,
            onboardedAt: user.onboardedAt ?? null,
            welcomedAt: user.welcomedAt ?? null,
            routinesChosenAt: user.preferences?.routinesChosenAt ?? null,
            enabledSkills: user.enabledSkills ?? [],
            notes: NOTE_SECTIONS.map(({ key, label, holds }) => ({
                key,
                label,
                holds,
                text: user.notes?.[key]?.text ?? null,
                updatedAt: user.notes?.[key]?.updatedAt ?? null,
            })),
            lastNudgedAt: user.notes?.lastNudgedAt ?? null,
            identities: identities.map(identity => ({
                channel: identity.channel,
                externalId: identity.externalId,
                address: identity.address ?? null,
                displayName: identity.displayName ?? null,
                isPrimary: identity.isPrimary === true,
            })),
            createdAt: user.createdAt ?? null,
            updatedAt: user.updatedAt ?? null,
        });
    } catch (err) {
        console.error("[admin] /admin/users/:userId failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.patch("/admin/users/:userId/settings", async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId must be an integer." });

    const settings = req.body?.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        return res.status(400).json({ error: "settings must be an object." });
    }

    const unknown = Object.keys(settings).filter(field => !EDITABLE_SETTINGS.includes(field));
    if (unknown.length) {
        return res.status(400).json({
            error: `Not editable: ${unknown.join(", ")}. Editable: ${EDITABLE_SETTINGS.join(", ")}.`,
        });
    }

    try {
        const user = await findUser(userId);
        if (!user) return res.status(404).json({ error: `No user with userId ${userId}.` });

        const { applied, rejected } = await runWithUserContext(
            { userId, channel: ADMIN_CHANNEL, address: null },
            () => updateUserSettings(userId, settings)
        );

        res.json({ userId, applied, rejected });
    } catch (err) {
        console.error("[admin] /admin/users/:userId/settings failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.get("/admin/users/:userId/days", async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId must be an integer." });

    try {
        const db = await getDB();
        const user = await findUser(userId);
        if (!user) return res.status(404).json({ error: `No user with userId ${userId}.` });

        const { timeZone, dayStartHour } = dayScope(user);

        const days = await db.collection(CHAT_HISTORY).aggregate([
            { $match: { userId } },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            date: { $subtract: ["$createdAt", dayStartHour * 3600000] },
                            format: "%Y-%m-%d",
                            timezone: timeZone,
                        },
                    },
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
            dayStartHour,
            today: personalDayOf(new Date(), { hour: dayStartHour, timeZone }),
            days: days.map(d => ({ date: d._id, turns: d.turns, firstAt: d.firstAt, lastAt: d.lastAt })),
        });
    } catch (err) {
        console.error("[admin] /admin/users/:userId/days failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.get("/admin/users/:userId/trace", async (req, res) => {
    const userId = Number(req.params.userId);
    const conversationId = String(req.query.conversationId || "");

    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId must be an integer." });
    if (!conversationId) return res.status(400).json({ error: "conversationId is required." });

    try {
        const trace = await getTrace(conversationId);
        if (!trace) {
            return res.status(404).json({
                error: "No trace for that turn. Tracing is off for this user, or the turn predates it.",
            });
        }
        if (trace.userId !== userId) {
            return res.status(404).json({ error: "No trace for that turn." });
        }

        res.json({
            conversationId: trace.conversationId,
            userId: trace.userId,
            task: trace.task ?? null,
            source: trace.source ?? null,
            systemInstruction: trace.systemInstruction ?? null,
            historyCount: trace.historyCount ?? 0,
            steps: trace.steps ?? [],
            createdAt: trace.createdAt,
        });
    } catch (err) {
        console.error("[admin] /admin/users/:userId/trace failed:", err);
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
        const user = await findUser(userId);
        if (!user) return res.status(404).json({ error: `No user with userId ${userId}.` });

        const { timeZone, dayStartHour } = dayScope(user);
        const range = personalDayRangeOf(date, { hour: dayStartHour, timeZone });
        if (!range) return res.status(400).json({ error: "date must be a real calendar date." });

        const turns = await db.collection(CHAT_HISTORY)
            .find({ userId, createdAt: { $gte: range.start, $lt: range.end } })
            .sort({ createdAt: 1 })
            .toArray();

        res.json({
            userId,
            date,
            timezone: timeZone,
            dayStartHour,
            startsAt: range.start,
            endsAt: range.end,
            turns: turns.map(turn => ({
                conversationId: turn.conversationId,
                source: turn.source ?? null,
                createdAt: turn.createdAt,
                metrics: turn.llmConversationMetadata ?? null,
                messages: (turn.messages ?? []).map(msg => ({
                    role: msg.role,
                    content: msg.content ?? null,
                    toolName: msg.toolName ?? null,
                    functionCalls: msg.functionCalls ?? null,
                    result: msg.result ?? null,
                    durationMs: msg.durationMs ?? null,
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
