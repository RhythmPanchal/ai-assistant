/**
 * One-time Notion dashboard setup — hand-run scratch script.
 *
 * WHAT THE NOTION API *CAN* AUTOMATE (this script does it):
 *   - "My life dashboard" home page
 *   - 4 sub-pages: Tasks, Days, Expenses, Diet  (+ navigation links on home)
 *   - 5 inline databases with chart-ready properties
 *   - A labelled placeholder everywhere a chart / linked-view should go,
 *     each carrying the exact chart spec you'll need.
 *
 * WHAT THE NOTION API *CANNOT* DO (you add these by hand afterwards):
 *   - Chart blocks            (type "/chart" in Notion)
 *   - Linked database views   (filtered "last 7 days" views)
 *
 * HOW TO RUN
 *   1. Export your Notion access token: NOTION_TOKEN=ntn_...
 *      Never inline it here — this repo is public.
 *   2. First run with NOTION_PARENT_PAGE_ID unset → it prints every page your
 *      token can see, with ids.
 *   3. Export the page id you want the dashboard built under:
 *      NOTION_PARENT_PAGE_ID=...
 *   4. Run again → it builds everything and prints the URLs.
 *
 *      NOTION_TOKEN=... NOTION_PARENT_PAGE_ID=... node src/connectors/notion/setupDashboard.js
 *
 * NOTES
 *   - Needs Node 18+ (uses global fetch).
 *   - Do NOT commit your token.
 *   - Running twice creates duplicates — it is not idempotent.
 */

