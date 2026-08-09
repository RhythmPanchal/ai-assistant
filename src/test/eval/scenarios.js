/**
 * Eval scenarios. Each states a user message, what a correct agent does, and
 * how to grade it. Tool EXECUTION is stubbed so grading is deterministic and
 * nothing is written to Mongo — what is measured is tool selection, argument
 * quality, and knowing when NOT to act.
 */

export const USER_ID = 1136575387;

const SCHEMAS = {
    expenseRegister: {
        collectionName: "expenseRegister",
        schema: {
            properties: {
                name: { bsonType: "string" }, amount: { bsonType: "double" },
                category: { bsonType: "string", enum: ["Food", "Travel", "Shopping", "Medical", "Bills", "Entertainment", "Misc"] },
                date: { bsonType: "date" }, month: { bsonType: "string" }, year: { bsonType: "int" },
            },
            required: ["name", "amount", "category", "date", "month", "year"],
        },
    },
    taskCalendar: {
        collectionName: "taskCalendar",
        schema: { properties: { title: { bsonType: "string" }, deadline: { bsonType: "date" }, status: { bsonType: "string" } } },
    },
};

const FOOD_ROWS = [
    { _id: "68a1", name: "Lunch - thali", amount: 250, category: "Food", date: "2026-08-02" },
    { _id: "68a2", name: "Groceries", amount: 1200, category: "Food", date: "2026-08-05" },
    { _id: "68a3", name: "Coffee", amount: 480, category: "Food", date: "2026-08-07" },
];

const GYM_TASK = { _id: "66f0c2b41a2b3c4d5e6f7a88", title: "Gym", deadline: "2026-08-10T18:00:00", status: "Pending" };

const names = (t) => t.map((c) => c.name);
const called = (t, n) => t.find((c) => c.name === n);
const wrote = (t) => t.some((c) => /^(createRecord|updateRecords|createTask|insertSchedule)$/.test(c.name));

export const SCENARIOS = [
    {
        id: "read",
        query: "How much did I spend on food this month?",
        expected: [
            "fetchRecord on expenseRegister (a schema lookup first is fine)",
            "answer stating the total 1930",
            "no writes",
        ],
        stubs: {
            fetchCollectionNameAndSchema: () => SCHEMAS,
            fetchRecord: (a) => (a?.collection === "expenseRegister" ? FOOD_ROWS : { error: "not whitelisted" }),
        },
        grade: (t, text) => ({
            calledFetchRecord: Boolean(called(t, "fetchRecord")),
            rightCollection: called(t, "fetchRecord")?.args?.collection === "expenseRegister",
            filteredByUser: JSON.stringify(called(t, "fetchRecord")?.args?.filters ?? {}).includes(String(USER_ID)),
            answeredTotal: /1[,.]?930/.test(text || ""),
            noWrites: !wrote(t),
        }),
    },

    {
        id: "log-clear",
        query: "spent 250 on lunch today",
        expected: [
            "createRecord into expenseRegister with amount 250, category Food",
            "confirm in one short line",
            "does NOT ask a question — every required detail was given",
        ],
        stubs: {
            fetchCollectionNameAndSchema: () => SCHEMAS,
            createRecord: () => ({ success: true, insertedId: "68b0" }),
        },
        grade: (t, text) => {
            const c = called(t, "createRecord");
            const d = c?.args?.data ?? {};
            const parsed = typeof d === "string" ? safeJson(d) : d;
            return {
                calledCreateRecord: Boolean(c),
                rightCollection: c?.args?.collectionName === "expenseRegister",
                rightAmount: Number(parsed?.amount) === 250,
                validCategory: ["Food", "Travel", "Shopping", "Medical", "Bills", "Entertainment", "Misc"].includes(parsed?.category),
                noTrailingQuestion: !/\?\s*$/.test((text || "").trim()),
                confirmed: /log|record|sav|add/i.test(text || ""),
            };
        },
    },

    {
        id: "log-ambiguous",
        query: "lunch was expensive today",
        expected: [
            "asks how much — the amount is required and was not given",
            "writes NOTHING; a guessed amount is the worst failure mode here",
        ],
        stubs: {
            fetchCollectionNameAndSchema: () => SCHEMAS,
            createRecord: () => ({ success: true, insertedId: "68b1" }),
        },
        grade: (t, text) => ({
            wroteNothing: !wrote(t),
            askedForAmount: /\?/.test(text || "") && /how much|amount|cost|spend/i.test(text || ""),
            didNotInventAmount: !wrote(t),
        }),
    },

    {
        id: "update-no-fabrication",
        query: "push my gym task to 7pm today",
        expected: [
            "fetchRecord on taskCalendar to obtain the real _id",
            "updateRecords using EXACTLY that _id",
            "deadline written as naive local time, no Z and no offset",
        ],
        stubs: {
            fetchCollectionNameAndSchema: () => SCHEMAS,
            fetchRecord: () => [GYM_TASK],
            updateRecords: () => ({ success: true, modified: 1 }),
        },
        grade: (t) => {
            const u = called(t, "updateRecords");
            const rec = (u?.args?.records || [])[0] ?? {};
            const idUsed = String(rec.id ?? "");
            const blob = JSON.stringify(rec.data ?? {});
            return {
                fetchedFirst: names(t).indexOf("fetchRecord") >= 0 &&
                    (names(t).indexOf("updateRecords") === -1 ||
                     names(t).indexOf("fetchRecord") < names(t).indexOf("updateRecords")),
                calledUpdate: Boolean(u),
                usedRealId: idUsed === GYM_TASK._id,
                noFabricatedId: !u || idUsed === GYM_TASK._id,
                naiveDate: !/\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})/.test(blob),
            };
        },
    },

    {
        id: "reminder-date",
        query: "remind me tomorrow at 9pm to call mom",
        expected: [
            "createOneTimeReminder with nextExecutionAt for TOMORROW at 21:00",
            "naive local time — no trailing Z and no +05:30 offset",
            "userId included",
        ],
        stubs: {
            createOneTimeReminder: () => ({ success: true, insertedId: "68c0" }),
            fetchCollectionNameAndSchema: () => SCHEMAS,
        },
        grade: (t) => {
            const c = called(t, "createOneTimeReminder");
            const when = String(c?.args?.nextExecutionAt ?? "");
            const tomorrow = new Date(Date.now() + 86400000)
                .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            return {
                calledReminder: Boolean(c),
                correctDate: when.startsWith(tomorrow),
                correctTime: /T21:00/.test(when),
                naiveNoZone: Boolean(when) && !/(Z|[+-]\d{2}:?\d{2})$/.test(when),
                hasUserId: Number(c?.args?.userId) === USER_ID,
            };
        },
    },
];

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
