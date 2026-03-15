import "dotenv/config";
import { getDB } from "../tools/mongo/mongoClient.js";
import { EXPENSE_REGISTER } from "../tools/mongo/schema/expenseRegisterSchema.js";
import { TASK_REGISTER } from "../tools/mongo/schema/taskRegisterSchema.js";
import { DIET_REGISTER } from "../tools/mongo/schema/dietRegisterSchema.js";

const now = new Date();

const dummyExpenses = [
  // --- MARCH 2026 ---
  { userId: 1136575387, name: "Dinner at Social", amount: 850.0, category: "Food", paymentMethod: "UPI", date: new Date("2026-03-15"), month: "March", year: 2026, notes: "Went out with friends", createdAt: new Date() },
  { userId: 1136575387, name: "Uber to Office", amount: 220.0, category: "Travel", paymentMethod: "UPI", date: new Date("2026-03-14"), month: "March", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Grocery - DMart", amount: 1450.0, category: "Shopping", paymentMethod: "Card", date: new Date("2026-03-13"), month: "March", year: 2026, notes: "Monthly grocery run", createdAt: new Date() },
  { userId: 1136575387, name: "Electricity Bill", amount: 1200.0, category: "Bills", paymentMethod: "NetBanking", date: new Date("2026-03-12"), month: "March", year: 2026, notes: "March electricity", createdAt: new Date() },
  { userId: 1136575387, name: "Lunch - Swiggy", amount: 340.0, category: "Food", paymentMethod: "UPI", date: new Date("2026-03-11"), month: "March", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Movie - PVR", amount: 560.0, category: "Entertainment", paymentMethod: "Card", date: new Date("2026-03-10"), month: "March", year: 2026, notes: "Watched with roommate", createdAt: new Date() },
  { userId: 1136575387, name: "Pharmacy", amount: 480.0, category: "Health", paymentMethod: "Cash", date: new Date("2026-03-09"), month: "March", year: 2026, notes: "Vitamins and meds", createdAt: new Date() },
  { userId: 1136575387, name: "Rapido Bike", amount: 95.0, category: "Travel", paymentMethod: "UPI", date: new Date("2026-03-08"), month: "March", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Zomato Breakfast", amount: 210.0, category: "Food", paymentMethod: "UPI", date: new Date("2026-03-07"), month: "March", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Amazon - Keyboard", amount: 2199.0, category: "Shopping", paymentMethod: "Card", date: new Date("2026-03-05"), month: "March", year: 2026, notes: "Mechanical keyboard", createdAt: new Date() },
  { userId: 1136575387, name: "Internet Bill", amount: 799.0, category: "Bills", paymentMethod: "NetBanking", date: new Date("2026-03-03"), month: "March", year: 2026, notes: "Airtel broadband", createdAt: new Date() },
  { userId: 1136575387, name: "Chai + Snacks", amount: 120.0, category: "Food", paymentMethod: "Cash", date: new Date("2026-03-01"), month: "March", year: 2026, notes: "", createdAt: new Date() },

  // --- FEBRUARY 2026 ---
  { userId: 1136575387, name: "Dinner - Barbeque Nation", amount: 1600.0, category: "Food", paymentMethod: "Card", date: new Date("2026-02-28"), month: "February", year: 2026, notes: "Birthday dinner", createdAt: new Date() },
  { userId: 1136575387, name: "Ola Cab", amount: 310.0, category: "Travel", paymentMethod: "UPI", date: new Date("2026-02-26"), month: "February", year: 2026, notes: "Airport drop", createdAt: new Date() },
  { userId: 1136575387, name: "Gym Membership", amount: 2000.0, category: "Health", paymentMethod: "NetBanking", date: new Date("2026-02-25"), month: "February", year: 2026, notes: "Monthly fee", createdAt: new Date() },
  { userId: 1136575387, name: "Zomato Lunch", amount: 380.0, category: "Food", paymentMethod: "UPI", date: new Date("2026-02-24"), month: "February", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Netflix Subscription", amount: 649.0, category: "Entertainment", paymentMethod: "Card", date: new Date("2026-02-22"), month: "February", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Grocery - Zepto", amount: 980.0, category: "Shopping", paymentMethod: "UPI", date: new Date("2026-02-20"), month: "February", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Water Jug Refill", amount: 60.0, category: "Misc", paymentMethod: "Cash", date: new Date("2026-02-18"), month: "February", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Rapido", amount: 85.0, category: "Travel", paymentMethod: "UPI", date: new Date("2026-02-17"), month: "February", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Mobile Recharge", amount: 299.0, category: "Bills", paymentMethod: "UPI", date: new Date("2026-02-15"), month: "February", year: 2026, notes: "Jio prepaid", createdAt: new Date() },
  { userId: 1136575387, name: "Headache Meds", amount: 150.0, category: "Health", paymentMethod: "Cash", date: new Date("2026-02-13"), month: "February", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Swiggy Dinner", amount: 420.0, category: "Food", paymentMethod: "UPI", date: new Date("2026-02-10"), month: "February", year: 2026, notes: "", createdAt: new Date() },
  { userId: 1136575387, name: "Amazon - Mouse Pad", amount: 399.0, category: "Shopping", paymentMethod: "Card", date: new Date("2026-02-07"), month: "February", year: 2026, notes: "", createdAt: new Date() },
];
const dummyTaskLogs = [
  // --- MARCH 2026 ---
  {
    userId: 1136575387,
    date: new Date("2026-03-15"),
    day: "Sunday",
    performedTasks: [
      { taskId: "t001", title: "Code Review", category: "Work", actualFrom: "10:00", actualTo: "11:30", actualDurationMinutes: 90, status: "Completed", focusLevel: 4, notes: "Reviewed PR for auth module" },
      { taskId: "t002", title: "Gym", category: "Health", actualFrom: "08:00", actualTo: "09:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 5, notes: "" },
      { taskId: "t003", title: "Read Tech Blog", category: "Learning", actualFrom: "20:00", actualTo: "20:45", actualDurationMinutes: 45, status: "Partial", focusLevel: 3, notes: "Got distracted halfway" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-14"),
    day: "Saturday",
    performedTasks: [
      { taskId: "t004", title: "System Design Study", category: "Learning", actualFrom: "11:00", actualTo: "13:00", actualDurationMinutes: 120, status: "Completed", focusLevel: 5, notes: "Studied distributed caching" },
      { taskId: "t005", title: "Grocery Shopping", category: "Personal", actualFrom: "17:00", actualTo: "17:45", actualDurationMinutes: 45, status: "Completed", focusLevel: 2, notes: "DMart run" },
      { taskId: "t006", title: "Evening Walk", category: "Health", actualFrom: "19:00", actualTo: "19:30", actualDurationMinutes: 30, status: "Skipped", focusLevel: 1, notes: "Too tired" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-13"),
    day: "Friday",
    performedTasks: [
      { taskId: "t007", title: "Backend API Development", category: "Work", actualFrom: "09:30", actualTo: "13:00", actualDurationMinutes: 210, status: "Completed", focusLevel: 5, notes: "Built payment webhook handler" },
      { taskId: "t008", title: "Team Standup", category: "Work", actualFrom: "09:00", actualTo: "09:30", actualDurationMinutes: 30, status: "Completed", focusLevel: 3, notes: "" },
      { taskId: "t009", title: "LeetCode", category: "Learning", actualFrom: "21:00", actualTo: "22:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 4, notes: "Solved 2 medium problems" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-12"),
    day: "Thursday",
    performedTasks: [
      { taskId: "t010", title: "Database Optimization", category: "Work", actualFrom: "10:00", actualTo: "12:30", actualDurationMinutes: 150, status: "Completed", focusLevel: 5, notes: "Optimized slow mongo queries" },
      { taskId: "t011", title: "Meditation", category: "Health", actualFrom: "07:30", actualTo: "08:00", actualDurationMinutes: 30, status: "Completed", focusLevel: 4, notes: "" },
      { taskId: "t012", title: "Call Parents", category: "Personal", actualFrom: "20:00", actualTo: "20:30", actualDurationMinutes: 30, status: "Completed", focusLevel: 3, notes: "Weekly call home to Ahmedabad" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-11"),
    day: "Wednesday",
    performedTasks: [
      { taskId: "t013", title: "Bug Fixing", category: "Work", actualFrom: "09:00", actualTo: "11:00", actualDurationMinutes: 120, status: "Completed", focusLevel: 4, notes: "Fixed race condition in job queue" },
      { taskId: "t014", title: "Gym", category: "Health", actualFrom: "07:00", actualTo: "08:00", actualDurationMinutes: 60, status: "Skipped", focusLevel: 1, notes: "Overslept" },
      { taskId: "t015", title: "Read Node.js Docs", category: "Learning", actualFrom: "21:30", actualTo: "22:15", actualDurationMinutes: 45, status: "Completed", focusLevel: 3, notes: "" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-10"),
    day: "Tuesday",
    performedTasks: [
      { taskId: "t016", title: "Sprint Planning", category: "Work", actualFrom: "10:00", actualTo: "11:30", actualDurationMinutes: 90, status: "Completed", focusLevel: 3, notes: "Planned tasks for next sprint" },
      { taskId: "t017", title: "Docker Setup", category: "Work", actualFrom: "14:00", actualTo: "16:30", actualDurationMinutes: 150, status: "Partial", focusLevel: 4, notes: "Containerized 2 of 3 services" },
      { taskId: "t018", title: "Evening Jog", category: "Health", actualFrom: "18:30", actualTo: "19:00", actualDurationMinutes: 30, status: "Completed", focusLevel: 4, notes: "" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-08"),
    day: "Sunday",
    performedTasks: [
      { taskId: "t019", title: "Side Project - AI Agent", category: "Learning", actualFrom: "11:00", actualTo: "14:00", actualDurationMinutes: 180, status: "Completed", focusLevel: 5, notes: "Built tool handler for Rasmalai" },
      { taskId: "t020", title: "Laundry", category: "Personal", actualFrom: "16:00", actualTo: "16:30", actualDurationMinutes: 30, status: "Completed", focusLevel: 1, notes: "" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-05"),
    day: "Thursday",
    performedTasks: [
      { taskId: "t021", title: "API Integration", category: "Work", actualFrom: "09:30", actualTo: "12:00", actualDurationMinutes: 150, status: "Completed", focusLevel: 5, notes: "Integrated Razorpay APIs" },
      { taskId: "t022", title: "LeetCode", category: "Learning", actualFrom: "21:00", actualTo: "21:45", actualDurationMinutes: 45, status: "Partial", focusLevel: 3, notes: "Stuck on DP problem" },
      { taskId: "t023", title: "Gym", category: "Health", actualFrom: "07:00", actualTo: "08:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 5, notes: "" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-03"),
    day: "Tuesday",
    performedTasks: [
      { taskId: "t024", title: "Code Refactoring", category: "Work", actualFrom: "10:00", actualTo: "12:30", actualDurationMinutes: 150, status: "Completed", focusLevel: 4, notes: "Cleaned up auth service" },
      { taskId: "t025", title: "Read Book", category: "Personal", actualFrom: "22:00", actualTo: "22:45", actualDurationMinutes: 45, status: "Completed", focusLevel: 3, notes: "Clean Code - chapter 4" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-01"),
    day: "Sunday",
    performedTasks: [
      { taskId: "t026", title: "Monthly Planning", category: "Personal", actualFrom: "10:00", actualTo: "11:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 4, notes: "Set goals for March" },
      { taskId: "t027", title: "Gym", category: "Health", actualFrom: "08:00", actualTo: "09:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 5, notes: "" },
    ],
    createdAt: new Date(),
  },

  // --- FEBRUARY 2026 ---
  {
    userId: 1136575387,
    date: new Date("2026-02-28"),
    day: "Saturday",
    performedTasks: [
      { taskId: "t028", title: "System Design Mock Interview", category: "Learning", actualFrom: "11:00", actualTo: "12:30", actualDurationMinutes: 90, status: "Completed", focusLevel: 5, notes: "Practiced with friend online" },
      { taskId: "t029", title: "Grocery", category: "Personal", actualFrom: "17:30", actualTo: "18:15", actualDurationMinutes: 45, status: "Completed", focusLevel: 2, notes: "" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-26"),
    day: "Thursday",
    performedTasks: [
      { taskId: "t030", title: "Microservices Architecture", category: "Work", actualFrom: "09:00", actualTo: "12:00", actualDurationMinutes: 180, status: "Completed", focusLevel: 5, notes: "Designed event-driven architecture" },
      { taskId: "t031", title: "Meditation", category: "Health", actualFrom: "07:30", actualTo: "08:00", actualDurationMinutes: 30, status: "Skipped", focusLevel: 1, notes: "Skipped, had early meeting" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-24"),
    day: "Tuesday",
    performedTasks: [
      { taskId: "t032", title: "Bug Fixing - Production", category: "Work", actualFrom: "09:00", actualTo: "13:00", actualDurationMinutes: 240, status: "Completed", focusLevel: 5, notes: "Critical prod fix for payment service" },
      { taskId: "t033", title: "Post Mortem Doc", category: "Work", actualFrom: "14:00", actualTo: "15:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 4, notes: "" },
      { taskId: "t034", title: "Gym", category: "Health", actualFrom: "07:00", actualTo: "08:00", actualDurationMinutes: 60, status: "Skipped", focusLevel: 1, notes: "Exhausted from prod issue" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-22"),
    day: "Sunday",
    performedTasks: [
      { taskId: "t035", title: "Side Project - AI Agent", category: "Learning", actualFrom: "10:00", actualTo: "13:00", actualDurationMinutes: 180, status: "Completed", focusLevel: 5, notes: "Set up MongoDB schemas" },
      { taskId: "t036", title: "Call Parents", category: "Personal", actualFrom: "19:00", actualTo: "19:30", actualDurationMinutes: 30, status: "Completed", focusLevel: 3, notes: "" },
      { taskId: "t037", title: "Read Book", category: "Personal", actualFrom: "22:00", actualTo: "22:30", actualDurationMinutes: 30, status: "Partial", focusLevel: 2, notes: "Fell asleep reading" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-20"),
    day: "Friday",
    performedTasks: [
      { taskId: "t038", title: "Team Standup", category: "Work", actualFrom: "09:00", actualTo: "09:30", actualDurationMinutes: 30, status: "Completed", focusLevel: 3, notes: "" },
      { taskId: "t039", title: "Redis Caching Implementation", category: "Work", actualFrom: "10:00", actualTo: "13:30", actualDurationMinutes: 210, status: "Completed", focusLevel: 5, notes: "Implemented session caching" },
      { taskId: "t040", title: "Evening Jog", category: "Health", actualFrom: "18:30", actualTo: "19:00", actualDurationMinutes: 30, status: "Completed", focusLevel: 4, notes: "" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-18"),
    day: "Wednesday",
    performedTasks: [
      { taskId: "t041", title: "LeetCode", category: "Learning", actualFrom: "07:00", actualTo: "08:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 4, notes: "Binary search problems" },
      { taskId: "t042", title: "API Documentation", category: "Work", actualFrom: "14:00", actualTo: "15:30", actualDurationMinutes: 90, status: "Completed", focusLevel: 3, notes: "Swagger docs for v2 APIs" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-15"),
    day: "Sunday",
    performedTasks: [
      { taskId: "t043", title: "Side Project Planning", category: "Learning", actualFrom: "11:00", actualTo: "12:30", actualDurationMinutes: 90, status: "Completed", focusLevel: 4, notes: "Planned Rasmalai agent features" },
      { taskId: "t044", title: "Gym", category: "Health", actualFrom: "08:00", actualTo: "09:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 5, notes: "" },
      { taskId: "t045", title: "Weekly Review", category: "Personal", actualFrom: "21:00", actualTo: "21:30", actualDurationMinutes: 30, status: "Completed", focusLevel: 3, notes: "Reviewed week's progress" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-13"),
    day: "Friday",
    performedTasks: [
      { taskId: "t046", title: "Kubernetes Study", category: "Learning", actualFrom: "21:00", actualTo: "22:30", actualDurationMinutes: 90, status: "Partial", focusLevel: 3, notes: "Covered pods and deployments" },
      { taskId: "t047", title: "Code Review", category: "Work", actualFrom: "15:00", actualTo: "16:00", actualDurationMinutes: 60, status: "Completed", focusLevel: 4, notes: "" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-10"),
    day: "Tuesday",
    performedTasks: [
      { taskId: "t048", title: "Feature Development", category: "Work", actualFrom: "09:30", actualTo: "13:00", actualDurationMinutes: 210, status: "Completed", focusLevel: 5, notes: "Built notification service" },
      { taskId: "t049", title: "Meditation", category: "Health", actualFrom: "07:30", actualTo: "08:00", actualDurationMinutes: 30, status: "Completed", focusLevel: 4, notes: "" },
      { taskId: "t050", title: "Read Book", category: "Personal", actualFrom: "22:00", actualTo: "22:45", actualDurationMinutes: 45, status: "Completed", focusLevel: 3, notes: "Clean Code - chapter 6" },
    ],
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-07"),
    day: "Saturday",
    performedTasks: [
      { taskId: "t051", title: "Side Project - AI Agent", category: "Learning", actualFrom: "10:00", actualTo: "14:00", actualDurationMinutes: 240, status: "Completed", focusLevel: 5, notes: "Integrated MCP tools" },
      { taskId: "t052", title: "Call Parents", category: "Personal", actualFrom: "19:00", actualTo: "19:30", actualDurationMinutes: 30, status: "Completed", focusLevel: 3, notes: "" },
    ],
    createdAt: new Date(),
  },
];
const dummyDietLogs = [
  // --- MARCH 2026 ---
  {
    userId: 1136575387,
    date: new Date("2026-03-15"),
    month: "March",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Poha", quantity: "1 bowl", calories: 250, protein: 5, carbs: 45, fat: 6 },
          { name: "Chai", quantity: "1 cup", calories: 60, protein: 2, carbs: 8, fat: 2 },
        ],
        mealCalories: 310,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Dal Rice", quantity: "1 plate", calories: 450, protein: 15, carbs: 80, fat: 8 },
          { name: "Salad", quantity: "1 bowl", calories: 80, protein: 2, carbs: 10, fat: 1 },
        ],
        mealCalories: 530,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Paneer Butter Masala", quantity: "1 bowl", calories: 400, protein: 18, carbs: 20, fat: 28 },
          { name: "Roti", quantity: "3 pieces", calories: 240, protein: 6, carbs: 48, fat: 3 },
        ],
        mealCalories: 640,
      },
      {
        mealType: "Snack",
        items: [
          { name: "Banana", quantity: "1 piece", calories: 90, protein: 1, carbs: 23, fat: 0 },
        ],
        mealCalories: 90,
      },
    ],
    dailyTotals: { caloriesConsumed: 1570, protein: 49, carbs: 234, fat: 48 },
    waterIntakeMl: 2500,
    adherenceScore: 4,
    notes: "Dinner was outside at Social, estimated calories",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-14"),
    month: "March",
    year: 2026,
    dietType: "Vegetarian",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Upma", quantity: "1 bowl", calories: 220, protein: 6, carbs: 38, fat: 5 },
          { name: "Orange Juice", quantity: "1 glass", calories: 110, protein: 1, carbs: 26, fat: 0 },
        ],
        mealCalories: 330,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Chole Rice", quantity: "1 plate", calories: 520, protein: 18, carbs: 90, fat: 10 },
        ],
        mealCalories: 520,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Khichdi", quantity: "1 bowl", calories: 350, protein: 12, carbs: 60, fat: 6 },
          { name: "Curd", quantity: "1 bowl", calories: 100, protein: 5, carbs: 8, fat: 4 },
        ],
        mealCalories: 450,
      },
    ],
    dailyTotals: { caloriesConsumed: 1300, protein: 42, carbs: 222, fat: 25 },
    waterIntakeMl: 3000,
    adherenceScore: 5,
    notes: "Good diet day",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-13"),
    month: "March",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Bread Omelette", quantity: "2 slices", calories: 320, protein: 18, carbs: 28, fat: 14 },
          { name: "Chai", quantity: "1 cup", calories: 60, protein: 2, carbs: 8, fat: 2 },
        ],
        mealCalories: 380,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Chicken Biryani", quantity: "1 plate", calories: 650, protein: 35, carbs: 85, fat: 18 },
          { name: "Raita", quantity: "1 bowl", calories: 80, protein: 4, carbs: 6, fat: 3 },
        ],
        mealCalories: 730,
      },
      {
        mealType: "Snack",
        items: [
          { name: "Protein Bar", quantity: "1 bar", calories: 200, protein: 20, carbs: 22, fat: 6 },
        ],
        mealCalories: 200,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Roti", quantity: "2 pieces", calories: 160, protein: 4, carbs: 32, fat: 2 },
          { name: "Dal Tadka", quantity: "1 bowl", calories: 250, protein: 14, carbs: 38, fat: 6 },
        ],
        mealCalories: 410,
      },
    ],
    dailyTotals: { caloriesConsumed: 1720, protein: 97, carbs: 181, fat: 51 },
    waterIntakeMl: 2000,
    adherenceScore: 3,
    notes: "Heavy lunch, skipped gym food plan",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-11"),
    month: "March",
    year: 2026,
    dietType: "Vegetarian",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Idli Sambar", quantity: "3 pieces", calories: 280, protein: 8, carbs: 52, fat: 4 },
        ],
        mealCalories: 280,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Swiggy Thali", quantity: "1 plate", calories: 600, protein: 20, carbs: 95, fat: 14 },
        ],
        mealCalories: 600,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Vegetable Soup", quantity: "1 bowl", calories: 150, protein: 5, carbs: 22, fat: 3 },
          { name: "Brown Bread", quantity: "2 slices", calories: 160, protein: 6, carbs: 28, fat: 2 },
        ],
        mealCalories: 310,
      },
    ],
    dailyTotals: { caloriesConsumed: 1190, protein: 39, carbs: 197, fat: 23 },
    waterIntakeMl: 2200,
    adherenceScore: 4,
    notes: "",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-08"),
    month: "March",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Paratha", quantity: "2 pieces", calories: 360, protein: 8, carbs: 55, fat: 12 },
          { name: "Curd", quantity: "1 bowl", calories: 100, protein: 5, carbs: 8, fat: 4 },
        ],
        mealCalories: 460,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Dal Rice", quantity: "1 plate", calories: 450, protein: 15, carbs: 80, fat: 8 },
        ],
        mealCalories: 450,
      },
      {
        mealType: "Snack",
        items: [
          { name: "Chai", quantity: "1 cup", calories: 60, protein: 2, carbs: 8, fat: 2 },
          { name: "Biscuits", quantity: "4 pieces", calories: 120, protein: 2, carbs: 18, fat: 4 },
        ],
        mealCalories: 180,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Egg Curry", quantity: "1 bowl", calories: 300, protein: 20, carbs: 12, fat: 18 },
          { name: "Roti", quantity: "3 pieces", calories: 240, protein: 6, carbs: 48, fat: 3 },
        ],
        mealCalories: 540,
      },
    ],
    dailyTotals: { caloriesConsumed: 1630, protein: 58, carbs: 229, fat: 51 },
    waterIntakeMl: 2800,
    adherenceScore: 3,
    notes: "Weekend, relaxed diet",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-05"),
    month: "March",
    year: 2026,
    dietType: "Vegetarian",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Oats", quantity: "1 bowl", calories: 200, protein: 8, carbs: 35, fat: 4 },
          { name: "Banana", quantity: "1 piece", calories: 90, protein: 1, carbs: 23, fat: 0 },
        ],
        mealCalories: 290,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Paneer Roti", quantity: "2 rotis", calories: 480, protein: 22, carbs: 55, fat: 18 },
          { name: "Salad", quantity: "1 bowl", calories: 80, protein: 2, carbs: 10, fat: 1 },
        ],
        mealCalories: 560,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Moong Dal Soup", quantity: "1 bowl", calories: 200, protein: 12, carbs: 30, fat: 3 },
          { name: "Roti", quantity: "2 pieces", calories: 160, protein: 4, carbs: 32, fat: 2 },
        ],
        mealCalories: 360,
      },
    ],
    dailyTotals: { caloriesConsumed: 1210, protein: 49, carbs: 185, fat: 28 },
    waterIntakeMl: 3200,
    adherenceScore: 5,
    notes: "Clean diet day, hit water goal",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-03-01"),
    month: "March",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Poha", quantity: "1 bowl", calories: 250, protein: 5, carbs: 45, fat: 6 },
        ],
        mealCalories: 250,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Chicken Curry", quantity: "1 bowl", calories: 400, protein: 30, carbs: 15, fat: 22 },
          { name: "Rice", quantity: "1 cup", calories: 200, protein: 4, carbs: 44, fat: 0 },
        ],
        mealCalories: 600,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Roti", quantity: "2 pieces", calories: 160, protein: 4, carbs: 32, fat: 2 },
          { name: "Sabzi", quantity: "1 bowl", calories: 180, protein: 4, carbs: 25, fat: 7 },
        ],
        mealCalories: 340,
      },
    ],
    dailyTotals: { caloriesConsumed: 1190, protein: 47, carbs: 161, fat: 37 },
    waterIntakeMl: 2000,
    adherenceScore: 3,
    notes: "Start of March, decent day",
    createdAt: new Date(),
  },

  // --- FEBRUARY 2026 ---
  {
    userId: 1136575387,
    date: new Date("2026-02-28"),
    month: "February",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Bread Omelette", quantity: "2 slices", calories: 320, protein: 18, carbs: 28, fat: 14 },
          { name: "Chai", quantity: "1 cup", calories: 60, protein: 2, carbs: 8, fat: 2 },
        ],
        mealCalories: 380,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Barbeque Nation Buffet", quantity: "1 meal", calories: 1200, protein: 60, carbs: 90, fat: 55 },
        ],
        mealCalories: 1200,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Fruit Bowl", quantity: "1 bowl", calories: 150, protein: 2, carbs: 35, fat: 1 },
        ],
        mealCalories: 150,
      },
    ],
    dailyTotals: { caloriesConsumed: 1730, protein: 82, carbs: 161, fat: 72 },
    waterIntakeMl: 1800,
    adherenceScore: 2,
    notes: "Birthday dinner, went overboard",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-26"),
    month: "February",
    year: 2026,
    dietType: "Vegetarian",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Oats with Milk", quantity: "1 bowl", calories: 280, protein: 10, carbs: 42, fat: 6 },
        ],
        mealCalories: 280,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Rajma Rice", quantity: "1 plate", calories: 550, protein: 22, carbs: 95, fat: 8 },
        ],
        mealCalories: 550,
      },
      {
        mealType: "Snack",
        items: [
          { name: "Apple", quantity: "1 piece", calories: 80, protein: 0, carbs: 21, fat: 0 },
          { name: "Peanuts", quantity: "handful", calories: 160, protein: 7, carbs: 6, fat: 13 },
        ],
        mealCalories: 240,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Vegetable Khichdi", quantity: "1 bowl", calories: 320, protein: 10, carbs: 58, fat: 5 },
        ],
        mealCalories: 320,
      },
    ],
    dailyTotals: { caloriesConsumed: 1390, protein: 49, carbs: 222, fat: 32 },
    waterIntakeMl: 3000,
    adherenceScore: 5,
    notes: "Good clean day",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-24"),
    month: "February",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Chai", quantity: "2 cups", calories: 120, protein: 4, carbs: 16, fat: 4 },
          { name: "Biscuits", quantity: "4 pieces", calories: 120, protein: 2, carbs: 18, fat: 4 },
        ],
        mealCalories: 240,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Office Canteen Thali", quantity: "1 plate", calories: 700, protein: 25, carbs: 110, fat: 16 },
        ],
        mealCalories: 700,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Zomato Butter Chicken", quantity: "1 bowl", calories: 450, protein: 35, carbs: 18, fat: 25 },
          { name: "Naan", quantity: "2 pieces", calories: 300, protein: 8, carbs: 52, fat: 6 },
        ],
        mealCalories: 750,
      },
    ],
    dailyTotals: { caloriesConsumed: 1690, protein: 74, carbs: 214, fat: 55 },
    waterIntakeMl: 1500,
    adherenceScore: 2,
    notes: "Stressful prod day, ate heavy",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-22"),
    month: "February",
    year: 2026,
    dietType: "Vegetarian",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Upma", quantity: "1 bowl", calories: 220, protein: 6, carbs: 38, fat: 5 },
          { name: "Chai", quantity: "1 cup", calories: 60, protein: 2, carbs: 8, fat: 2 },
        ],
        mealCalories: 280,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Dal Tadka Rice", quantity: "1 plate", calories: 480, protein: 18, carbs: 85, fat: 8 },
          { name: "Papad", quantity: "2 pieces", calories: 60, protein: 2, carbs: 10, fat: 1 },
        ],
        mealCalories: 540,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Roti", quantity: "2 pieces", calories: 160, protein: 4, carbs: 32, fat: 2 },
          { name: "Aloo Sabzi", quantity: "1 bowl", calories: 200, protein: 3, carbs: 35, fat: 7 },
        ],
        mealCalories: 360,
      },
    ],
    dailyTotals: { caloriesConsumed: 1180, protein: 35, carbs: 208, fat: 25 },
    waterIntakeMl: 2800,
    adherenceScore: 4,
    notes: "",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-20"),
    month: "February",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Boiled Eggs", quantity: "3 pieces", calories: 210, protein: 18, carbs: 2, fat: 14 },
          { name: "Brown Bread", quantity: "2 slices", calories: 160, protein: 6, carbs: 28, fat: 2 },
        ],
        mealCalories: 370,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Chicken Rice Bowl", quantity: "1 plate", calories: 580, protein: 40, carbs: 65, fat: 12 },
        ],
        mealCalories: 580,
      },
      {
        mealType: "Snack",
        items: [
          { name: "Protein Shake", quantity: "1 scoop", calories: 150, protein: 25, carbs: 8, fat: 2 },
        ],
        mealCalories: 150,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Salad", quantity: "1 large bowl", calories: 180, protein: 6, carbs: 20, fat: 8 },
          { name: "Soup", quantity: "1 bowl", calories: 120, protein: 4, carbs: 18, fat: 3 },
        ],
        mealCalories: 300,
      },
    ],
    dailyTotals: { caloriesConsumed: 1400, protein: 99, carbs: 141, fat: 41 },
    waterIntakeMl: 3500,
    adherenceScore: 5,
    notes: "Post gym nutrition on point",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-15"),
    month: "February",
    year: 2026,
    dietType: "Vegetarian",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Poha", quantity: "1 bowl", calories: 250, protein: 5, carbs: 45, fat: 6 },
          { name: "Chai", quantity: "1 cup", calories: 60, protein: 2, carbs: 8, fat: 2 },
        ],
        mealCalories: 310,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Paneer Paratha", quantity: "2 pieces", calories: 520, protein: 20, carbs: 62, fat: 20 },
          { name: "Curd", quantity: "1 bowl", calories: 100, protein: 5, carbs: 8, fat: 4 },
        ],
        mealCalories: 620,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Vegetable Pulao", quantity: "1 bowl", calories: 320, protein: 8, carbs: 60, fat: 6 },
          { name: "Raita", quantity: "1 bowl", calories: 80, protein: 4, carbs: 6, fat: 3 },
        ],
        mealCalories: 400,
      },
    ],
    dailyTotals: { caloriesConsumed: 1330, protein: 44, carbs: 189, fat: 41 },
    waterIntakeMl: 2400,
    adherenceScore: 4,
    notes: "",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-10"),
    month: "February",
    year: 2026,
    dietType: "Mixed",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Paratha", quantity: "2 pieces", calories: 360, protein: 8, carbs: 55, fat: 12 },
          { name: "Pickle", quantity: "1 tbsp", calories: 20, protein: 0, carbs: 2, fat: 1 },
        ],
        mealCalories: 380,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Mutton Curry", quantity: "1 bowl", calories: 480, protein: 38, carbs: 10, fat: 30 },
          { name: "Rice", quantity: "1 cup", calories: 200, protein: 4, carbs: 44, fat: 0 },
        ],
        mealCalories: 680,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Roti", quantity: "2 pieces", calories: 160, protein: 4, carbs: 32, fat: 2 },
          { name: "Dal", quantity: "1 bowl", calories: 220, protein: 12, carbs: 35, fat: 4 },
        ],
        mealCalories: 380,
      },
    ],
    dailyTotals: { caloriesConsumed: 1440, protein: 66, carbs: 178, fat: 49 },
    waterIntakeMl: 2000,
    adherenceScore: 3,
    notes: "Heavy lunch",
    createdAt: new Date(),
  },
  {
    userId: 1136575387,
    date: new Date("2026-02-07"),
    month: "February",
    year: 2026,
    dietType: "Vegetarian",
    meals: [
      {
        mealType: "Breakfast",
        items: [
          { name: "Oats with Banana", quantity: "1 bowl", calories: 290, protein: 9, carbs: 55, fat: 4 },
        ],
        mealCalories: 290,
      },
      {
        mealType: "Lunch",
        items: [
          { name: "Chole Bhature", quantity: "1 plate", calories: 700, protein: 20, carbs: 100, fat: 22 },
        ],
        mealCalories: 700,
      },
      {
        mealType: "Snack",
        items: [
          { name: "Green Tea", quantity: "1 cup", calories: 5, protein: 0, carbs: 1, fat: 0 },
          { name: "Roasted Chana", quantity: "handful", calories: 130, protein: 8, carbs: 18, fat: 3 },
        ],
        mealCalories: 135,
      },
      {
        mealType: "Dinner",
        items: [
          { name: "Khichdi", quantity: "1 bowl", calories: 350, protein: 12, carbs: 60, fat: 6 },
        ],
        mealCalories: 350,
      },
    ],
    dailyTotals: { caloriesConsumed: 1475, protein: 49, carbs: 234, fat: 35 },
    waterIntakeMl: 2600,
    adherenceScore: 3,
    notes: "Chole bhature was too heavy for lunch",
    createdAt: new Date(),
  },
];

const db = await getDB();
await db.collection(DIET_REGISTER).insertMany(dummyDietLogs);
console.log("Inserted", dummyDietLogs.length, "records");