const NOTION_TOKEN = process.env.NOTION_TOKEN;              // export NOTION_TOKEN=... before running
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;   // export NOTION_PARENT_PAGE_ID=... (see step 2)

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notion(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Notion ${method} ${path} → ${res.status}: ${json.message || JSON.stringify(json)}`
    );
  }
  await sleep(350); // stay under Notion's ~3 req/s limit
  return json;
}

// ── block builders ────────────────────────────────────────────────────────
const txt = (content) => [{ type: "text", text: { content } }];
const heading2 = (content) => ({ object: "block", type: "heading_2", heading_2: { rich_text: txt(content) } });
const heading3 = (content) => ({ object: "block", type: "heading_3", heading_3: { rich_text: txt(content) } });
const divider = () => ({ object: "block", type: "divider", divider: {} });
const callout = (content, emoji = "💡", color = "gray_background") => ({
  object: "block",
  type: "callout",
  callout: { rich_text: txt(content), icon: { type: "emoji", emoji }, color },
});
const linkToPage = (pageId) => ({
  object: "block",
  type: "link_to_page",
  link_to_page: { type: "page_id", page_id: pageId },
});

// ── property builders ───────────────────────────────────────────────────────
const select = (options) => ({ select: { options } });
const number = (format = "number") => ({ number: { format } });

// ── API helpers ─────────────────────────────────────────────────────────────
async function createPage(parentPageId, title, emoji) {
  return notion("/pages", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parentPageId },
      icon: emoji ? { type: "emoji", emoji } : undefined,
      properties: { title: { title: txt(title) } },
    },
  });
}

async function createInlineDatabase(parentPageId, title, emoji, properties) {
  return notion("/databases", {
    method: "POST",
    body: {
      parent: { type: "page_id", page_id: parentPageId },
      is_inline: true,
      icon: emoji ? { type: "emoji", emoji } : undefined,
      title: txt(title),
      properties,
    },
  });
}

async function appendBlocks(blockId, children) {
  if (!children.length) return;
  await notion(`/blocks/${blockId}/children`, { method: "PATCH", body: { children } });
}

function extractTitle(obj) {
  const props = obj.properties || {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p?.type === "title") {
      return (p.title || []).map((t) => t.plain_text).join("") || "(untitled)";
    }
  }
  return "(untitled)";
}

async function listAccessiblePages() {
  const res = await notion("/search", {
    method: "POST",
    body: { filter: { value: "page", property: "object" }, page_size: 50 },
  });
  return (res.results || []).map((r) => ({ id: r.id, title: extractTitle(r), url: r.url }));
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (typeof fetch !== "function") {
    console.error("✗ Global fetch not found. Run with Node 18+.");
    process.exit(1);
  }
  if (!NOTION_TOKEN) {
    console.error("✗ Set NOTION_TOKEN in the environment before running this script.");
    process.exit(1);
  }

  if (!PARENT_PAGE_ID) {
    console.log("No PARENT_PAGE_ID set. Pages your token can access:\n");
    const pages = await listAccessiblePages();
    if (!pages.length) {
      console.log("(none) — open Notion, share a page with your integration, then re-run.");
    } else {
      for (const p of pages) {
        console.log(`  • ${p.title}\n      id:  ${p.id}\n      url: ${p.url}`);
      }
    }
    console.log("\nExport one id as NOTION_PARENT_PAGE_ID, then run again.");
    return;
  }

  console.log("Building dashboard…\n");

  // 1. Home page
  const home = await createPage(PARENT_PAGE_ID, "My life dashboard", "🏠");
  console.log(`✓ Home page: ${home.url}`);

  // 2. Sub-pages
  const tasksPage = await createPage(home.id, "Tasks", "✅");
  const daysPage = await createPage(home.id, "Days", "📅");
  const expensesPage = await createPage(home.id, "Expenses", "💸");
  const dietPage = await createPage(home.id, "Diet", "🥗");
  console.log("✓ Sub-pages: Tasks, Days, Expenses, Diet");

  // 3a. Tasks — forward-looking to-do list (mirrors taskCalendar)
  await appendBlocks(tasksPage.id, [
    heading2("Tasks"),
    callout("Tip: open this database as a Board view grouped by Status to see Pending / Scheduled / Completed / Cancelled.", "ℹ️"),
  ]);
  await createInlineDatabase(tasksPage.id, "Tasks", "✅", {
    Name: { title: {} },
    Status: select([
      { name: "Pending", color: "yellow" },
      { name: "Scheduled", color: "blue" },
      { name: "Completed", color: "green" },
      { name: "Cancelled", color: "red" },
    ]),
    Urgency: select([
      { name: "Low", color: "gray" },
      { name: "Medium", color: "orange" },
      { name: "High", color: "red" },
    ]),
    Due: { date: {} },
    Notes: { rich_text: {} },
  });

  // 3b. Days — backward-looking journal + ratings (taskRegister + daySummary)
  await appendBlocks(daysPage.id, [heading2("Days — journal & ratings")]);
  await createInlineDatabase(daysPage.id, "Days", "📅", {
    Day: { title: {} },
    Date: { date: {} },
    Productivity: number(),
    Mood: number(),
    Overall: number(),
    "Tasks done": number(),
    Summary: { rich_text: {} },
  });
  await appendBlocks(daysPage.id, [
    callout("Add chart here → Monthly ratings: line chart, X = Date (group by month), Y = average of Productivity / Mood / Overall.", "📊", "blue_background"),
  ]);
  await createInlineDatabase(daysPage.id, "Productive hours", "⏰", {
    Hour: { title: {} },
    Tasks: number(),
    Month: select([]),
  });
  await appendBlocks(daysPage.id, [
    callout("Add chart here → Most productive hours: bar chart on the Productive hours database above, X = Hour, Y = Tasks.", "📊", "blue_background"),
  ]);

  // 3c. Expenses (mirrors expenseRegister)
  await appendBlocks(expensesPage.id, [
    heading2("Expenses"),
    callout("Spending summary appears here — general overview, updated daily by the nightly sync.", "📝", "gray_background"),
  ]);
  await createInlineDatabase(expensesPage.id, "Expenses", "💸", {
    Item: { title: {} },
    Amount: number("rupee"),
    Category: select([
      { name: "Food", color: "orange" },
      { name: "Travel", color: "blue" },
      { name: "Bills", color: "red" },
      { name: "Shopping", color: "purple" },
      { name: "Health", color: "green" },
      { name: "Other", color: "gray" },
    ]),
    Date: { date: {} },
    Notes: { rich_text: {} },
  });
  await appendBlocks(expensesPage.id, [
    callout("Add chart here → Category breakdown: donut, group by Category, sum of Amount (filter to this month).", "📊", "blue_background"),
    callout("Add chart here → This year by month: bar, X = Date (group by month), Y = sum of Amount.", "📊", "blue_background"),
  ]);

  // 3d. Diet (mirrors dietRegister)
  await appendBlocks(dietPage.id, [heading2("Diet")]);
  await createInlineDatabase(dietPage.id, "Diet", "🥗", {
    Day: { title: {} },
    Date: { date: {} },
    Calories: number(),
    "Carbs (g)": number(),
    "Protein (g)": number(),
    "Fiber (g)": number(),
    Meals: { rich_text: {} },
    Summary: { rich_text: {} },
  });
  await appendBlocks(dietPage.id, [
    callout("Add chart here → Last 7 days macros: bar, Carbs / Protein / Fiber (filter Date to last 7 days).", "📊", "blue_background"),
    callout("Add chart here → This year by month: bar, X = Date (group by month), Y = average macros.", "📊", "blue_background"),
  ]);
  console.log("✓ Databases: Tasks, Days, Productive hours, Expenses, Diet");

  // 4. Home content + navigation (sub-page ids exist now)
  await appendBlocks(home.id, [
    callout("Yesterday's recap shows here — productivity · mood · one-line summary. Synced nightly.", "🌙", "gray_background"),
    heading3("Today's pending tasks"),
    callout("Add a linked view of the Tasks database here, filtered to Status = Pending and Due = today.", "📋", "yellow_background"),
    divider(),
    heading2("Last 7 days"),
    callout("Add charts here → ratings trend, spend, tasks done — each as a linked view / chart filtered to the last 7 days.", "📊", "blue_background"),
    divider(),
    heading2("Explore"),
    linkToPage(tasksPage.id),
    linkToPage(daysPage.id),
    linkToPage(expensesPage.id),
    linkToPage(dietPage.id),
  ]);
  console.log("✓ Home content + navigation links\n");

  console.log("Done. Open your dashboard:");
  console.log(`  ${home.url}\n`);
  console.log("Next, by hand (~1 afternoon):");
  console.log("  • Replace each blue 📊 callout with a real chart block (type /chart).");
  console.log("  • On home, add the 'last 7 days' linked views with date filters.");
  console.log("  • Switch the Tasks database to a Board view grouped by Status.");
  console.log("  • Then make the page public and use it as your OAuth duplication template.");
}

main().catch((err) => {
  console.error("\n✗ " + err.message);
  process.exit(1);
});
