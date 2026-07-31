import { BaseTool, ToolResult } from "../BaseTool.js";
import { createOneTimeReminder, createMultiTimeReminder } from "../../../scheduler/createReminders.js";

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
            userId: {
                type: "integer",
                description: "Identifier of the user who owns this reminder.",
            },
            nextExecutionAt: {
                type: "string",
                description: "When the reminder should fire, in Asia/Kolkata. Write as naive ISO local time with NO trailing 'Z' and NO timezone offset, e.g. '2025-06-01T20:00:00' for 8 PM IST.",
            },
            message: {
                type: "string",
                description: "Any extra description needed to execute the reminder action, e.g. { message: 'Take your medicine' }",
            },
        },
        required: ["title", "userId", "nextExecutionAt", "message"],
    };

    async execute({ title, userId, nextExecutionAt, message }) {
        const result = await createOneTimeReminder(title, userId, nextExecutionAt, message);
        return new ToolResult(true, `Created one-time reminder: "${title}".`, result);
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
            userId: {
                type: "integer",
                description: "Identifier of the user who owns this reminder.",
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
                description: "Any extra description needed to execute the reminder action, e.g. { message: 'Take your medicine' }",
            },
            expiryDate: {
                type: "string",
                description: "When the recurring reminder should stop, in Asia/Kolkata. Same format rule as nextExecutionAt — naive ISO local time, no 'Z', no offset. e.g. '2026-06-01T20:00:00'.",
            }
        },
        required: ["title", "userId", "cron", "nextExecutionAt", "message", "expiryDate"],
    };

    async execute({ title, userId, cron, nextExecutionAt, message, expiryDate }) {
        const result = await createMultiTimeReminder(title, userId, cron, nextExecutionAt, message, expiryDate);
        return new ToolResult(true, `Created recurring reminder: "${title}" with cron ${cron}.`, result);
    }
}

