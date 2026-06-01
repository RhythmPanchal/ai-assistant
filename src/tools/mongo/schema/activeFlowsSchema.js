export const ACTIVE_FLOWS = "activeFlows";

const activeFlowsSchema = {
  title: "activeFlows",
  description:
    "Scoped instruction-overlay sessions opened by triggers (e.g. goodNightJob) and closed by the agent (on completion) or system (on TTL/abandonment).",
  bsonType: "object",
  properties: {
    userId: {
      bsonType: "int",
      description: "Identifier of the user this flow belongs to."
    },
    flowType: {
      bsonType: "string",
      description: "Kind of flow — selects which agent instruction overlay applies.",
      enum: ["goodNight", "goodMorning"]
    },
    state: {
      bsonType: "string",
      description: "Current lifecycle state.",
      enum: ["open", "completed", "expired", "superseded"]
    },
    startedAt: {
      bsonType: "date",
      description: "When the flow was opened by its trigger."
    },
    expiresAt: {
      bsonType: "date",
      description: "When the system should treat this flow as abandoned."
    },
    closedAt: {
      bsonType: ["date", "null"],
      description: "When the flow moved out of the open state."
    },
    closedBy: {
      bsonType: ["string", "null"],
      description: "Who closed it.",
      enum: ["agent", "system", "system_supersede", null]
    },
    reason: {
      bsonType: ["string", "null"],
      description: "Free-form reason set by the agent on close (e.g. 'done', 'skipped')."
    },
    scratchpad: {
      bsonType: ["object", "null"],
      description: "Optional per-flow state (e.g. categories already logged). Reserved."
    },
    createdAt: { bsonType: "date" },
    updatedAt: { bsonType: "date" }
  },
  required: [
    "userId",
    "flowType",
    "state",
    "startedAt",
    "expiresAt",
    "createdAt",
    "updatedAt"
  ]
};

export default activeFlowsSchema;
