/**
 * Hand-run:  node src/test/testAdminApi.js
 *
 * Guards the admin console's front door — the token gate and the CORS rule.
 * Pure: the router is mounted on a bare Express app and every request here is
 * refused, validated or answered before it reaches Mongo, so this needs no .env
 * and no database.
 *
 * The case that matters is the first one. This router impersonates any user and
 * reads their whole history, and it rides on the same public origin as the
 * OAuth callbacks — so "ADMIN_API_TOKEN happened to be unset" must mean the
 * console is off, not that it is open. A default-open debug route on a
 * publicly reachable host is the failure this file exists to prevent.
 */
import express from "express";

// The router imports the Mongo client, which constructs its MongoClient at
// import time and rejects an undefined URI. Nothing here connects — every
// request below is answered before it reaches getDB — so a placeholder is
// enough, and using one keeps this guard runnable with no .env at all.
process.env.MONGO_DB_URI = process.env.MONGO_DB_URI || "mongodb://127.0.0.1:27017";

let passed = 0;
const failures = [];

function ok(name, condition, detail = "") {
    if (condition) passed++;
    else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

const adminRouter = (await import("../adminRestAPI.js")).default;

const app = express();
app.use(express.json());
app.use(adminRouter);

const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = (path, init = {}) => fetch(`${base}${path}`, init);

// ------------------------------------------------------- disabled by default --

delete process.env.ADMIN_API_TOKEN;

let res = await call("/admin/users");
ok("with no ADMIN_API_TOKEN the console is off, not open", res.status === 503, `got ${res.status}`);

res = await call("/admin/users", { headers: { "x-admin-token": "anything" } });
ok("and no token a caller invents turns it on", res.status === 503, `got ${res.status}`);

res = await call("/admin/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: 1, message: "hi" }),
});
ok("impersonation is refused while it is off", res.status === 503, `got ${res.status}`);

// ------------------------------------------------------------- the token gate --

process.env.ADMIN_API_TOKEN = "s3cret";

res = await call("/admin/health");
ok("a missing token is rejected", res.status === 401, `got ${res.status}`);

res = await call("/admin/health", { headers: { "x-admin-token": "wrong" } });
ok("a wrong token is rejected", res.status === 401, `got ${res.status}`);

res = await call("/admin/health", { headers: { "x-admin-token": "s3cret" } });
ok("the right token is let through", res.status === 200, `got ${res.status}`);

res = await call("/admin/health?token=s3cret");
ok("the query form works too, for pasting into a browser", res.status === 200, `got ${res.status}`);

// ------------------------------------------------------------ input validation --

const auth = { "x-admin-token": "s3cret", "content-type": "application/json" };

res = await call("/admin/chat", { method: "POST", headers: auth, body: JSON.stringify({ message: "hi" }) });
ok("a chat with no userId is a 400, not a guess", res.status === 400, `got ${res.status}`);

res = await call("/admin/chat", { method: "POST", headers: auth, body: JSON.stringify({ userId: "abc", message: "hi" }) });
ok("a non-numeric userId is refused", res.status === 400, `got ${res.status}`);

res = await call("/admin/chat", { method: "POST", headers: auth, body: JSON.stringify({ userId: 1, message: "   " }) });
ok("an empty message is refused before a turn is spent", res.status === 400, `got ${res.status}`);

res = await call("/admin/users/nope/days", { headers: auth });
ok("a non-numeric userId in the path is refused", res.status === 400, `got ${res.status}`);

res = await call("/admin/users/1/history?date=yesterday", { headers: auth });
ok("history demands a real YYYY-MM-DD", res.status === 400, `got ${res.status}`);

// ------------------------------------------------------------------------ CORS --

res = await call("/admin/health", { headers: { ...auth, origin: "http://localhost:5173" } });
ok("the local console origin is allowed",
    res.headers.get("access-control-allow-origin") === "http://localhost:5173",
    String(res.headers.get("access-control-allow-origin")));

res = await call("/admin/health", { headers: { ...auth, origin: "https://evil.example.com" } });
ok("an outside origin gets no allow header",
    res.headers.get("access-control-allow-origin") === null,
    String(res.headers.get("access-control-allow-origin")));

ok("the response varies by origin so no cache crosses them",
    (res.headers.get("vary") || "").includes("Origin"),
    String(res.headers.get("vary")));

res = await call("/admin/chat", { method: "OPTIONS", headers: { origin: "https://evil.example.com" } });
ok("an outside preflight is refused", res.status === 403, `got ${res.status}`);

res = await call("/admin/chat", { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
ok("the console's preflight passes without a token", res.status === 204, `got ${res.status}`);

// ------------------------------------------------------------------- report ----

server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES:\n");
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
}
console.log("Admin console front door holds.\n");
