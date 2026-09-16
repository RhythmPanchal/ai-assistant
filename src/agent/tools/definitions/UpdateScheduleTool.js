import { BaseTool, ToolResult } from "../BaseTool.js";
import { updateSchedule } from "../../../tools/mongo/operation/updateSchedule.js";

// Bare on purpose — every rule lives once in the description. These appear
// twice in the declaration (update and add), and a declaration is paid for on
// every request.
const SLOT_FIELDS = {
    startTime: { type: "string" },
    endTime: { type: "string" },
    title: { type: "string" },
    category: { type: "string" },
    priority: { type: "string", enum: ["Low", "Medium", "High"] },
    notes: { type: "string" },
};

export class UpdateScheduleTool extends BaseTool {
    static name = "updateSchedule";
    static description = [
        "Change a day's schedule after it is locked in: edit existing slots or add new ones.",
        "Never use insertSchedule or updateRecords for a locked-in day.",
        "READ FIRST: fetchRecord on userSchedule for that date and use its slotIds. An unknown slotId refuses the whole call.",
        "New blocks go in `add`; their slotId is assigned. Changes go in `update` with only the changed fields.",
        "To take a block off the day set status \"Skipped\" — slots are never deleted.",
        "Times are HH:mm 24-hour; an endTime earlier than startTime ends after midnight (23:00-00:00 is one hour).",
        "Slots are not backlog tasks: move a taskCalendar task with deferTask.",
        "Google Calendar, if connected, follows on its own. Tell the user about any overlap the result reports.",
    ].join(" ");
    static parameters = {
        type: "object",
        properties: {
            date: { type: "string", description: "'YYYY-MM-DD' — date only." },
            update: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        slotId: { type: "string" },
                        ...SLOT_FIELDS,
                        status: { type: "string", enum: ["Planned", "InProgress", "Done", "Skipped", "Rescheduled"] },
                    },
                    required: ["slotId"],
                },
            },
            add: {
                type: "array",
                items: {
                    type: "object",
                    properties: { ...SLOT_FIELDS, taskRef: { type: "string" } },
                    required: ["startTime", "endTime", "title"],
                },
            },
        },
        required: ["date"],
    };

    async execute({ userId, date, update, add }) {
        const result = await updateSchedule(userId, date, { update: update ?? [], add: add ?? [] });

        if (!result?.success) {
            return new ToolResult(false, `Could not update the schedule for ${date}: ${result?.error ?? "unknown error"}`, result);
        }

        const byId = new Map(result.slots.map(s => [s.slotId, s]));
        const describe = (id) => {
            const s = byId.get(id);
            return `${s.title} ${s.startTime}-${s.endTime}` +
                (s.endTime <= s.startTime ? " (ends next day)" : "") +
                (s.status !== "Planned" ? ` [${s.status}]` : "");
        };

        const parts = [];
        if (result.updated.length) parts.push(`changed ${result.updated.map(describe).join("; ")}`);
        if (result.added.length) parts.push(`added ${result.added.map(describe).join("; ")}`);
        const overlaps = result.overlaps.length ? ` These now overlap: ${result.overlaps.join("; ")}.` : "";

        return new ToolResult(true, `Updated the schedule for ${date}: ${parts.join(", ")}.${overlaps}`, result);
    }
}
