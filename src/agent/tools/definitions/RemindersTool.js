import { BaseTool, ToolResult } from "../BaseTool.js";
import { createOneTimeReminder, createMultiTimeReminder } from "../../../scheduler/createReminders.js";
import { cancelReminder } from "../../../scheduler/cancelReminder.js";

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
