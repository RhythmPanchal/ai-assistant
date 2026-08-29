/**
 * Hand-run:  node src/test/testConnectionHealth.js
 *
 * Covers the INACTIVE downgrade: what counts as a dead grant, and that the
 * schedule sync actually prompts once a connection reaches that state. Needs
 * .env for MONGO_DB_URI (mongoClient builds its client at import) but never
 * connects, so nothing here touches the database.
 *
 * Written after Google Calendar stopped syncing on 2026-08-16 and nothing
 * noticed for two weeks: the refresh failed with invalid_grant every day while
 * the connection row still read ACTIVE, so no code path ever asked the user to
 * reconnect.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("invalid_grant is the one body that kills a connection", async () => {
    const { isDeadGrant } = await import("../connectors/oauth/getAccessToken.js");

    // The exact body Google returned for this connection on 2026-08-30.
    assert.strictEqual(
        isDeadGrant('{\n  "error": "invalid_grant",\n  "error_description": "Bad Request"\n}'),
        true,
        "the real Google response must be recognised"
    );
    assert.strictEqual(isDeadGrant('{"error":"invalid_grant"}'), true);
});

test("failures that re-authorising would not fix are left transient", async () => {
    const { isDeadGrant } = await import("../connectors/oauth/getAccessToken.js");

    // Our client credentials, not the user's grant. Sending them through the
    // connect flow again would fail identically and lose a working refresh token.
    assert.strictEqual(isDeadGrant('{"error":"invalid_client"}'), false);
    assert.strictEqual(isDeadGrant('{"error":"unauthorized_client"}'), false);
    // A 5xx or a proxy in the way. Never JSON, and never a reason to disconnect.
    assert.strictEqual(isDeadGrant("<html><head><title>502</title></head></html>"), false);
    assert.strictEqual(isDeadGrant(""), false);
    assert.strictEqual(isDeadGrant("null"), false);
    assert.strictEqual(isDeadGrant("{}"), false);
});

test("INACTIVE is a status the schema already allows", async () => {
    const mod = await import("../tools/mongo/schema/connectionSchema.js");
    const statuses = mod.default.properties.status.enum;

    assert.ok(statuses.includes("INACTIVE"), "getAccessToken now writes INACTIVE");
    // DISABLED means the user said no and must not be asked again. Collapsing
    // the two would silently opt people out of a connection they still want.
    assert.ok(statuses.includes("DISABLED"));
    assert.notStrictEqual("INACTIVE", "DISABLED");
});

test("the schedule sync prompts on INACTIVE and still stays quiet on DISABLED", () => {
    // Source-level, because syncScheduleToCalendar is module-private and the
    // behaviour worth pinning is which statuses reach the connect button.
    const src = readFileSync(new URL("../tools/mongo/operation/insertSchedule.js", import.meta.url), "utf8");

    assert.ok(
        /status === "INACTIVE"/.test(src),
        "INACTIVE must reach the connect button, or the downgrade just goes silent"
    );
    assert.ok(
        /status === "DISABLED"/.test(src),
        "DISABLED must still return early"
    );
    assert.ok(
        /GCALENDAR_RECONNECT_TEXT/.test(src),
        "a reconnect needs its own copy — the first-time text reads as though nothing was ever set up"
    );
});

test("a sync that dies mid-flight asks again immediately, not tomorrow", () => {
    const src = readFileSync(new URL("../tools/mongo/operation/insertSchedule.js", import.meta.url), "utf8");

    // The row is ACTIVE when the sync starts and INACTIVE by the time it fails.
    // Schedules are written about once a day, so leaving the prompt to the next
    // call costs another silent day.
    assert.ok(/catch \(err\)/.test(src), "the ACTIVE branch must catch its own failure");
    assert.ok(
        /after\?\.status !== "INACTIVE"\) throw err/.test(src),
        "anything that is not a dead grant must keep propagating"
    );
});

test("getAccessToken only ever hands back a token from an ACTIVE row", async () => {
    const src = readFileSync(new URL("../connectors/oauth/getAccessToken.js", import.meta.url), "utf8");

    // The lookup filters on status, so an INACTIVE row throws "no active
    // connection" instead of retrying a grant Google has already refused.
    assert.ok(/findOne\(\{ userId, appName, status: "ACTIVE" \}\)/.test(src));
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
