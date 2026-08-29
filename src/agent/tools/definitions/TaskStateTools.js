import { BaseTool, ToolResult } from "../BaseTool.js";
import { updateTaskStatus, deferTask, TASK_STATUSES } from "../../../tools/mongo/operation/taskState.js";

/**
 * Declared globally rather than behind a skill.
 *
 * The failure these fix was not a morning failure. "compaction prod vala to usi
 * din ho gaya tha" could arrive at any hour, and a backlog the assistant can
 * only correct during one routine a day is a backlog that stays wrong. They are
 * two declarations against a tool list that already carries eighteen.
 */

export class UpdateTaskStatusTool extends BaseTool {
    static name = "updateTaskStatus";
    static description =
        "Close, cancel or reopen tasks in the task calendar. Call this the moment the user says a task " +
        "is already done, no longer needed, or should come back — including in passing, mid-sentence, " +
        "while you are talking about something else. Acknowledging it without calling this leaves the " +
        "task Pending and it will be offered back to them tomorrow morning. " +
        "Identify each task by its id when you have been shown one, otherwise by its exact title. " +
        "Pass every task the user resolved in ONE call.";
    static parameters = {
        type: "object",
        properties: {
            updates: {
                type: "array",
                description: "One entry per task the user has resolved.",
                items: {
                    type: "object",
                    properties: {
                        task: {
                            type: "string",
                            description:
                                "The task's 24-character id if you have seen one (the pending-task list gives " +
                                "you ids), otherwise its exact title. Never invent an id.",
                        },
                        status: {
                            type: "string",
                            enum: TASK_STATUSES,
                            description:
                                "Completed — they finished it. Cancelled — it is no longer worth doing. " +
                                "Pending — it is back on the list. Scheduled — it is in a locked schedule.",
                        },
                        note: {
                            type: "string",
                            description:
                                "Short reason, in their words, when there is one — 'already did it on the 22nd', " +
                                "'not doing this any more'. Kept on the task.",
                        },
                    },
                    required: ["task", "status"],
                },
            },
        },
        required: ["updates"],
    };

    async execute({ userId, updates }) {
        const result = await updateTaskStatus(userId, updates);

        if (result.error) return new ToolResult(false, result.error);

        const changed = (result.updated ?? []).filter(u => !u.unchanged);
        const already = (result.updated ?? []).filter(u => u.unchanged);
        const parts = [];
        if (changed.length) parts.push(changed.map(u => `"${u.title}" ${u.from} -> ${u.to}`).join("; "));
        if (already.length) parts.push(`already correct: ${already.map(u => `"${u.title}"`).join(", ")}`);
        // Surfaced in the message, not just the payload — a failure the model
        // does not read is a task it reports as closed and is not.
        if (result.failed?.length) {
            parts.push(`could not resolve: ${result.failed.map(f => `${f.task} — ${f.error}`).join(" | ")}`);
        }

        return new ToolResult(result.success, parts.join(". ") || "Nothing to update.", result);
    }
}

export class DeferTaskTool extends BaseTool {
    static name = "deferTask";
    static description =
        "Move a task's deadline and record that it moved. Use when the user pushes something back — " +
        "'not this week', 'next Sunday', 'after the release'. Do NOT edit a deadline through updateRecords: " +
        "this keeps the original deadline and counts the pushes, which is the only way anyone can later see " +
        "that a task is being avoided rather than planned.";
    static parameters = {
        type: "object",
        properties: {
            task: { type: "string", description: "The task's 24-character id, or its exact title." },
            newDeadline: {
                type: "string",
                description:
                    "The new deadline in the user's local time, naive — no 'Z', no offset. " +
                    "'2026-09-06' or '2026-09-06T18:00:00'. Resolve 'next Sunday' against RIGHT NOW yourself.",
            },
            reason: {
                type: "string",
                description: "Why it moved, in the user's words. Kept on the task.",
            },
        },
        required: ["task", "newDeadline"],
    };

    async execute({ userId, task, newDeadline, reason }) {
        const result = await deferTask(userId, task, newDeadline, reason);
        if (!result.success) return new ToolResult(false, result.error, result);

        const nth = result.deferCount === 1 ? "1st" : result.deferCount === 2 ? "2nd" : result.deferCount === 3 ? "3rd" : `${result.deferCount}th`;
        return new ToolResult(
            true,
            `"${result.title}" moved to ${newDeadline} — ${nth} time this deadline has been pushed.`,
            result
        );
    }
}
