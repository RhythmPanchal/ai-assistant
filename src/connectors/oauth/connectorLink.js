import { randomUUID } from "crypto";
import { getDB } from "../../tools/mongo/mongoClient.js";

export async function generateConnectorLink(appName, userId) {
  if (!appName || !userId) {
    throw new Error("appName and userId are required.");
  }

  try {
    const stateToken = randomUUID();
    const now = Date.now();

    const db = await getDB();
    // Upsert so reconnects (after DISABLED or a previous PENDING) reset cleanly
    // without creating duplicate records for the same userId+appName.
    await db.collection("connection").updateOne(
      { userId, appName },
      {
        $set: {
          stateToken,
          status: "PENDING",
          access_token: null,
          refresh_token: null,
          expiresAt: null,
          scope: null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    const baseUrl = process.env.BASE_URL;
    const uri = `${baseUrl}/oauth/start?state=${stateToken}`;
    return uri;
  } catch (err) {
    console.error("[generateConnectorLink] Failed to generate URI:", err);
    throw new Error("failed to generate uri");
  }
}
