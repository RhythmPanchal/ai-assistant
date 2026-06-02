import { getDB } from "../../tools/mongo/mongoClient.js";
import { ACTIVE_FLOWS } from "../../tools/mongo/schema/activeFlowsSchema.js";

/**
 * Open a flow for a user. Supersedes any other open flow of the same type
 * for the same user — there is at most one open (userId, flowType) at a time.
 */
export async function openFlow({ userId, flowType, ttlMinutes }) {
  const db = await getDB();
  const col = db.collection(ACTIVE_FLOWS);
  const now = new Date();

  await col.updateMany(
    { userId, flowType, state: "open" },
    {
      $set: {
        state: "superseded",
        closedAt: now,
        closedBy: "system_supersede",
        updatedAt: now
      }
    }
  );

  const doc = {
    userId,
    flowType,
    state: "open",
    startedAt: now,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
    closedAt: null,
    closedBy: null,
    reason: null,
    scratchpad: null,
    createdAt: now,
    updatedAt: now
  };

  const res = await col.insertOne(doc);
  return { _id: res.insertedId, ...doc };
}

/**
 * Mark the user's open flow of `flowType` as completed. Called from the
 * `completeFlow` tool the agent invokes when it judges the flow done.
 */
export async function closeFlowByAgent({ userId, flowType, reason = "done" }) {
  const db = await getDB();
  const col = db.collection(ACTIVE_FLOWS);
  const now = new Date();

  return col.findOneAndUpdate(
    { userId, flowType, state: "open" },
    {
      $set: {
        state: "completed",
        closedAt: now,
        closedBy: "agent",
        reason,
        updatedAt: now
      }
    },
    { returnDocument: "after" }
  );
}

/**
 * Return the user's currently-open flows. Any flow whose `expiresAt` has
 * passed is lazily marked `expired` before returning, so callers never see
 * stale-open flows. Lazy expiry replaces a dedicated sweeper for v1.
 */
export async function getOpenFlowsForUser(userId) {
  const db = await getDB();
  const col = db.collection(ACTIVE_FLOWS);
  const now = new Date();

  const open = await col.find({ userId, state: "open" }).toArray();

  const live = [];
  for (const flow of open) {
    if (flow.expiresAt && flow.expiresAt < now) {
      await col.updateOne(
        { _id: flow._id, state: "open" },
        {
          $set: {
            state: "expired",
            closedAt: now,
            closedBy: "system",
            updatedAt: now
          }
        }
      );
    } else {
      live.push(flow);
    }
  }
  return live;
}
