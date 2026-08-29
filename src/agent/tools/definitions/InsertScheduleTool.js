import { BaseTool, ToolResult } from "../BaseTool.js";
import { insertSchedule } from "../../../tools/mongo/operation/insertSchedule.js";

export class InsertScheduleTool extends BaseTool {
    static name = "insertSchedule";
    static description = `Insert the user's confirmed daily schedule. Call this ONLY after the user has reviewed and approved the schedule. The function automatically sorts slots by startTime and derives the day name from the date. Will fail if a schedule already exists for that userId + date.`;
    static parameters = {
        type: "object",
        properties: {
            date: {
                type: "string",
                description: "Schedule day in Asia/Kolkata as 'YYYY-MM-DD' (date only, no time, no 'Z', no offset), e.g. '2026-05-01'.",
            },
            slots: {
                type: "array",
                description: "Array of slot objects with full details for the confirmed schedule.",
                items: {
                    type: "object",
                    properties: {
                        slotId: {
                            type: "string",
                            description: "Unique slot identifier, e.g. 'slot_1', 'slot_2'.",
                        },
                        startTime: {
                            type: "string",
                            description: "Start time in HH:mm (24h). e.g. '09:00'.",
                        },
                        endTime: {
                            type: "string",
                            description: "End time in HH:mm (24h). e.g. '10:30'.",
                        },
                        title: {
                            type: "string",
                            description: "Activity name.",
                        },
                        category: {
                            type: "string",
                            description: "Category: Work, Personal, Health, Finance, etc.",
                        },
                        taskRef: {
                            type: "string",
                            description: "_id from taskCalendar if linked, else null.",
                        },
                        priority: {
                            type: "string",
                            enum: ["Low", "Medium", "High"],
                            description: "Priority level.",
                        },
                        status: {
                            type: "string",
                            enum: ["Planned", "InProgress", "Done", "Skipped", "Rescheduled"],
                            description: "Slot status.",
                        },
                        notes: {
                            type: "string",
                            description: "Extra context.",
                        },
                    },
                    required: ["slotId", "startTime", "endTime", "title"],
                },
            },
            summary: {
                type: "string",
                description: "Brief overview of the day plan.",
            },
            motivationalNote: {
                type: "string",
                description: "Motivational message for the day.",
            },
        },
        required: ["date", "slots"],
    };

    async execute({ userId, date, slots, summary, motivationalNote }) {
        const result = await insertSchedule(userId, date, slots, summary, motivationalNote);

        // insertSchedule signals failure by RETURNING { success: false } — a bad
        // date, an empty slot list, a schema rejection — rather than throwing, so
        // the registry's catch never sees it. Reporting true regardless told the
        // model a day plan had been stored when nothing was written, and HARD
        // RULE 1 then let it say "Saved" in complete good faith.
        if (!result?.success) {
            return new ToolResult(false, `Could not insert the schedule for ${date}: ${result?.error ?? "unknown error"}`, result);
        }

        return new ToolResult(true, `Successfully inserted schedule for ${date}`, result);
    }
}

