import { MongoClient } from "mongodb";

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
