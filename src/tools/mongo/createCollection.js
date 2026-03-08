import { getDB } from "./mongoClient.js";

export async function loadSchema(collectionName) {
    const schemaModulePath =
        `./schema/${collectionName}Schema.js`;
    try {
        const module = await import(schemaModulePath);
        return module.default;
    } catch (err) {
        throw new Error(
            `❌ Schema not found for collection '${collectionName}'`
        );
    }
}


export async function createCollection(args) {
    const collectionName = args.collectionName;
    const db = await getDB();

    const collections = await db.listCollections({ name: collectionName }).toArray();

    if (collections.length > 0) {
        return {
            success: true,
            message: "Collection already exists",
        };
    }
    const schema = await loadSchema(collectionName);
    await db.createCollection(collectionName, {
        validator: {
            $jsonSchema: schema
        },
        validationLevel: "strict",
        validationAction: "error"

    });


    return {
        success: true,
        message: `Collection '${collectionName}' created`,
    };
}
