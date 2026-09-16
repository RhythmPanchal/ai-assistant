/**
 * Hand-run:  node src/test/testDietLog.js
 *
 * addMeal / replaceMeal: the model supplies one meal, code owns the day's list
 * and its totals. The pure half needs nothing; the database half writes to
 * Rasmalai-eval under a throwaway userId and deletes what it made.
 *
 * The failures pinned here were all observed, not imagined — the first night
 * eval wiped lunch when dinner arrived, logged ₹50 three times, and left a
 * stored total of 380 over meals summing to 0.
 */
import "dotenv/config";
import assert from "node:assert";

process.env.MONGODB_DB_NAME = "Rasmalai-eval";

const { pickLogDate } = await import("../tools/mongo/operation/logDate.js");
const { normalizeMealItems, buildMeal, addMeal, replaceMeal } = await import("../tools/mongo/operation/dietLog.js");
const { getDB, ensureIndexes } = await import("../tools/mongo/mongoClient.js");
const { openFlow } = await import("../scheduler/flows/activeFlowsRepo.js");
const { localDateOf } = await import("../tools/mongo/dateUtils.js");

const USER = 900003;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------- pure: dates --
test("no date asked for → the day being logged", () => {
    assert.deepStrictEqual(pickLogDate({ today: "2026-09-17" }), { date: "2026-09-17", note: null });
    assert.strictEqual(pickLogDate({ flowLogDate: "2026-09-16", today: "2026-09-17" }).date, "2026-09-16");
});

test("after midnight, the clock's date is pulled back to the night's LOG DATE", () => {
    const r = pickLogDate({ requested: "2026-09-17", flowLogDate: "2026-09-16", today: "2026-09-17" });
    assert.strictEqual(r.date, "2026-09-16");
    assert.match(r.note, /LOG DATE/);
});

test("an earlier date is a person saying 'that was yesterday' — kept", () => {
    assert.strictEqual(pickLogDate({ requested: "2026-09-15", flowLogDate: "2026-09-16", today: "2026-09-17" }).date, "2026-09-15");
});

test("a future date outside a routine is pulled back to today", () => {
    assert.strictEqual(pickLogDate({ requested: "2026-12-01", today: "2026-09-17" }).date, "2026-09-17");
});

test("an unreadable date falls back, and says so", () => {
    const r = pickLogDate({ requested: "last tuesday", today: "2026-09-17" });
    assert.strictEqual(r.date, "2026-09-17");
    assert.match(r.note, /not a YYYY-MM-DD/);
});

test("a timestamp is read as its day", () => {
    assert.strictEqual(pickLogDate({ requested: "2026-09-16T21:30:00", flowLogDate: "2026-09-16", today: "2026-09-17" }).date, "2026-09-16");
});

// ------------------------------------------------------------- pure: items --
test("calories are rounded to integers, strings accepted", () => {
    const [i] = normalizeMealItems([{ name: " poha ", quantity: "1 plate", calories: "322.6", protein: 8.4 }]);
    assert.deepStrictEqual(i, { name: "poha", quantity: "1 plate", calories: 323, protein: 8 });
});

test("a missing calorie estimate is sent back, never stored as zero", () => {
    assert.throws(() => normalizeMealItems([{ name: "poha", quantity: "1" }]), /Estimate them/);
});

test("an empty meal is refused", () => {
    assert.throws(() => normalizeMealItems([]), /at least one/);
});

test("mealCalories is the sum of the items, computed here", () => {
    const m = buildMeal("Lunch", [{ name: "dal", quantity: "1", calories: 300 }, { name: "rice", quantity: "1", calories: 150 }]);
    assert.strictEqual(m.mealCalories, 450);
});

test("an unknown meal type is refused", () => {
    assert.throws(() => buildMeal("Brunch", [{ name: "x", quantity: "1", calories: 1 }]), /mealType/);
});

// -------------------------------------------------------------- database --
let db;
const day = async () => (await db.collection("dietRegister").find({ userId: USER }).toArray());
const food = (name, calories, extra = {}) => ({ name, quantity: "1 serving", calories, ...extra });
const cleanup = () => Promise.all(["dietRegister", "activeFlows"].map(c => db.collection(c).deleteMany({ userId: USER })));

