import fetchCollectionNameAndSchema from "./fetchCollectionSchema.js";


function validateType(fieldName, value, bsonType, schema) {
    switch (bsonType) {
        case "string":
            if (typeof value !== "string") {
                throw new Error(`Field '${fieldName}' must be a string`);
            }
            break;

        case "int":
        case "long":
            if (!Number.isInteger(value)) {
                throw new Error(`Field '${fieldName}' must be an integer`);
            }
            break;

        case "double":
        case "decimal":
            if (typeof value !== "number") {
                throw new Error(`Field '${fieldName}' must be a number`);
            }
            break;

        case "date":
            if (!(value instanceof Date) || isNaN(value.getTime())) {
                throw new Error(`Field '${fieldName}' must be a valid Date object`);
            }
            break;

        case "bool":
        case "boolean":
            if (typeof value !== "boolean") {
                throw new Error(`Field '${fieldName}' must be a boolean`);
            }
            break;

        case "objectId":
            // Basic ObjectId validation (24 hex characters or actual ObjectId instance)
            if (typeof value === "string") {
                if (!/^[0-9a-fA-F]{24}$/.test(value)) {
                    throw new Error(`Field '${fieldName}' must be a valid ObjectId`);
                }
            } else if (value?.constructor?.name !== "ObjectId" && value?.constructor?.name !== "ObjectID") {
                throw new Error(`Field '${fieldName}' must be a valid ObjectId`);
            }
            break;

        case "array":
            if (!Array.isArray(value)) {
                throw new Error(`Field '${fieldName}' must be an array`);
            }
            // Validate array items if schema is provided
            if (schema.items) {
                value.forEach((item, index) => {
                    validateField(`${fieldName}[${index}]`, item, schema.items);
                });
            }
            break;

        case "object":
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                throw new Error(`Field '${fieldName}' must be an object`);
            }
            // Recursive validation for nested objects
            if (schema.properties) {
                validateObject(value, schema.properties);
            }
            break;

        case "null":
            if (value !== null && value !== undefined) {
                throw new Error(`Field '${fieldName}' must be null`);
            }
            break;

        default:
            throw new Error(`Unknown bsonType: ${bsonType} for field '${fieldName}'`);
    }
}

function validateField(fieldName, value, schema) {
    const { bsonType, enum: enumValues, minimum, maximum, items, properties } = schema;

    // Handle null values
    if (value === null || value === undefined) {
        if (Array.isArray(bsonType) && bsonType.includes("null")) {
            return; // null is allowed
        }
        if (bsonType === "null") {
            return;
        }
        throw new Error(`Field '${fieldName}' cannot be null`);
    }

    // Get the actual type(s) to validate against
    const allowedTypes = Array.isArray(bsonType) ? bsonType : [bsonType];

    let isValidType = false;

    for (const type of allowedTypes) {
        if (type === "null" && (value === null || value === undefined)) {
            isValidType = true;
            break;
        }

        try {
            validateType(fieldName, value, type, schema);
            isValidType = true;
            break;
        } catch (e) {
            // Continue to next type
            continue;
        }
    }

    if (!isValidType) {
        throw new Error(
            `Field '${fieldName}' has invalid type. Expected: ${allowedTypes.join(' or ')}, Got: ${typeof value}`
        );
    }

    // Validate enum if present
    if (enumValues && value !== null && value !== undefined) {
        if (!enumValues.includes(value)) {
            throw new Error(
                `Field '${fieldName}' must be one of [${enumValues.join(', ')}]. Got: ${value}`
            );
        }
    }

    // Validate numeric constraints
    if ((bsonType === "int" || bsonType === "double" || bsonType === "long" || bsonType === "decimal") && 
        value !== null && value !== undefined) {
        if (minimum !== undefined && value < minimum) {
            throw new Error(`Field '${fieldName}' must be >= ${minimum}. Got: ${value}`);
        }
        if (maximum !== undefined && value > maximum) {
            throw new Error(`Field '${fieldName}' must be <= ${maximum}. Got: ${value}`);
        }
    }
}

function validateObject(data, properties) {
    // Iterate through each field in the data
    for (const [key, value] of Object.entries(data)) {
        // Skip if property not defined in schema (extra fields allowed)
        if (!properties[key]) {
            continue;
        }

        const propertySchema = properties[key];
        validateField(key, value, propertySchema);
    }
}


async function ValidateSchema(collectionName, userData) {
    const schemas = fetchCollectionNameAndSchema();
    const collectionSchema = schemas[collectionName];
    
    if (!collectionSchema) {
        throw new Error(`Schema not found for collection: ${collectionName}`);
    }
    
    const properties = collectionSchema.schema.properties;
    const required = collectionSchema.schema.required || [];

    // Check all required fields are present
    required.forEach(field => {
        if (!(field in userData)) {
            throw new Error(`${field} is required but not present in userData.`);
        }
    });

    // Validate the data against properties
    return validateObject(userData, properties);
}


export default ValidateSchema; 
