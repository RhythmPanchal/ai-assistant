/**
 * Hand-run:  node src/test/measurePromptSize.js
 *
 * What one request to the model actually weighs. Matters because providers cap
 * TOKENS PER MINUTE, not just requests — Groq's free tier is 6K-15K TPM, so a
 * prompt above that ceiling cannot be served at all, regardless of quota left.
 *
 * Offline. ~4 chars/token is a rough but adequate estimate for planning.
 */
import "dotenv/config";
import { buildSystemInstruction } from "../agent/instruction.js";
import toolRegistry from "../agent/tools/definitions/index.js";
import goodNightFlow from "../agent/flows/goodNightFlow.js";
import goodMorningFlow from "../agent/flows/goodMorningFlow.js";

const tok = (s) => Math.ceil(s.length / 4);
const row = (label, chars) =>
    console.log(`  ${label.padEnd(34)} ${String(chars).padStart(7)} chars  ~${String(tok(" ".repeat(chars))).padStart(6)} tok`);

const base = buildSystemInstruction([]);
const withNight = buildSystemInstruction([goodNightFlow.instruction]);
const withMorning = buildSystemInstruction([goodMorningFlow.instruction]);
const toolsJson = JSON.stringify(toolRegistry.getToolDeclarations());

console.log("\nPER-REQUEST PROMPT WEIGHT\n");
row("system: persona + live time", base.length);
row("system: + goodNight overlay", withNight.length);
row("system: + goodMorning overlay", withMorning.length);
row(`tool declarations (${toolRegistry.getAllTools().length} tools)`, toolsJson.length);

const floor = base.length + toolsJson.length;
const night = withNight.length + toolsJson.length;
console.log("\n  ─────────────────────────────────────────────────────────");
row("FLOOR  (plain chat, no history)", floor);
row("NIGHT  (wrap-up, no history)", night);

console.log("\nAGAINST FREE-TIER TPM CEILINGS\n");
const ceilings = [
    ["Groq  llama-3.1-8b-instant", 6000],
    ["Groq  larger models", 15000],
    ["Gemini free tier (any)", 250000],
];
for (const [name, tpm] of ceilings) {
    const fits = tok(" ".repeat(night)) <= tpm;
    const perMin = Math.floor(tpm / tok(" ".repeat(night)));
    console.log(
        `  ${name.padEnd(30)} ${String(tpm).padStart(7)} TPM  ` +
        `${fits ? `OK  ~${perMin} night-flow req/min` : "TOO SMALL — one request exceeds the minute budget"}`
    );
}

console.log("\n  Note: history (up to 15 turns) and tool RESULTS stack on top of");
console.log("  the figures above, so real requests run higher than the floor.\n");
