import { BaseTool, ToolResult } from "../BaseTool.js";
import { createTask } from "../../../tools/mongo/operation/createTask.js";

export class CreateTaskTool extends BaseTool {
    static name = "createTask";
    static description = "Add a new task to the user's task calendar. Use this whenever the user wants to create, add, or schedule a task. Try to infer and fill ALL fields from the user's message and context — do not leave fields empty if you can reasonably determine their values.";
    static parameters = {
        type: "object",
        properties: {
            userId: {
                type: "integer",
                description: "Identifier of the user who owns this task.",
            },
            title: {
                type: "string",
                description: "Title or name of the task.",
            },
            requiredMinutes: {
                type: "integer",
                description: "Estimated time in minutes to complete the task. Infer from context if possible.",
            },
            importance: {
                type: "string",
                enum: ["Low", "Medium", "High"],
                description: "Importance level of the task. Infer from the nature of the task if not explicitly stated.",
            },
            priorityScore: {
                type: "integer",
                description: "Priority score from 1 (highest) to 5 (lowest). Infer based on urgency and importance.",
            },
            category: {
                type: "string",
                description: "Category of the task e.g. Work, Personal, Health, Finance. Always try to assign a category.",
            },
            deadline: {
                type: "string",
                description: "Task deadline in Asia/Kolkata. Write as naive ISO local time with NO trailing 'Z' and NO timezone offset, e.g. '2026-06-10T18:00:00' for 6 PM IST. Infer from context like 'by tomorrow', 'this week', etc.",
            },
            recurring: {
                type: "string",
                enum: ["hourly", "daily", "weekly", "monthly", "annually"],
                description: "Recurrence pattern for the task. Set if the task appears to be recurring.",
            },
        },
        required: ["userId", "title"],
    };

    async execute({ userId, title, requiredMinutes, importance, priorityScore, category, deadline, recurring }) {
        const result = await createTask(userId, title, requiredMinutes, importance, priorityScore, category, deadline, recurring);

        // createTask refuses routine blocks and silently-duplicating titles.
        // Reporting those as success is how "Personal time / catch up" ended up
        // in the backlog and stayed there: the model was told it had worked.
        if (result?.success === false) return new ToolResult(false, result.error, result);
        if (result?.duplicate) return new ToolResult(true, result.message, result);

        return new ToolResult(true, `Created task "${title}".`, result);
    }
}

