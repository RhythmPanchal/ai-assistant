import { BaseTool, ToolResult } from "../BaseTool.js";
import { addPerformedTask, describeTaskDay, TASK_LOG_STATUSES } from "../../../tools/mongo/operation/taskLog.js";

export class AddPerformedTaskTool extends BaseTool {
    static name = "addPerformedTask";
    static description =
        "Log ONE piece of work the user actually did into that day's task log. It is appended — the day is " +
        "created if needed — so never write the task log with createRecord or updateRecords, which rewrite the " +
        "whole day and erase work already logged. Call it once per piece of work; several in one turn are fine. " +
        "If the work closes a task on their list, call updateTaskStatus first and pass the id it returns as taskId. " +
        "Work already logged today is refused as a duplicate — that is not an error to retry.";
    static parameters = {
        type: "object",
        properties: {
            title: { type: "string", description: "The work, in the user's words, e.g. 'Q3 deck review with Ankit'." },
            actualDurationMinutes: {
                type: "integer",
                description: "How long it took, in minutes. If the user did not say, ask — do not guess.",
            },
            status: { type: "string", enum: TASK_LOG_STATUSES, description: "Defaults to Completed." },
            category: { type: "string", description: "e.g. Work, Personal, Health, Learning." },
            taskId: {
                type: "string",
                description: "The taskCalendar id updateTaskStatus returned, when this work closed a listed task. Otherwise leave it out.",
            },
            actualFrom: { type: "string", description: "HH:mm, only if the user said when it started." },
            actualTo: { type: "string", description: "HH:mm, only if the user said when it ended." },
            focusLevel: { type: "integer", description: "1-5, only if the user said how focused they were." },
            notes: { type: "string", description: "Anything else worth keeping, briefly." },
            date: {
                type: "string",
                description: "YYYY-MM-DD. The day being logged. In the night routine, copy LOG DATE. Omit for today.",
            },
        },
        required: ["title", "actualDurationMinutes"],
    };

    async execute({ userId, ...input }) {
        try {
            const r = await addPerformedTask(userId, input);
            const note = r.note ? ` Note: ${r.note}` : "";
            if (r.duplicate) {
                // success:true — the work IS logged, which is what the model
                // wanted. A failure here would invite a retry, and a retry is
                // exactly the re-logging this refuses.
                return new ToolResult(
                    true,
                    `"${r.task.title}" is already logged for ${r.date} — nothing added.${note} Day: ${describeTaskDay(r.day)}`,
                    { date: r.date, duplicate: true, taskRegisterId: String(r.day._id) }
                );
            }
            return new ToolResult(
                true,
                `Logged "${r.task.title}" (${r.task.status}, ${r.task.actualDurationMinutes} min) for ${r.date}.${note} Day now: ${describeTaskDay(r.day)}`,
                { date: r.date, duplicate: false, taskRegisterId: String(r.day._id), task: r.task }
            );
        } catch (err) {
            return new ToolResult(false, `Work not logged: ${err.message}`);
        }
    }
}
