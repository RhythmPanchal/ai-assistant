/**
 * Hand-run:  node src/test/testUserContext.js
 *
 * The context replaces a userId the LLM used to supply from its own prompt. Two
 * properties carry that weight, and neither is obvious by reading the code:
 *
 *   1. concurrent turns never see each other's identity, and
 *   2. an unbound context fails loudly rather than silently reading unscoped.
 *
 * Pure — no database, no network.
 */
import assert from "node:assert";
import {
    UserContext, SYSTEM_USER_ID, runWithUserContext, runAsSystem,
    getUserContext, peekUserContext, currentUserId, isSystemContext,
} from "../identity/userContext.js";

const tests = [];
const test = (n, f) => tests.push([n, f]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test("an unbound context throws instead of returning nothing", () => {
    // The whole safety property. Returning undefined would let a caller fall
    // through to an unscoped query that looks like a perfectly good result.
    assert.throws(() => getUserContext(), /no user context bound/);
    assert.throws(() => currentUserId(), /no user context bound/);
    assert.strictEqual(peekUserContext(), null, "peek is the only one allowed to be quiet");
});

test("a bound context is visible to everything it awaits", async () => {
    await runWithUserContext({ userId: 7, channel: "telegram", address: "999" }, async () => {
        await sleep(3);
        const nested = await (async () => { await sleep(3); return currentUserId(); })();
        assert.strictEqual(nested, 7, "the store must survive nesting and awaits");
        assert.strictEqual(getUserContext().address, "999");
    });
});

test("two concurrent turns never see each other's identity", async () => {
    // The reason this is AsyncLocalStorage and not a module-level variable.
    // Both turns run the SAME parameterless function, interleaved on one thread.
    const seen = { a: [], b: [] };

    async function toolReadingAmbientIdentity(bucket) {
        await sleep(4);                 // suspend — the other turn runs here
        seen[bucket].push(currentUserId());
        await sleep(4);
        seen[bucket].push(currentUserId());
    }

    const turn = (userId, bucket, stagger) =>
        runWithUserContext({ userId, channel: "telegram" }, async () => {
            await sleep(stagger);
            await toolReadingAmbientIdentity(bucket);
            // The agent runs independent tool calls through Promise.all.
            await Promise.all([
                toolReadingAmbientIdentity(bucket),
                toolReadingAmbientIdentity(bucket),
            ]);
            return currentUserId();
        });

    const [a, b] = await Promise.all([turn(1, "a", 6), turn(2, "b", 2)]);

    assert.strictEqual(a, 1);
    assert.strictEqual(b, 2);
    assert.deepStrictEqual([...new Set(seen.a)], [1], `turn A leaked: saw ${seen.a}`);
    assert.deepStrictEqual([...new Set(seen.b)], [2], `turn B leaked: saw ${seen.b}`);
    assert.ok(seen.a.length >= 6 && seen.b.length >= 6, "both turns must actually have run");
});

test("a context cannot be edited after it is bound", async () => {
    await runWithUserContext({ userId: 3, channel: "telegram" }, async () => {
        const ctx = getUserContext();
        assert.throws(() => { ctx.userId = 99; }, TypeError,
            "a mutable context would reintroduce exactly the escalation this prevents");
        assert.strictEqual(currentUserId(), 3);
    });
});

test("construction refuses anything that is not a real identity", () => {
    assert.throws(() => new UserContext({ userId: "1", channel: "telegram" }), /integer/);
    assert.throws(() => new UserContext({ userId: 1.5, channel: "telegram" }), /integer/);
    assert.throws(() => new UserContext({ userId: undefined, channel: "telegram" }), /integer/);
    assert.throws(() => new UserContext({ userId: 1 }), /channel is required/);
});

test("system context is exempt, and negative so it cannot collide", async () => {
    assert.strictEqual(SYSTEM_USER_ID, -1);
    assert.ok(SYSTEM_USER_ID < 0, "the counter allocates from 1 upward; a positive id could collide");

    await runAsSystem("boot seed", async () => {
        assert.strictEqual(currentUserId(), SYSTEM_USER_ID);
        assert.strictEqual(isSystemContext(), true);
        assert.strictEqual(getUserContext().channel, "system");
        assert.match(getUserContext().toString(), /boot seed/, "the reason must reach the logs");
    });
});

test("a user context is never system", async () => {
    await runWithUserContext({ userId: 1, channel: "telegram" }, async () => {
        assert.strictEqual(isSystemContext(), false,
            "an ordinary turn must never be exempt from scoping");
    });
});

test("executionTime is stamped once, when the work began", async () => {
    const before = Date.now();
    await runWithUserContext({ userId: 1, channel: "telegram" }, async () => {
        await sleep(15);
        const stamped = getUserContext().executionTime.getTime();
        assert.ok(stamped >= before && stamped <= before + 10,
            "it marks the start of the turn, not the moment it is read");
    });
});

test("the binding does not outlive its scope", async () => {
    await runWithUserContext({ userId: 5, channel: "telegram" }, async () => currentUserId());
    assert.strictEqual(peekUserContext(), null,
        "a context leaking past its scope would attach to whatever ran next");
});

let pass = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
        pass++;
    } catch (e) {
        console.log(`FAIL  ${name}\n      ${e.message}`);
    }
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
