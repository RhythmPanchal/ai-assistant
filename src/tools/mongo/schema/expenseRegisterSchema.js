export const EXPENSE_REGISTER = "expenseRegister";

const expenseRegisterSchema = {
  title: "expenseRegister",
  description: "Daily expense log",
  bsonType: "object",
  properties: {
    userId : {
      bsonType: "int",
      description: "Identifier for the user who owns the expense"
    },
    name: {
      bsonType: "string",
      description: "Expense name"
    },
    amount: {
      bsonType: "double",
      minimum: 0,
      description: "Expense amount"
    },
    category: {
      bsonType: "string",
      enum: ["Food","Travel","Shopping","Medical","Bills","Entertainment","Misc"]
    },
    paymentMethod: {
      bsonType: "string",
      enum: ["Cash", "UPI", "Card", "NetBanking"]
    },
    date: {
      bsonType: "date",
      description: "Expense date"
    },
    month: {
      bsonType: "string",
      description: "Month name (derived)"
    },
    year: {
      bsonType: "int"
    },
    notes: {
      bsonType: "string"
    },
    createdAt: {
      bsonType: "date"
    }
  },
  required: ["name", "amount", "category", "date", "month", "year"]
};

export default expenseRegisterSchema;

/**
 * Serves:
 *  - expenseLogknowledge — find({ userId, date: {$gte,$lt} }).sort({ date: -1 })
 *  - fetchRecord         — { userId, date } equality
 *
 * NOT unique, unlike the other two registers: one row per expense, so several
 * documents legitimately share a (userId, date).
 */
export const EXPENSE_REGISTER_INDEXES = [
  { key: { userId: 1, date: -1 }, name: "userId_1_date_-1" },
];