test("the first meal creates the day", async () => {
    await addMeal(USER, { mealType: "Breakfast", items: [food("poha", 320, { protein: 8 })] });
    const docs = await day();
    assert.strictEqual(docs.length, 1);
    assert.deepStrictEqual(docs[0].dailyTotals, { caloriesConsumed: 320, protein: 8, carbs: 0, fat: 0 });
});

test("a later meal is APPENDED — breakfast survives lunch", async () => {
    await addMeal(USER, { mealType: "Lunch", items: [food("dal chawal", 450, { protein: 15 })] });
    const [doc] = await day();
    assert.deepStrictEqual(doc.meals.map(m => m.mealType), ["Breakfast", "Lunch"]);
    assert.strictEqual(doc.dailyTotals.caloriesConsumed, 770);
    assert.strictEqual(doc.dailyTotals.protein, 23);
});

test("three meals in parallel all land, on one document, with a correct total", async () => {
    await cleanup();
    await Promise.all([
        addMeal(USER, { mealType: "Breakfast", items: [food("paratha", 300)] }),
        addMeal(USER, { mealType: "Lunch", items: [food("dal", 400)] }),
        addMeal(USER, { mealType: "Dinner", items: [food("paneer", 500)] }),
    ]);
    const docs = await day();
    assert.strictEqual(docs.length, 1, `${docs.length} documents for one day`);
    assert.deepStrictEqual(docs[0].meals.map(m => m.mealType).sort(), ["Breakfast", "Dinner", "Lunch"]);
    assert.strictEqual(docs[0].dailyTotals.caloriesConsumed, 1200);
});

test("a correction replaces the meal instead of adding a second one", async () => {
    await replaceMeal(USER, { mealType: "Lunch", items: [food("rajma chawal", 520)] });
    const [doc] = await day();
    const lunches = doc.meals.filter(m => m.mealType === "Lunch");
    assert.strictEqual(lunches.length, 1);
    assert.strictEqual(lunches[0].items[0].name, "rajma chawal");
    assert.strictEqual(doc.dailyTotals.caloriesConsumed, 1320);
});

test("an empty items list removes the meal, and the total follows", async () => {
    const r = await replaceMeal(USER, { mealType: "Dinner", items: [] });
    assert.strictEqual(r.removed, true);
    const [doc] = await day();
    assert.ok(!doc.meals.some(m => m.mealType === "Dinner"));
    assert.strictEqual(doc.dailyTotals.caloriesConsumed, 820);
});

test("two snacks: replaceMeal refuses to guess which one", async () => {
    await addMeal(USER, { mealType: "Snack", items: [food("chips", 150)] });
    await addMeal(USER, { mealType: "Snack", items: [food("banana", 90)] });
    await assert.rejects(replaceMeal(USER, { mealType: "Snack", items: [] }), /2 Snack entries/);
    await replaceMeal(USER, { mealType: "Snack", items: [], occurrence: 1 });
    const [doc] = await day();
    assert.deepStrictEqual(doc.meals.filter(m => m.mealType === "Snack").map(m => m.items[0].name), ["banana"]);
});

test("correcting a meal that was never logged points at addMeal", async () => {
    await assert.rejects(replaceMeal(USER, { mealType: "Dinner", items: [food("x", 1)] }), /use addMeal/);
});

test("inside an open night routine, a meal sent with tomorrow's date files under LOG DATE", async () => {
    await cleanup();
    await openFlow({ userId: USER, flowType: "goodNight", ttlMinutes: 10 });
    const logDate = localDateOf(new Date());
    const tomorrow = new Date(new Date(`${logDate}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    const r = await addMeal(USER, { mealType: "Dinner", items: [food("biryani", 700)], date: tomorrow });
    assert.strictEqual(r.date, logDate);
    assert.match(r.note ?? "", /LOG DATE/);
});

let pass = 0;
try {
    db = await getDB();
    if (/prod/i.test(db.databaseName)) throw new Error(`refusing to write to ${db.databaseName}`);
    await ensureIndexes();
    await cleanup();
    for (const [name, fn] of tests) {
        try { await fn(); pass++; console.log(`PASS  ${name}`); }
        catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); }
    }
} finally {
    if (db) await cleanup();
}
console.log(`\n${pass}/${tests.length} passed`);
process.exit(pass === tests.length ? 0 : 1);
