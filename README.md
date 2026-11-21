<div align="center">

# 🍮 Rasmalai

**A personal-assistant agent that lives in Telegram.**
Talk to it like a friend. It plans your day, tracks your money and meals, and nudges you at the right time.

![Node.js](https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Gemini](https://img.shields.io/badge/LLM-Google%20Gemini-4285F4?logo=google&logoColor=white)
![MongoDB](https://img.shields.io/badge/DB-MongoDB%20Atlas-47A248?logo=mongodb&logoColor=white)
![Telegram](https://img.shields.io/badge/Chat-Telegram-26A5E4?logo=telegram&logoColor=white)

### [💬 Chat with Rasmalai on Telegram](https://t.me/TskMgrRhythmBot) · [🖥️ Open the dashboard](https://rasmalai-ui.pages.dev)

</div>

---

## ✨ What it does

You message the bot. An LLM turns your intent into tool calls that read and write a MongoDB database, then replies in plain language.

| | Capability | Example |
| --- | --- | --- |
| ✅ | **Tasks** | "add a task: renew passport by Friday" |
| 💸 | **Expenses** | "spent 240 on lunch" |
| 🍽️ | **Diet log** | "had two idlis and chai" |
| 📅 | **Daily schedule** | Drafts a plan, saves it, pushes it to Google Calendar |
| ⏰ | **Reminders** | One-time and recurring |
| 🌅 | **Routines** | A good-morning plan and a good-night recap, run by the scheduler |
| 🧠 | **Memory** | Day summaries, profile and notes carried between days |
| 🔌 | **Connected apps** | Google Calendar and Notion, linked with a Telegram button |

## 🧩 How it fits together

```
Telegram ──webhook──▶ Express ──▶ per-user queue ──▶ agent loop ──▶ Gemini
                                                         │              │
                                                         ▼              │
                                                   tool dispatcher ◀────┘
                                                         │
                                          MongoDB Atlas · Google Calendar · Notion

node-cron (every minute) ──▶ trigger executor ──▶ reminders · morning / night routines
```

- **Webhook first.** Telegram updates arrive over HTTPS, so the server must be publicly reachable at `BASE_URL`. Long polling is a local fallback (`TELEGRAM_MODE=polling`).
- **Serial per user, parallel across users.** Messages from one chat never overlap.
- **Tool calls run in parallel** inside a turn, and each full turn is saved as one chat-history document.
- **Flows.** Morning and night routines open scoped instruction overlays, so the agent behaves differently during each.

## 🚀 Getting started

**Requirements:** Node.js 18+, a MongoDB Atlas database, a Telegram bot token, a Gemini API key.

```bash
npm install
cp .env.example .env     # if you have one; otherwise create .env as below
npm run dev              # nodemon src/index.js
```

### Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port |
| `BASE_URL` | Public origin. Used for the OAuth "Connect" link |
| `OAUTH_CALLBACK` | Full redirect URI registered with each OAuth provider |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random string, checked on every webhook request. **Required**, the route fails closed without it |
| `TELEGRAM_MODE` | `webhook` (default) or `polling` |
| `MONGO_DB_URI` / `MONGODB_DB_NAME` | Atlas connection |
| `GEMINI_API_KEY` | LLM access |

> 🔒 `.env` is gitignored. Never commit it.

> ⚠️ **Corporate networks:** `api.telegram.org` may be blocked by a proxy. The agent still runs end to end, but outbound Telegram delivery fails. Use a personal hotspot, or check rendering offline with `npm run telegram:check -- <chatId> --dry`.

## 🧪 Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server with auto-reload |
| `npm test` | Run the hand-run test scripts in sequence |
| `npm run eval` | Compare models on the eval cases |
| `npm run eval:size` | Measure system-prompt size |
| `npm run eval:chains` | Test every provider chain |
| `npm run test:schedule` | Schedule-update check, local |
| `npm run telegram:check` | Telegram rendering and delivery check |

## 🗂️ Project layout

```
src/
  index.js            Express boot, then Mongo, cron and Telegram, in that order
  oauthRestAPI.js     /oauth/start and /oauth/callback
  adminRestAPI.js     /admin/* operator routes (token-gated)
  userRestAPI.js      /api/me/* routes for the dashboard
  agent/              run loop, system instruction, tools, flows, day summaries
  knowledge/          read-only helpers that turn DB rows into prompt blocks
  scheduler/          cron tick, executor, action dispatcher, jobs
  connectors/         oauth, gCalendar, notion
  identity/           userId and context wiring
  tools/              mongo (schemas, CRUD, migrations) and telegram
  test/               hand-run test and eval scripts
```

## 🖥️ Companion UI

The web dashboard and operator console are hosted on Cloudflare Pages at **[rasmalai-ui.pages.dev](https://rasmalai-ui.pages.dev)**. Send `/login` to [@TskMgrRhythmBot](https://t.me/TskMgrRhythmBot) to get a magic link into the dashboard.

## 📌 Status

Single-user today. Multi-user support is planned but not implemented.

---

<div align="center">
<sub>Built by Rhythm Panchal · for personal use</sub>
</div>
