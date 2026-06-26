import { getDB } from "../../tools/mongo/mongoClient.js";

export async function disconnectApp(userId, appName) {
  const db = await getDB();
  const connection = await db.collection("connection").findOne({ userId, appName });

  if (!connection) {
    return { success: true, message: `No connection found for ${appName}. Nothing to disconnect.` };
  }

  await db.collection("connection").updateOne(
    { userId, appName },
    {
      $set: {
        status: "DISABLED",
        access_token: null,
        refresh_token: null,
        expiresAt: null,
        scope: null,
        updatedAt: Date.now(),
      },
    }
  );

  return { success: true, message: `${appName} has been disconnected and all stored tokens have been removed.` };
}
