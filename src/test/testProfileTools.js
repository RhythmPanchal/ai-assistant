/**
 * Hand-run:  node src/test/testProfileTools.js
 *
 * These tools edit the half of a profile the SYSTEM acts on. A wrong timezone
 * stops every routine firing at the right hour and reports nothing; a wrong
 * currency mislabels every amount already logged. So the validation is the
 * substance here, not a formality — and it is pure, so it is tested directly.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects: every case below is rejected before the first database call.
 */
import "dotenv/config";
import assert from "node:assert";

const { updateUserSettings, validateSettings, EDITABLE_SETTINGS } = await import("../tools/mongo/operation/userSettings.js");
const { forgetFacts } = await import("../tools/mongo/operation/userFacts.js");
const toolRegistry = (await import("../agent/tools/definitions/index.js")).default;
const profileTools = await import("../agent/tools/definitions/ProfileTools.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);

// The pure validator. updateUserSettings wraps it and then writes; everything
// worth asserting here happens before that write.
const settings = (s) => validateSettings(s);

test("a bogus timezone is rejected, not stored", async () => {
    const r = settings({ timezone: "IST" });
    assert.deepStrictEqual(r.applied, {}, "nothing may be applied when the only field is invalid");
    assert.match(r.rejected[0].reason, /not an IANA timezone/);
    assert.match(r.rejected[0].reason, /Asia\/Kolkata/, "the reason must show a usable example");
});

test("ambiguous abbreviations are rejected even though Intl accepts them", () => {
    // Intl.DateTimeFormat resolves all of these without complaint, so a plain
    // try/catch validator passed them. IST alone means India, Ireland or Israel
    // depending on the ICU build — a routine would fire hours off and nothing
    // would report it.
    for (const abbr of ["IST", "PST", "EST", "GMT", "CET"]) {
        const r = settings({ timezone: abbr });
        assert.deepStrictEqual(r.applied, {}, `${abbr} must not be stored as a timezone`);
        assert.match(r.rejected[0].reason, /ambiguous/i);
    }
});

test("real IANA zones pass", async () => {
    for (const tz of ["Asia/Kolkata", "America/Toronto", "Europe/London", "UTC"]) {
        const r = settings({ timezone: tz });
        assert.strictEqual(r.applied.timezone, tz, `${tz} should be accepted`);
    }
});

test("currency is normalised to an ISO code", async () => {
    assert.strictEqual(settings({ currency: "inr" }).applied.currency, "INR");
    const bad = settings({ currency: "rupees" });
    assert.deepStrictEqual(bad.applied, {});
    assert.match(bad.rejected[0].reason, /ISO 4217/);
});

test("routine hours must be a real hour of the day", async () => {
    assert.strictEqual(settings({ morningHour: 0 }).applied.morningHour, 0, "midnight is valid");
    assert.strictEqual(settings({ nightHour: 23 }).applied.nightHour, 23);
    for (const bad of [24, -1, 9.5, "nine"]) {
        const r = settings({ morningHour: bad });
        assert.deepStrictEqual(r.applied, {}, `${bad} must be rejected`);
    }
});

test("hours are written under preferences, not the top level", async () => {
    const src = (await import("node:fs")).readFileSync("src/tools/mongo/operation/userSettings.js", "utf8");
    assert.match(src, /`preferences\.\$\{field\}`/,
        "initCron reads preferences.morningHour — a top-level write would never be seen");
});

test("a partial update leaves untouched fields alone", async () => {
    const r = settings({ timezone: "Asia/Kolkata" });
    assert.deepStrictEqual(Object.keys(r.applied), ["timezone"],
        "the model must be able to set what it learned without restating what it did not");
});

test("unknown fields are refused and the editable set is named", async () => {
    const r = settings({ apiKeys: { gemini: "leak" }, userId: 99 });
    assert.deepStrictEqual(r.applied, {});
    assert.strictEqual(r.rejected.length, 2, "both unknown fields must be reported");
    assert.match(r.rejected[0].reason, /editable/);
    assert.ok(!EDITABLE_SETTINGS.includes("apiKeys"), "provider keys must not be model-writable");
    assert.ok(!EDITABLE_SETTINGS.includes("userId"), "identity must not be model-writable");
});

test("a non-integer userId is refused before any write", async () => {
    await assert.rejects(() => updateUserSettings("1", { timezone: "UTC" }), /integer/);
    await assert.rejects(() => forgetFacts("1", ["work.status"]), /integer/);
});

test("forgetting nothing is a no-op, not a connection", async () => {
    assert.deepStrictEqual(await forgetFacts(1, []), { removed: [], missing: [] });
});

test("only the read tool is advertised; the editors are skill-loaded", () => {
    assert.ok(toolRegistry.isDeclared("fetchUserContext"), "reading a profile must always be possible");

    for (const gated of ["updateUserSettings", "forgetFact", "manageFactKey"]) {
        // Registered so the skill can run them, undeclared so a normal turn
        // neither sees them nor pays for their declarations.
        assert.ok(toolRegistry.getTool(gated), `${gated} must be executable once the skill loads it`);
        assert.strictEqual(toolRegistry.isDeclared(gated), false,
            `${gated} belongs to the enrichment skill, not every request`);
    }
});

test("all four tools exist and declare correctly", () => {
    const classes = ["FetchUserContextTool", "UpdateUserSettingsTool", "ForgetFactTool", "ManageFactKeyTool"];
    for (const name of classes) {
        assert.ok(profileTools[name], `${name} must be exported for the skill to load it`);
        const d = new profileTools[name]().toFunctionDeclaration();
        assert.ok(d.name && d.description, `${name} needs a wire name and description`);
        // Scoping is no longer a declared parameter — the registry injects it
        // from the bound context, so no tool may advertise one.
        assert.ok(!("userId" in (d.parameters.properties ?? {})),
            `${d.name} must not let the model choose whose profile it edits`);
    }
});

test("forgetFact steers changed facts back to rememberFact", () => {
    const d = new profileTools.ForgetFactTool().toFunctionDeclaration();
    assert.match(d.description, /rememberFact/,
        "deleting a fact that merely changed throws away previousValue");
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
