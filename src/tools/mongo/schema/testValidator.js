const testValidatorSchema = {
  "title": "testValidator",
  "description": "this validator is written for test purpose",
  "properties": {
    "userId": {
      "bsonType": "string"
    },
    "time": {
      "bsonType": "string"
    },
    "message": {
      "bsonType": "string"
    }
  },
  "required": ["userId", "time", "message"]
}

export default testValidatorSchema; 
