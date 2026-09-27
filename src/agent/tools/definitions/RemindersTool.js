import { BaseTool, ToolResult } from "../BaseTool.js";
import { createOneTimeReminder, createMultiTimeReminder } from "../../../scheduler/createReminders.js";
import { cancelReminder } from "../../../scheduler/cancelReminder.js";
import { recordReminderResponse } from "../../../scheduler/reminderResponse.js";

export class CreateOneTimeReminderTool extends BaseTool {
    static name = "createOneTimeReminder";
    static description = "Creates a one-time reminder for the user. It will trigger once at the specified time. Always confirm the exact date and time with the user before calling this.";
    static parameters = {
        type: "object",
        properties: {
            title: {
                type: "string",
                description: "Human-readable title for the reminder. e.g. 'Take medicine at 8pm'",
            },
            nextExecutionAt: {
                type: "string",
                description: "When the reminder should fire, in Asia/Kolkata. Write as naive ISO local time with NO trailing 'Z' and NO timezone offset, e.g. '2025-06-01T20:00:00' for 8 PM IST.",
            },
            message: {
                type: "string",
                description: "The reminder text sent to the user, as a plain string. Pass the sentence itself, NOT an object — e.g. 'Take your medicine'.",
            },
        },
        required: ["title", "nextExecutionAt", "message"],
    };

    async execute({ title, userId, nextExecutionAt, message }) {
        const result = await createOneTimeReminder(title, userId, nextExecutionAt, message);
        // A duplicate is a deliberate no-op, not a creation — saying "Created"
        // would tell the model it just scheduled a second reminder.
        return new ToolResult(
            true,
            result.duplicate ? result.message : `Created one-time reminder: "${title}".`,
            result
        );
    }
}

export class CreateMultiTimeReminderTool extends BaseTool {
    static name = "createMultiTimeReminder";
    static description = "Creates a reminder which can be used for multiple times for the user. It will trigger recursively according to cron until expiry date. please give cron and expiry date according to user query";
    static parameters = {
        type: "object",
        properties: {
            title: {
                type: "string",
                description: "Human-readable title for the reminder. e.g. 'Take medicine at 8pm'",
            },
            cron: {
                type: "string",
                description: "Cron expression describing the recurrence (5-field, Asia/Kolkata timezone). e.g. '0 20 * * *' for every day at 8pm.",
            },
            nextExecutionAt: {
                type: "string",
                description: "When the reminder should first fire, in Asia/Kolkata. Write as naive ISO local time with NO 'Z' and NO timezone offset, e.g. '2025-06-01T20:00:00' for 8 PM IST.",
            },
            message: {
                type: "string",
                description: "The reminder text sent to the user, as a plain string. Pass the sentence itself, NOT an object — e.g. 'Take your medicine'.",
            },
            expiryDate: {
                type: "string",
                description: "When the recurring reminder should stop, in Asia/Kolkata. Same format rule as nextExecutionAt — naive ISO local time, no 'Z', no offset. e.g. '2026-06-01T20:00:00'.",
            }
        },
        required: ["title", "cron", "nextExecutionAt", "message", "expiryDate"],
    };

    async execute({ title, userId, cron, nextExecutionAt, message, expiryDate }) {
        const result = await createMultiTimeReminder(title, userId, cron, nextExecutionAt, message, expiryDate);
        return new ToolResult(
            true,
            result.duplicate ? result.message : `Created recurring reminder: "${title}" with cron ${cron}.`,
            result
        );
    }
}


export class CancelReminderTool extends BaseTool {
    static name = "cancelReminder";
    static description =
        "Stop a reminder the user no longer wants — a recurring one they are done with, or a one-time one that is no longer needed. " +
        "You MUST call fetchRecord on triggerJob first (filter status 'active') and pass the exact _id it returned; never guess or reconstruct an _id. " +
        "If more than one reminder could match what the user said, list them with their times and ask which one before calling this — do not pick for them. " +
        "This cancels reminders only. It cannot switch off the daily good-morning or good-night routines, and it does not delete anything: the reminder is marked cancelled and stops firing. " +
        "To change when a reminder fires rather than stop it, cancel it and create a new one.";

    static parameters = {
        type: "object",
        properties: {
            id: {
                type: "string",
                description: "The exact 24-character hex _id from a fetchRecord response on triggerJob. NEVER fabricate.",
            },
            reason: {
                type: "string",
                description: "Short reason, e.g. 'user says they no longer need the Masi reminder'. Logged for the audit trail.",
            },
        },
        required: ["id", "reason"],
    };

    async execute({ id, userId, reason }) {
        const result = await cancelReminder(id, userId, reason);

        if (result.alreadyCancelled) {
            return new ToolResult(true, result.message, result);
        }

        // Name the schedule back, not just the title. The user's own words were
        // fuzzy ("the masi one"); quoting what was actually stopped is how they
        // catch the agent having cancelled the wrong reminder.
        const when = result.recurring ? `recurring (${result.cronPattern})` : "one-time";
        return new ToolResult(
            true,
            `Cancelled "${result.title}" — ${when}. It will not fire again.`,
            result
        );
    }
}

/**
 * Record what happened to a reminder the user answered in conversation.
 *
 * The buttons on a delivered reminder are the fast path, and most of the time
 * nobody taps them. The night routine then asks, and the answer arrives as
 * prose — "yeah took it", "never got round to it". This writes that to the same
 * `reminderResponse` field the buttons write, which is what makes the answer
 * stick: the UNANSWERED block is re-read from the database at the top of every
 * turn, so without this the model would see the same reminder still open on its
 * next turn and ask again. That is the failure the night blocks exist to stop.
 *
 * It can set only those two fields, on a reminder belonging to the caller. It
 * cannot cancel, reschedule or delete anything.
 */
export class AnswerReminderTool extends BaseTool {
    static name = "answerReminder";
    static description =
        "Record whether a reminder that fired today actually happened, when the user tells you in conversation. " +
        "Use the _id shown in the UNANSWERED REMINDERS block — call this once per reminder they answer. " +
        "'completed' means they did it. 'missed' means the moment has passed and it will not happen. " +
        "If they do not say what happened, do not call this and do not guess. " +
        "This only records the outcome — it does not cancel the reminder or stop it firing again, and logging the work itself is still addPerformedTask.";

    static parameters = {
        type: "object",
        properties: {
            id: {
                type: "string",
                description: "The 24-character hex _id from the UNANSWERED REMINDERS block. NEVER fabricate.",
            },
            outcome: {
                type: "string",
                description: "'completed' if they did it, 'missed' if it did not happen and now cannot.",
                enum: ["completed", "missed"],
            },
        },
        required: ["id", "outcome"],
    };

    async execute({ id, userId, outcome }) {
        // recordReminderResponse speaks the buttons' vocabulary.
        const verdict = outcome === "completed" ? "done" : "missed";
        const result = await recordReminderResponse(userId, id, verdict);

        if (!result.success) return new ToolResult(false, result.message, result);

        // Name the reminder back, not just the verdict — the model picked the
        // _id out of a list, and quoting what was actually recorded is how a
        // wrong pick becomes visible in the reply instead of days later.
        const what = result.text || result.title;
        return new ToolResult(
            true,
            `Recorded "${what}" as ${result.status}.`,
            result
        );
    }
}
