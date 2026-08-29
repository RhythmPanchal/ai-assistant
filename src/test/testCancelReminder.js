/**
 * Hand-run:  node src/test/testCancelReminder.js
 *
 * Covers the cancelReminder wiring and its two refusal boundaries. Needs .env
 * for MONGO_DB_URI (mongoClient builds its client at import) but never connects
 * — every case here is settled before the function reaches the database.
 *
 * Exists because until now nothing could stop a reminder: the two
 * "[object Object]" rows firing nightly from 2026-08-18 had to be deleted by
 * hand against production.
 */
import "dotenv/config";
import assert from "node:assert";

const tests = [];
const test = (n, f) => tests.push([n, f]);

const VALID_ID = "6a8363f046a2e8130aa344f4"; // the real 9pm row's _id

test("routines in the same collection are not cancellable", async () => {
    const { isCancellableAction } = await import("../scheduler/cancelReminder.js");

    // The whole point of the guard. triggerJob holds reminders AND the daily
    // routines, and "cancel my morning reminder" is a natural way to name
    // either — so an unguarded cancel could switch off good-morning for good.
    assert.strictEqual(isCancellableAction("goodMorningJob"), false);
    assert.strictEqual(isCancellableAction("goodNightJob"), false);
    assert.strictEqual(isCancellableAction(undefined), false);
    assert.strictEqual(isCancellableAction("runAgent"), false);
});

test("both reminder action types are cancellable", async () => {
    const { isCancellableAction } = await import("../scheduler/cancelReminder.js");

    assert.strictEqual(isCancellableAction("sendToUser"), true, "what new reminders use");
    // Pre-identity-split rows with a baked-in chatId — the old reminders most
    // likely to be the ones someone wants stopped.
    assert.strictEqual(isCancellableAction("sendMessage"), true);
});

test("a fabricated _id is refused with the fix in the message", async () => {
    const { cancelReminder } = await import("../scheduler/cancelReminder.js");

    // The model's known failure mode is inventing plausible ids. It must be
    // told to go and fetch a real one, not just that this one was wrong.
    for (const bad of ["the masi one", "123", "", "6a8363f046a2e8130aa344f"]) {
        await assert.rejects(
            () => cancelReminder(bad, 1, "test"),
            /not a 24-character hex _id[\s\S]*fetchRecord/,
            `"${bad}" must be refused`
        );
    }
});

test("cancelling without an identity is refused", async () => {
    const { cancelReminder } = await import("../scheduler/cancelReminder.js");

    // userId comes from the request context, never the model. Missing means the
    // entry point failed to bind it, and cancelling unscoped would reach any row.
    await assert.rejects(() => cancelReminder(VALID_ID, undefined, "test"), /userId is required/);
    await assert.rejects(() => cancelReminder(VALID_ID, null, "test"), /userId is required/);
});

test("the dispatcher passes arguments in the order the function declares them", async () => {
    const { ACTION_MAP } = await import("../scheduler/actionDispatcher.js");
    const entry = ACTION_MAP.cancelReminder;

    assert.ok(entry, "cancelReminder must be dispatchable");
    // dispatchAction spreads payload values positionally, so a params list in
    // the wrong order silently passes the reason as the userId.
    assert.deepStrictEqual(entry.params, ["id", "userId", "reason"]);

    const signature = entry.fn.toString().slice(0, 120);
    assert.ok(
        /cancelReminder\s*\(\s*id\s*,\s*userId\s*,\s*reason\s*\)/.test(signature),
        `params must match the signature, which reads: ${signature}`
    );
});

test("the declaration asks for an id and a reason, and never for userId", async () => {
    const registry = (await import("../agent/tools/definitions/index.js")).default;
    const decl = registry.getToolDeclarations().find(d => d.name === "cancelReminder");

    assert.ok(decl, "cancelReminder must be declared to the model");
    assert.deepStrictEqual(decl.parameters.required, ["id", "reason"]);
    assert.ok(
        !("userId" in decl.parameters.properties),
        "identity is bound from context; exposing it invites the model to name someone else's"
    );
    // The identification contract lives in the description — it is the only
    // thing telling the model to fetch first and to ask when the reference is
    // ambiguous rather than picking a reminder for the user.
    assert.match(decl.description, /fetchRecord/);
    assert.match(decl.description, /ask which one/);
});

let passed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`FAIL  ${name}\n      ${err.message}`);
    }
}
console.log(`\n${passed}/${tests.length} passed`);
process.exit(passed === tests.length ? 0 : 1);
