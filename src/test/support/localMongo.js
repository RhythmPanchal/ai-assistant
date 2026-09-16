/**
 * Point this process at a LOCAL MongoDB before anything imports mongoClient.
 *
 * mongoClient builds its client from MONGO_DB_URI at import time, and .env
 * points at Atlas — the real one. So the URI is set here first, the URI shape is
 * checked so a test can never write to a remote database, and .env is loaded
 * afterwards only for the keys it carries (dotenv does not override variables
 * that are already set).
 *
 * Start one with:
 *   mkdir -p /tmp/rasmalai-mongo && mongod --dbpath /tmp/rasmalai-mongo --port 27017 --bind_ip 127.0.0.1
 */
import { MongoClient } from "mongodb";

const LOCAL = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;

export async function useLocalMongo(dbName) {
    const uri = process.env.LOCAL_MONGO_URI || "mongodb://127.0.0.1:27017";
    if (!LOCAL.test(uri)) {
        throw new Error(`LOCAL_MONGO_URI must be a localhost mongodb:// URI, got ${uri}`);
    }

    const probe = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
    try {
        await probe.connect();
        await probe.db("admin").command({ ping: 1 });
    } catch {
        console.error(
            `No MongoDB reachable at ${uri}. Start a local one:\n` +
            `  mkdir -p /tmp/rasmalai-mongo && mongod --dbpath /tmp/rasmalai-mongo --port 27017 --bind_ip 127.0.0.1`
        );
        process.exit(2);
    } finally {
        await probe.close();
    }

    process.env.MONGO_DB_URI = uri;
    process.env.MONGODB_DB_NAME = dbName;
    await import("dotenv/config");
    if (process.env.MONGO_DB_URI !== uri) {
        throw new Error("MONGO_DB_URI changed after loading .env — refusing to run against a non-local database");
    }
    return uri;
}
