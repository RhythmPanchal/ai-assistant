import { getDB } from "../../tools/mongo/mongoClient.js";
import { ACTIVE_FLOWS } from "../../tools/mongo/schema/activeFlowsSchema.js";

/**
 * Open a flow for a user. Supersedes any other open flow of the same type
 * for the same user — there is at most one open (userId, flowType) at a time.
 */
export async function openFlow({ userId, flowType, expiresAt, ttlMinutes }) {
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
    // Flows close on a real-world condition (the day ending, the next routine
    // firing, the user disengaging), not a stopwatch from when they opened.
    // expiresAt is only the backstop for "nobody ever came back".
    expiresAt: expiresAt ?? new Date(now.getTime() + (ttlMinutes ?? 60) * 60 * 1000),
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

/** Close an open flow from the system side (a job, a cutoff, a supersede). */
export async function closeFlow({ userId, flowType, reason, closedBy = "system" }) {
  const db = await getDB();
  const now = new Date();
  const res = await db.collection(ACTIVE_FLOWS).findOneAndUpdate(
    { userId, flowType, state: "open" },
    { $set: { state: "completed", closedAt: now, closedBy, reason, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (res) console.log(`[flows] closed ${flowType} for ${userId} — ${reason}`);
  return res;
}

/**
 * Has this routine already opened for the user today, in their own timezone?
 *
 * The only thing standing between a process restart and a second full morning
 * agent run (~13 requests). Checked against the DB, not memory, so it survives
 * restarts and holds even if both the hourly executor and a legacy triggerJob
 * row fire for the same user.
 */
export async function hasFlowStartedToday(userId, flowType, timeZone = "Asia/Kolkata") {
  const db = await getDB();
  const localDate = new Date().toLocaleDateString("en-CA", { timeZone }); // YYYY-MM-DD
  const localMidnight = new Date(`${localDate}T00:00:00`);

  const existing = await db.collection(ACTIVE_FLOWS).findOne({
    userId,
    flowType,
    startedAt: { $gte: localMidnight },
  });
  return Boolean(existing);
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
