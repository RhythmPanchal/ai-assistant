/**
 * Hand-run:  node src/test/testIdentityLayer.js
 *
 * Guards the identity/address split. userId became an internal id that is NOT a
 * Telegram chat id, and five call sites used to rely on them being the same
 * number. Every failure here is silent in production: the message is sent, the
 * API accepts it, and it arrives nowhere.
 *
 * Needs .env for MONGO_DB_URI (mongoClient builds its client at import) but
 * never connects, so nothing here touches the database.
 */
import "dotenv/config";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const tests = [];
const test = (n, f) => tests.push([n, f]);
const read = (p) => readFileSync(p, "utf8");

test("identity is keyed on (channel, externalId) and unique", async () => {
    const { USER_IDENTITY_INDEXES } = await import("../tools/mongo/schema/userIdentitySchema.js");
    const idx = USER_IDENTITY_INDEXES.find(i => i.name === "channel_1_externalId_1");
    assert.ok(idx, "the identity lookup index must exist");
    assert.strictEqual(idx.unique, true,
        "without unique, two concurrent first messages mint two userIds for one person");
});

test("externalId is a string, not an int", async () => {
    const schema = (await import("../tools/mongo/schema/userIdentitySchema.js")).default;
    assert.strictEqual(schema.properties.externalId.bsonType, "string",
        "Discord snowflakes exceed int64 — an int column cannot hold every channel");
    assert.ok(schema.properties.address, "address must exist separately from externalId");
});

test("sendToUser is dispatchable and its param order matches the signature", async () => {
    const { ACTION_MAP } = await import("../scheduler/actionDispatcher.js");
    const entry = ACTION_MAP.sendToUser;
    assert.ok(entry, "sendToUser must be in ACTION_MAP or triggerJob rows throw Unknown actionType");

    // dispatchAction spreads payload values positionally in params order, so a
    // mismatch here sends the text as the userId. §6 calls this out by name.
    const declared = entry.fn.toString()
        .match(/^\s*(?:async\s+)?function\s*\w*\s*\(([^)]*)\)/)[1]
        .split(",").map(s => s.trim().split(/[\s=]/)[0]).filter(Boolean);
    assert.deepStrictEqual(entry.params, declared,
        `ACTION_MAP params ${JSON.stringify(entry.params)} != signature ${JSON.stringify(declared)}`);
});

test("the address-based sendMessage survives for pre-migration job rows", async () => {
    const { ACTION_MAP } = await import("../scheduler/actionDispatcher.js");
    assert.ok(ACTION_MAP.sendMessage, "existing triggerJob rows still carry actionType sendMessage");
    assert.deepStrictEqual(ACTION_MAP.sendMessage.params, ["chatId", "text"]);
});

test("every outbound site resolves an address instead of using userId", () => {
    const sites = [
        "src/scheduler/jobs/goodMorningJob.js",
        "src/scheduler/jobs/goodNightJob.js",
        "src/tools/telegram/connectorPromptButton.js",
        "src/connectors/oauth/callbackHandler.js",
        "src/tools/telegram/sendToUser.js",
    ];
    for (const site of sites) {
        assert.match(read(site), /resolveAddress/,
            `${site} sends to a user and must resolve an address first`);
    }
});

test("no send site passes userId straight to sendMessage", () => {
    for (const site of ["src/scheduler/jobs/goodMorningJob.js", "src/scheduler/jobs/goodNightJob.js"]) {
        assert.doesNotMatch(read(site), /sendMessage\(\s*userId\b/,
            `${site} would deliver to a chat id that does not exist`);
    }
    assert.doesNotMatch(read("src/tools/telegram/connectorPromptButton.js"), /chat_id:\s*userId\b/,
        "connectorButton would post the Connect button to a nonexistent chat");
});

test("reminders no longer bake in the original user's chat id", () => {
    const src = read("src/scheduler/createReminders.js");
    assert.doesNotMatch(src, /chatId\s*:\s*1136575387/,
        "every user's reminders would be delivered to the original user");
    assert.match(src, /actionType:\s*"sendToUser"/,
        "new reminders must resolve the address at fire time, not at creation");
});

test("inbound resolution keys on the sender, not the chat", () => {
    const src = read("src/tools/telegram/telegramHandler.js");
    assert.match(src, /resolveUserByChannel\("telegram",\s*externalId/);
    assert.match(src, /message\.from\?\.id/,
        "keying on chat.id merges every member of a group into one user");
    assert.match(src, /runAgent\(userId,/, "runAgent takes the identity, not the address");
});

test("the migration never rewrites triggerJob payload addresses", () => {
    const src = read("src/tools/mongo/migrations/001-internal-user-ids.js");
    assert.doesNotMatch(src, /payload\.chatId["']?\s*:/,
        "payload.chatId is an address — rewriting it breaks every existing reminder");
    assert.match(src, /--apply/, "the migration must be dry-run by default");
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
