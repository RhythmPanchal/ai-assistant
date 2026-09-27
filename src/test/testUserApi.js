/**
 * Hand-run:  node src/test/testUserApi.js
 *
 * Guards the dashboard's front door. Sessions are signed tokens, not rows, so
 * the signature IS the whole of the auth — a forged, tampered, expired or
 * repurposed token must be refused before anything reads the database. Pure:
 * every request here is rejected above the data layer, so no .env and no Mongo.
 */
import express from "express";

process.env.MONGO_DB_URI = process.env.MONGO_DB_URI || "mongodb://127.0.0.1:27017";
process.env.SESSION_SECRET = "test-secret-not-a-real-one";
process.env.APP_UI_ORIGIN = "https://rasmalai-ui.pages.dev";

let passed = 0;
const failures = [];

function ok(name, condition, detail = "") {
    if (condition) passed++;
    else failures.push(`${name}${detail ? `\n     ${detail}` : ""}`);
}

const module_ = await import("../userRestAPI.js");
const userRouter = module_.default;
const { mintToken, readToken, createLoginLink, dashboardOrigin } = module_;

const app = express();
app.use(express.json());
app.use(userRouter);

const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = (path, init = {}) => fetch(`${base}${path}`, init);
const asUser = (token) => ({ authorization: `Bearer ${token}` });

const HOUR = 3600000;

// ----------------------------------------------------------- token itself ---

const session = mintToken("session", 7, 0, HOUR);

ok("a freshly minted session verifies", readToken(session, "session")?.userId === 7);
ok("it carries the epoch it was minted at", readToken(session, "session")?.epoch === 0);

ok("a login token is not a session token",
    readToken(mintToken("login", 7, 0, HOUR), "session") === null);
ok("a session token is not a login code",
    readToken(session, "login") === null);

ok("an expired token is refused", readToken(mintToken("session", 7, 0, -1000), "session") === null);

const [body, signature] = [session.slice(0, session.lastIndexOf(".")), session.slice(session.lastIndexOf(".") + 1)];
ok("a tampered signature is refused", readToken(`${body}.${signature.slice(0, -1)}x`, "session") === null);
ok("a tampered payload is refused", readToken(`${body}x.${signature}`, "session") === null);
ok("a token signed with another secret is refused", readToken(`${body}.${"a".repeat(43)}`, "session") === null);

ok("garbage is refused, not thrown on", readToken("not-a-token", "session") === null);
ok("a missing token is refused", readToken(undefined, "session") === null);

// The epoch is what makes a stateless session revocable: logout bumps the
// number on the user, and every token minted before it stops verifying.
ok("a token from an older epoch is still readable but reports its epoch",
    readToken(mintToken("session", 7, 3, HOUR), "session")?.epoch === 3);

// ------------------------------------------------------------ the link ------

const link = createLoginLink(7);
ok("the login link points at the app origin",
    link.url.startsWith("https://rasmalai-ui.pages.dev/login#"),
    link.url);
ok("its code is a login token", readToken(link.code, "login")?.userId === 7);
ok("the link says how long it lasts", link.minutes === 10, String(link.minutes));

/*
 * A link is only a link to Telegram if it carries a scheme: renderMarkdown
 * only promotes https?, tg: and mailto:, and shows anything else as its own
 * text. With APP_UI_ORIGIN unset the URL came out as "/login#…", which the
 * renderer correctly refused, and the user was sent raw markdown. Refusing to
 * build one at all is the only honest answer.
 */
ok("the link carries a scheme, or Telegram renders it as text",
    /^https?:\/\//.test(link.url), link.url);

const savedOrigin = process.env.APP_UI_ORIGIN;

delete process.env.APP_UI_ORIGIN;
ok("with no APP_UI_ORIGIN there is no origin to use", dashboardOrigin() === null);
let threw = false;
try { createLoginLink(7); } catch { threw = true; }
ok("and a link is refused rather than built relative", threw);

process.env.APP_UI_ORIGIN = "rasmalai-ui.pages.dev";
ok("an origin without a scheme is refused too", dashboardOrigin() === null);
threw = false;
try { createLoginLink(7); } catch { threw = true; }
ok("so that one is refused as well", threw);

process.env.APP_UI_ORIGIN = "https://rasmalai-ui.pages.dev/";
ok("a trailing slash is trimmed rather than doubled",
    createLoginLink(7).url.startsWith("https://rasmalai-ui.pages.dev/login#"));

process.env.APP_UI_ORIGIN = "https://a.example.com, https://b.example.com";
ok("with several origins the link uses the first",
    createLoginLink(7).url.startsWith("https://a.example.com/login#"));

process.env.APP_UI_ORIGIN = savedOrigin;

// ------------------------------------------------------------- the routes ---

let res = await call("/api/me");
ok("no token is 401", res.status === 401, `got ${res.status}`);

res = await call("/api/me", { headers: asUser("garbage") });
ok("a garbage token is 401", res.status === 401, `got ${res.status}`);

res = await call("/api/me", { headers: asUser(mintToken("session", 7, 0, -1000)) });
ok("an expired token is 401", res.status === 401, `got ${res.status}`);

res = await call("/api/me", { headers: asUser(mintToken("login", 7, 0, HOUR)) });
ok("a login token cannot open the dashboard", res.status === 401, `got ${res.status}`);

res = await call("/api/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: session }),
});
ok("a session token cannot be replayed as a login code", res.status === 401, `got ${res.status}`);

res = await call("/api/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
});
ok("an exchange with no code is 401", res.status === 401, `got ${res.status}`);

res = await call("/api/me", { headers: { cookie: "rasmalai_session=garbage" } });
ok("a garbage cookie is 401 like a garbage header", res.status === 401, `got ${res.status}`);

// ----------------------------------------------------- disabled by default ---

delete process.env.SESSION_SECRET;

res = await call("/api/me");
ok("with no SESSION_SECRET the dashboard is off, not open", res.status === 503, `got ${res.status}`);

res = await call("/api/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: session }),
});
ok("and no link can be exchanged", res.status === 503, `got ${res.status}`);

process.env.SESSION_SECRET = "test-secret-not-a-real-one";

// ------------------------------------------------------------------ cors ----

res = await call("/api/me", { headers: { origin: "https://rasmalai-ui.pages.dev" } });
ok("the app origin is allowed",
    res.headers.get("access-control-allow-origin") === "https://rasmalai-ui.pages.dev",
    String(res.headers.get("access-control-allow-origin")));
ok("credentials are allowed, or a cookie session cannot work",
    res.headers.get("access-control-allow-credentials") === "true");

res = await call("/api/me", { headers: { origin: "https://evil.example.com" } });
ok("an outside origin gets no allow header",
    res.headers.get("access-control-allow-origin") === null,
    String(res.headers.get("access-control-allow-origin")));

res = await call("/api/me", { method: "OPTIONS", headers: { origin: "https://evil.example.com" } });
ok("an outside preflight is refused", res.status === 403, `got ${res.status}`);

res = await call("/api/me", { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
ok("the local dev origin preflights fine", res.status === 204, `got ${res.status}`);

// ------------------------------------------------------------------ report --

server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.error("\nFAILURES:\n");
    failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}\n`));
    process.exit(1);
}
console.log("Dashboard front door holds.\n");
