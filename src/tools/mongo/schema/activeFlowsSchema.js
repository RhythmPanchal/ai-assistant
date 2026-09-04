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

/**
 * Serves, in order of how often each runs:
 *  - getOpenFlowsForUser  — find({ userId, state: "open" }), once per agent turn
 *  - openFlow / closeFlow — { userId, flowType, state: "open" }
 *  - hasFlowStartedToday  — findOne({ userId, flowType, startedAt: {$gte} }),
 *    the guard that stops a restart re-running a whole morning job
 *
 * Three indexes rather than one compound: Mongo can use a leading prefix of a
 * compound index but cannot skip a middle field, so { userId, flowType, state }
 * does not help the { userId, state } lookup — and that is the one on the
 * per-turn path.
 *
 * Deliberately not unique on (userId, flowType, state). Two open flows of the
 * same type is a bug openFlow already prevents by superseding, but enforcing it
 * here would make a benign race throw inside a cron tick.
 */
export const ACTIVE_FLOWS_INDEXES = [
  { key: { userId: 1, state: 1 }, name: "userId_1_state_1" },
  { key: { userId: 1, flowType: 1, state: 1 }, name: "userId_1_flowType_1_state_1" },
  { key: { userId: 1, flowType: 1, startedAt: -1 }, name: "userId_1_flowType_1_startedAt_-1" },
];
