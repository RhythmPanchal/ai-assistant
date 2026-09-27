import crypto from "node:crypto";
import { Router } from "express";

import { getDB } from "./tools/mongo/mongoClient.js";
import { USERS, NOTE_SECTIONS } from "./tools/mongo/schema/usersSchema.js";
import { EXPENSE_REGISTER } from "./tools/mongo/schema/expenseRegisterSchema.js";
import { DIET_REGISTER } from "./tools/mongo/schema/dietRegisterSchema.js";
import { TASK_REGISTER } from "./tools/mongo/schema/taskRegisterSchema.js";
import { TASK_CALENDAR } from "./tools/mongo/schema/taskCalendarSchema.js";
import { USER_SCHEDULE } from "./tools/mongo/schema/userScheduleSchema.js";
import { CHAT_SUMMARY } from "./tools/mongo/schema/chatSummarySchema.js";
import { toIST, localDateOf, previousDay, IST_TIMEZONE } from "./tools/mongo/dateUtils.js";

const router = Router();

const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "rasmalai_session";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function secret() {
    return process.env.SESSION_SECRET || "";
}

function b64(input) {
    return Buffer.from(input).toString("base64url");
}

function sign(payload) {
    return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function mintToken(purpose, userId, epoch, ttlMs) {
    const payload = `v1.${purpose}.${userId}.${Date.now() + ttlMs}.${epoch}`;
    return `${b64(payload)}.${sign(payload)}`;
}

function readToken(token, purpose) {
    if (typeof token !== "string" || !token.includes(".")) return null;

    const cut = token.lastIndexOf(".");
    const encoded = token.slice(0, cut);
    const presented = token.slice(cut + 1);

    let payload;
    try {
        payload = Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
        return null;
    }

    const expected = sign(payload);
    if (
        presented.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
    ) {
        return null;
    }

    const [version, tokenPurpose, userId, expiresAt, epoch] = payload.split(".");
    if (version !== "v1" || tokenPurpose !== purpose) return null;
    if (!Number(expiresAt) || Number(expiresAt) < Date.now()) return null;

    return { userId: Number(userId), epoch: Number(epoch) };
}

export function dashboardOrigin() {
    const base = (process.env.APP_UI_ORIGIN || "").split(",")[0].trim().replace(/\/+$/, "");
    return /^https?:\/\//i.test(base) ? base : null;
}

export function createLoginLink(userId, epoch = 0) {
    const base = dashboardOrigin();
    if (!base) {
        throw new Error("APP_UI_ORIGIN is not set to an http(s) origin — cannot build a dashboard link");
    }
    if (!secret()) {
        throw new Error("SESSION_SECRET is not set — cannot sign a dashboard link");
    }

    const code = mintToken("login", userId, epoch, LOGIN_TTL_MS);
    return { code, url: `${base}/login#${code}`, minutes: Math.round(LOGIN_TTL_MS / 60000) };
}

function allowedOrigins() {
    return String(process.env.APP_UI_ORIGIN || "")
        .split(",")
        .map(origin => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function appCors(req, res, next) {
    const origin = req.get("origin");
    const allowed = origin && (LOOPBACK_ORIGIN.test(origin) || allowedOrigins().includes(origin));

    if (allowed) {
        res.set("Access-Control-Allow-Origin", origin);
        res.set("Access-Control-Allow-Credentials", "true");
        res.set("Access-Control-Allow-Headers", "content-type, authorization");
        res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
        res.set("Access-Control-Max-Age", "600");
    }
    res.set("Vary", "Origin");

    if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
    next();
}

function cookieFrom(req) {
    const raw = req.get("cookie");
    if (!raw) return null;

    for (const part of raw.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
    }
    return null;
}

function presentedSession(req) {
    const header = req.get("authorization");
    if (header?.startsWith("Bearer ")) return header.slice(7).trim();
    return cookieFrom(req);
}

function setSessionCookie(res, token) {
    const bits = [
        `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=None",
        `Max-Age=${Math.round(SESSION_TTL_MS / 1000)}`,
    ];
    res.append("Set-Cookie", bits.join("; "));
}

function clearSessionCookie(res) {
    res.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
}

function sessionEpochOf(user) {
    return Number.isInteger(user?.preferences?.sessionEpoch) ? user.preferences.sessionEpoch : 0;
}

async function requireUser(req, res, next) {
    if (!secret()) {
        return res.status(503).json({ error: "Sessions are disabled. Set SESSION_SECRET." });
    }

    const claim = readToken(presentedSession(req), "session");
    if (!claim) return res.status(401).json({ error: "Not signed in." });

    try {
        const db = await getDB();
        const user = await db.collection(USERS).findOne({ userId: claim.userId });
        if (!user) return res.status(401).json({ error: "Not signed in." });
        if (sessionEpochOf(user) !== claim.epoch) {
            return res.status(401).json({ error: "Session expired. Sign in again." });
        }

        req.user = user;
        req.timeZone = user.timezone || IST_TIMEZONE;
        next();
    } catch (err) {
        console.error("[app] session lookup failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
}

function dayRange(from, to) {
    return { $gte: toIST(`${from}T00:00:00`), $lt: toIST(`${nextDay(to)}T00:00:00`) };
}

function nextDay(date) {
    const at = new Date(`${date}T12:00:00Z`);
    return new Date(at.getTime() + 86400000).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
    const a = new Date(`${from}T12:00:00Z`).getTime();
    const b = new Date(`${to}T12:00:00Z`).getTime();
    return Math.round((b - a) / 86400000) + 1;
}

const MEAL_ORDER = ["Breakfast", "Lunch", "Dinner", "Snack"];

function byMealOrder(a, b) {
    const ai = MEAL_ORDER.indexOf(a?.mealType);
    const bi = MEAL_ORDER.indexOf(b?.mealType);
    return (ai === -1 ? MEAL_ORDER.length : ai) - (bi === -1 ? MEAL_ORDER.length : bi);
}

function readRange(req, res) {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        res.status(400).json({ error: "from and to must be YYYY-MM-DD." });
        return null;
    }
    if (from > to) {
        res.status(400).json({ error: "from must not be after to." });
        return null;
    }
    if (daysBetween(from, to) > MAX_RANGE_DAYS) {
        res.status(400).json({ error: `Range is limited to ${MAX_RANGE_DAYS} days.` });
        return null;
    }
    return { from, to };
}

router.use("/api", appCors);

router.post("/api/auth/exchange", async (req, res) => {
    if (!secret()) {
        return res.status(503).json({ error: "Sessions are disabled. Set SESSION_SECRET." });
    }

    const claim = readToken(req.body?.code, "login");
    if (!claim) return res.status(401).json({ error: "That link is invalid or has expired." });

    try {
        const db = await getDB();
        const user = await db.collection(USERS).findOne({ userId: claim.userId });
        if (!user) return res.status(401).json({ error: "That link is invalid or has expired." });

        const epoch = sessionEpochOf(user);
        const token = mintToken("session", user.userId, epoch, SESSION_TTL_MS);
        setSessionCookie(res, token);

        res.json({
            token,
            expiresInDays: Math.round(SESSION_TTL_MS / 86400000),
            user: { userId: user.userId, name: user.name ?? `user${user.userId}` },
        });
    } catch (err) {
        console.error("[app] /api/auth/exchange failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.post("/api/auth/logout", requireUser, async (req, res) => {
    try {
        const db = await getDB();
        await db.collection(USERS).updateOne(
            { userId: req.user.userId },
            { $inc: { "preferences.sessionEpoch": 1 }, $set: { updatedAt: new Date() } }
        );
        clearSessionCookie(res);
        res.json({ ok: true });
    } catch (err) {
        console.error("[app] /api/auth/logout failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.get("/api/me", requireUser, (req, res) => {
    const user = req.user;
    res.json({
        userId: user.userId,
        name: user.name ?? `user${user.userId}`,
        timezone: req.timeZone,
        currency: user.currency ?? null,
        locale: user.locale ?? null,
        onboarded: Boolean(user.onboardedAt),
        routines: user.preferences?.triggersOptIn === true,
        today: localDateOf(new Date(), req.timeZone),
        notes: NOTE_SECTIONS.map(({ key, label }) => ({
            key,
            label,
            text: user.notes?.[key]?.text ?? null,
        })),
    });
});

router.get("/api/me/overview", requireUser, async (req, res) => {
    try {
        const db = await getDB();
        const userId = req.user.userId;
        const timeZone = req.timeZone;

        const today = localDateOf(new Date(), timeZone);
        const yesterday = previousDay(today);
        const threeDaysAgo = previousDay(previousDay(yesterday));

        const [schedule, summaries, expenses, tasks, diet, pending] = await Promise.all([
            db.collection(USER_SCHEDULE).findOne({ userId, date: dayRange(today, today) }),
            db.collection(CHAT_SUMMARY)
                .find({ userId, date: dayRange(threeDaysAgo, yesterday) })
                .sort({ date: -1 })
                .toArray(),
            db.collection(EXPENSE_REGISTER)
                .find({ userId, date: dayRange(yesterday, yesterday) })
                .sort({ amount: -1 })
                .toArray(),
            db.collection(TASK_REGISTER).findOne({ userId, date: dayRange(yesterday, yesterday) }),
            db.collection(DIET_REGISTER).findOne({ userId, date: dayRange(yesterday, yesterday) }),
            db.collection(TASK_CALENDAR)
                .find({ userId, status: "Pending" })
                .sort({ priorityScore: 1, dueDate: 1 })
                .limit(20)
                .toArray(),
        ]);

        res.json({
            today,
            yesterday,
            timezone: timeZone,
            currency: req.user.currency ?? null,
            schedule: schedule
                ? { date: today, day: schedule.day ?? null, slots: schedule.slots ?? [] }
                : null,
            recentDays: summaries.map(row => ({
                date: localDateOf(row.date, timeZone),
                headline: row.headline ?? null,
                mood: row.mood ?? null,
                followThrough: row.followThrough ?? null,
                productivity: row.productivity ?? null,
                ratings: row.ratings ?? null,
            })),
            pendingTasks: pending.map(task => ({
                id: String(task._id),
                title: task.title,
                category: task.category ?? null,
                priorityScore: task.priorityScore ?? null,
                dueDate: task.dueDate ? localDateOf(task.dueDate, timeZone) : null,
            })),
            lastDay: {
                date: yesterday,
                expenses: {
                    logged: expenses.length > 0,
                    total: expenses.reduce((sum, row) => sum + (row.amount ?? 0), 0),
                    count: expenses.length,
                    rows: expenses.slice(0, 5).map(row => ({
                        name: row.name,
                        amount: row.amount,
                        category: row.category ?? null,
                    })),
                },
                tasks: {
                    logged: Boolean(tasks),
                    count: tasks?.performedTasks?.length ?? 0,
                    rows: (tasks?.performedTasks ?? []).slice(0, 6).map(task => ({
                        title: task.title,
                        category: task.category ?? null,
                        actualFrom: task.actualFrom ?? null,
                        actualTo: task.actualTo ?? null,
                    })),
                },
                diet: {
                    logged: Boolean(diet),
                    totals: diet?.dailyTotals ?? null,
                    meals: (diet?.meals ?? []).map(meal => meal.mealType).filter(Boolean),
                    waterIntakeMl: diet?.waterIntakeMl ?? null,
                },
            },
        });
    } catch (err) {
        console.error("[app] /api/me/overview failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.get("/api/me/expenses", requireUser, async (req, res) => {
    const range = readRange(req, res);
    if (!range) return;

    try {
        const db = await getDB();
        const userId = req.user.userId;
        const timeZone = req.timeZone;
        const match = { userId, date: dayRange(range.from, range.to) };

        const [rows, byCategory, byDay] = await Promise.all([
            db.collection(EXPENSE_REGISTER).find(match).sort({ date: -1, amount: -1 }).toArray(),
            db.collection(EXPENSE_REGISTER).aggregate([
                { $match: match },
                { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
                { $sort: { total: -1 } },
            ]).toArray(),
            db.collection(EXPENSE_REGISTER).aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { $dateToString: { date: "$date", format: "%Y-%m-%d", timezone: timeZone } },
                        total: { $sum: "$amount" },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]).toArray(),
        ]);

        res.json({
            from: range.from,
            to: range.to,
            currency: req.user.currency ?? null,
            total: rows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
            count: rows.length,
            byCategory: byCategory.map(row => ({ category: row._id ?? "Misc", total: row.total, count: row.count })),
            byDay: byDay.map(row => ({ date: row._id, total: row.total, count: row.count })),
            rows: rows.map(row => ({
                id: String(row._id),
                date: localDateOf(row.date, timeZone),
                name: row.name,
                amount: row.amount,
                category: row.category ?? null,
                paymentMethod: row.paymentMethod ?? null,
                notes: row.notes ?? null,
            })),
        });
    } catch (err) {
        console.error("[app] /api/me/expenses failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.get("/api/me/diet", requireUser, async (req, res) => {
    const range = readRange(req, res);
    if (!range) return;

    try {
        const db = await getDB();
        const timeZone = req.timeZone;

        const docs = await db.collection(DIET_REGISTER)
            .find({ userId: req.user.userId, date: dayRange(range.from, range.to) })
            .sort({ date: 1 })
            .toArray();

        res.json({
            from: range.from,
            to: range.to,
            days: docs.map(doc => ({
                date: localDateOf(doc.date, timeZone),
                dietType: doc.dietType ?? null,
                totals: doc.dailyTotals ?? null,
                waterIntakeMl: doc.waterIntakeMl ?? null,
                adherenceScore: doc.adherenceScore ?? null,
                meals: [...(doc.meals ?? [])].sort(byMealOrder).map(meal => ({
                    mealType: meal.mealType ?? null,
                    items: (meal.items ?? []).map(item => ({
                        name: item.name,
                        quantity: item.quantity ?? null,
                        calories: item.calories ?? null,
                    })),
                })),
            })),
        });
    } catch (err) {
        console.error("[app] /api/me/diet failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

router.get("/api/me/tasks", requireUser, async (req, res) => {
    const range = readRange(req, res);
    if (!range) return;

    try {
        const db = await getDB();
        const timeZone = req.timeZone;

        const docs = await db.collection(TASK_REGISTER)
            .find({ userId: req.user.userId, date: dayRange(range.from, range.to) })
            .sort({ date: 1 })
            .toArray();

        res.json({
            from: range.from,
            to: range.to,
            days: docs.map(doc => ({
                date: localDateOf(doc.date, timeZone),
                day: doc.day ?? null,
                tasks: (doc.performedTasks ?? []).map(task => ({
                    title: task.title,
                    category: task.category ?? null,
                    actualFrom: task.actualFrom ?? null,
                    actualTo: task.actualTo ?? null,
                })),
            })),
        });
    } catch (err) {
        console.error("[app] /api/me/tasks failed:", err);
        res.status(500).json({ error: String(err.message || err) });
    }
});

export default router;
export { requireUser, readToken, mintToken };
