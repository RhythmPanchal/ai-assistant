/**
 * Remove the two kinds of row that taskCalendar cannot recover from on its own:
 * duplicated open tasks, and blocks of the day that were filed as tasks.
 *
 * Both were write-path bugs, both are now refused by createTask, and neither
 * fixes itself — a duplicate is Pending forever and so is "Personal time /
 * catch up". Six titles were open twice, and every one of them appeared twice
 * in every morning schedule for seventeen days.
 *
 * The duplicates also block the guard that was meant to stop them: the partial
 * unique index on (userId, title) for Pending rows fails to build while they
 * exist, which is why ensureIndexes has been reporting one failure at every
 * boot. After this runs, the next boot builds it.
 *
 * NOTHING IS HARD DELETED. Every removed row is copied into `archivedRows`
 * first, keyed by migration, exactly as 002 does — a wrong call here is a
 * restore, not a loss.
 *
 * Only OPEN rows are touched. A duplicate under Completed is history and costs
 * nothing; it is counted in the report and left alone.
 */
import { getDB } from "../mongoClient.js";
import { TASK_CALENDAR } from "../schema/taskCalendarSchema.js";
import { isRoutineBlock } from "../operation/routineBlock.js";
import { ARCHIVE } from "./002-purge-and-renumber.js";

const MIGRATION = "003-task-hygiene";
const OPEN = ["Pending", "Scheduled"];

const normalise = (title) => String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** How much a row actually says. Between duplicates, the fuller one survives. */
function richness(task) {
    return ["requiredMinutes", "importance", "priorityScore", "category", "deadline", "recurring", "notes"]
        .filter(field => task[field] !== null && task[field] !== undefined).length;
}

export async function runTaskHygiene({ apply = false } = {}) {
    const db = await getDB();
    const col = db.collection(TASK_CALENDAR);
    const report = {
        apply,
        database: db.databaseName,
        status: "pending",
        duplicatesRemoved: [],
        routineBlocksRemoved: [],
        closedDuplicatesLeft: [],
        steps: [],
    };
    const step = (m) => { report.steps.push(m); console.log(`[migration:${MIGRATION}] ${m}`); };

    const all = await col.find({}).toArray();
    const doomed = new Map(); // _id string -> why

    // ── routine blocks: not tasks at all, in any state ───────────────────────
    for (const task of all) {
        if (!OPEN.includes(task.status)) continue;
        if (!isRoutineBlock(task.title)) continue;
        doomed.set(String(task._id), "routine block");
        report.routineBlocksRemoved.push({ id: String(task._id), userId: task.userId, title: task.title });
    }

    // ── duplicates: same owner, same title, both still open ──────────────────
    const groups = new Map();
    for (const task of all) {
        if (!OPEN.includes(task.status)) continue;
        if (doomed.has(String(task._id))) continue;
        const key = `${task.userId}::${normalise(task.title)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(task);
    }

    for (const [, rows] of groups) {
        if (rows.length < 2) continue;
        // Fullest row wins; oldest breaks the tie, so the surviving _id is the
        // one anything else in the database is more likely to already point at.
        const [keep, ...drop] = [...rows].sort((a, b) =>
            richness(b) - richness(a) || new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0)
        );
        for (const row of drop) {
            doomed.set(String(row._id), `duplicate of ${keep._id}`);
            report.duplicatesRemoved.push({
                id: String(row._id), userId: row.userId, title: row.title, keptId: String(keep._id),
            });
        }
    }

    // ── reported, never touched ──────────────────────────────────────────────
    const closed = new Map();
    for (const task of all) {
        if (OPEN.includes(task.status)) continue;
        const key = `${task.userId}::${normalise(task.title)}::${task.status}`;
        closed.set(key, (closed.get(key) ?? 0) + 1);
    }
    for (const [key, n] of closed) if (n > 1) report.closedDuplicatesLeft.push({ key, count: n });

    if (!doomed.size) {
        report.status = "nothing-to-do";
        step("no duplicate or routine-block rows found");
        return report;
    }

    if (!apply) {
        report.status = "dry-run";
        step(`dry run: would remove ${report.duplicatesRemoved.length} duplicates and ${report.routineBlocksRemoved.length} routine blocks`);
        return report;
    }

    const ids = all.filter(t => doomed.has(String(t._id)));
    const now = new Date();

    await db.collection(ARCHIVE).insertMany(
        ids.map(doc => ({
            migration: MIGRATION,
            sourceCollection: TASK_CALENDAR,
            ownerId: doc.userId,
            reason: doomed.get(String(doc._id)),
            archivedAt: now,
            doc,
        })),
        { ordered: false }
    );

    const res = await col.deleteMany({ _id: { $in: ids.map(d => d._id) } });
    step(`archived and removed ${res.deletedCount} rows ` +
         `(${report.duplicatesRemoved.length} duplicates, ${report.routineBlocksRemoved.length} routine blocks)`);
    if (report.closedDuplicatesLeft.length) {
        step(`left alone: ${report.closedDuplicatesLeft.length} duplicate title(s) among closed tasks`);
    }
    step("the partial unique index userId_1_title_1_pending can now build — it does on the next boot");

    report.status = "applied";
    report.removed = res.deletedCount;
    report.restoreHint =
        `Every removed row is in "${ARCHIVE}" under migration "${MIGRATION}", with the reason it went. ` +
        `Restoring is an insert back into ${TASK_CALENDAR}.`;
    return report;
}
