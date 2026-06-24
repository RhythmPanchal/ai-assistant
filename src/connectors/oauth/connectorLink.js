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
    await db.collection("connection").insertOne({
      userId,
      appName,
      stateToken,
      status: "PENDING",
      code: null,
      access_token: null,
      refresh_token: null,
      expiresAt: null,
      scope: null,
      createdAt: now,
      updatedAt: now,
    });

    const baseUrl = process.env.BASE_URL;
    const uri = `${baseUrl}/oauth/start?state=${stateToken}`;
    return uri;
  } catch (err) {
    console.error("[generateConnectorLink] Failed to generate URI:", err);
    throw new Error("failed to generate uri");
  }
}
