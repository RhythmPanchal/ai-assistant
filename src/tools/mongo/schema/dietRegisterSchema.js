export const DIET_REGISTER = "dietRegister";

const dietRegisterSchema = {
  title: "dietRegister",
  description: "Daily diet and nutrition log",
  bsonType: "object",
  properties: {
    userId : {
      bsonType: "int",
      description: "Identifier for the user who owns the diet record"
    },
    date: {
      bsonType: "date"
    },
    month: {
      bsonType: "string"
    },
    year: {
      bsonType: "int"
    },
    dietType: {
      bsonType: "string",
      enum: ["Vegetarian", "Non-Vegetarian", "Vegan", "Mixed"]
    },
    meals: {
      bsonType: "array",
      items: {
        bsonType: "object",
        properties: {
          mealType: {
            bsonType: "string",
            enum: ["Breakfast", "Lunch", "Dinner", "Snack"]
          },
          items: {
            bsonType: "array",
            items: {
              bsonType: "object",
              properties: {
                name: { bsonType: "string" },
                quantity: { bsonType: "string" },
                calories: { bsonType: "int" },
                protein: { bsonType: "int" },
                carbs: { bsonType: "int" },
                fat: { bsonType: "int" }
              },
              required: ["name", "quantity", "calories"]
            }
          },
          mealCalories: {
            bsonType: "int",
            minimum: 0
          }
        },
        required: ["mealType", "items", "mealCalories"]
      }
    },
    dailyTotals: {
      bsonType: "object",
      properties: {
        caloriesConsumed: { bsonType: "int" },
        protein: { bsonType: "int" },
        carbs: { bsonType: "int" },
        fat: { bsonType: "int" }
      },
      required: ["caloriesConsumed", "protein", "carbs", "fat"]
    },
    waterIntakeMl: {
      bsonType: "int",
      minimum: 0,
      description: "Total water intake in ml"
    },
    adherenceScore: {
      bsonType: "int",
      minimum: 1,
      maximum: 5,
      description: "How well diet goals were followed"
    },
    notes: {
      bsonType: "string"
    },
    createdAt: {
      bsonType: "date"
    }
  },
  required: [
    "date",
    "month",
    "year",
    "meals",
    "dailyTotals"
  ]
};

export default dietRegisterSchema;
