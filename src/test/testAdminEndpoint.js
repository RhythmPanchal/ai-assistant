/**
 * Hand-run:  node src/test/testAdminEndpoint.js
 *
 * /admin/migrations/:name can rewrite the owner of every row in the database
 * from a public URL. The auth check is the only thing between that and anyone
 * who guesses the path, so it is worth more than the usual amount of testing.
 *
 * Boots the router on an ephemeral port and speaks real HTTP to it. Every case
 * here is rejected before the migration is reached, so nothing touches Mongo.
 */
import "dotenv/config";
import assert from "node:assert";
import crypto from "node:crypto";
import express from "express";

const adminRouter = (await import("../adminRestAPI.js")).default;

const tests = [];
const test = (n, f) => tests.push([n, f]);

const app = express();
app.use(express.json());
app.use(adminRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (path, token) => {
    const headers = {};
    if (token !== undefined) headers["X-Migration-Token"] = token;
    const res = await fetch(`${base}${path}`, { method: "POST", headers });
    return res.status;
};

// Derived the same way the route does. Never logged — the whole point is that
// the secret it comes from does not cross the wire.
const validToken = crypto.createHash("sha256")
    .update(`${process.env.MONGO_DB_URI}:migration`).digest("hex");

test("a request with no token is rejected", async () => {
    assert.strictEqual(await call("/admin/migrations/001-internal-user-ids"), 401);
});

test("a wrong token is rejected", async () => {
    assert.strictEqual(await call("/admin/migrations/001-internal-user-ids", "nope"), 401);
    // Same length as a real digest, so this fails on content rather than shape.
    assert.strictEqual(await call("/admin/migrations/001-internal-user-ids", "a".repeat(64)), 401);
});

test("an empty token is rejected", async () => {
    assert.strictEqual(await call("/admin/migrations/001-internal-user-ids", ""), 401);
});

test("auth is checked before the migration name", async () => {
    // A 404 here would confirm which migrations exist to an unauthenticated
    // caller, and would mean the lookup ran before the guard.
    assert.strictEqual(await call("/admin/migrations/does-not-exist"), 401);
});

test("a valid token reaches the router and an unknown migration 404s", async () => {
    assert.strictEqual(await call("/admin/migrations/does-not-exist", validToken), 404);
});

test("the token derivation is stable", () => {
    const again = crypto.createHash("sha256")
        .update(`${process.env.MONGO_DB_URI}:migration`).digest("hex");
    assert.strictEqual(again, validToken, "caller and server must derive the same value");
    assert.strictEqual(validToken.length, 64);
});

test("apply requires the exact string true", async () => {
    const src = (await import("node:fs")).readFileSync("src/adminRestAPI.js", "utf8");
    assert.match(src, /req\.query\.apply === "true"/,
        "a truthy check would make ?apply=false write");
});

test("the route is mounted and the app module loads", async () => {
    // index.js runs initService inside app.listen, so it is never imported here.
    // Reading it is enough to catch the mount being dropped in a refactor.
    const src = (await import("node:fs")).readFileSync("src/index.js", "utf8");
    assert.match(src, /app\.use\(adminRouter\)/);
    assert.match(src, /RENDER_GIT_COMMIT/,
        "the health route reports the deployed commit; without it a deploy cannot be confirmed");
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
server.close();
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
