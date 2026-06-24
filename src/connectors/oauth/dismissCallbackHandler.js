import { getDB } from "../../tools/mongo/mongoClient.js";

export async function dismissCallbackHandler(appName, userId) {
  if (!appName || !userId) {
    throw new Error("appName and userId are required.");
  }

  // userId must be an int (Telegram chat id) to match what's stored in the DB.
  // Callers from callback_data parsing always receive strings, so coerce defensively.
  const parsedUserId = typeof userId === "string" ? parseInt(userId, 10) : userId;

  try {
    const db = await getDB();
    const now = Date.now();
    await db.collection("connection").updateOne(
      { appName, userId: parsedUserId },
      {
        $set: { status: "DISABLED", updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("[dismissCallbackHandler] Failed to disable connection:", err);
    throw err;
  }
}
