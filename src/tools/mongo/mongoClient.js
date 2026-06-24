import { MongoClient } from "mongodb";
import dns from "dns";

// VirtualBox/VMware sets 127.0.0.1 as DNS on Windows; Node.js picks this up
// and SRV lookups fail with ECONNREFUSED since nothing listens on localhost:53.
// Override with public DNS servers before the client is created.
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const uri = process.env.MONGO_DB_URI; // from Atlas
const client = new MongoClient(uri);

let db;

export async function getDB() {
    if (!db) {
        await client.connect();
        db = client.db(process.env.MONGODB_DB_NAME); 
        console.log("✅ MongoDB connected");
    }
    return db;
}

export async function closeDB() {
    if (db) {
        await client.close();
        db = null;
        console.log("❌ MongoDB disconnected");
    }
}

