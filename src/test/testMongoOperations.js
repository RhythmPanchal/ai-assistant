import "dotenv/config";
import { fetchRecord } from "../tools/mongo/fetchRecords.js";
import { dispatchAction } from "../scheduler/actionDispatcher.js";

const USER_ID = 1136575387;

// ================================================================
// BASIC FETCH TESTS
// ================================================================

// 1. Fetch all expenses this month
const test1 = await dispatchAction( "fetchRecord" , {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    date: { $gte: "2026-03-01", $lt: "2026-04-01" }
  }
} ); 

// 2. Fetch all task logs last 7 days
const test2 = await dispatchAction( "fetchRecord", {
  collection: "taskRegister",
  filters: {
    userId: USER_ID,
    date: { $gte: "2026-03-15", $lt: "2026-03-24" }
  }
});

// 3. Fetch all diet logs last 7 days
const test3 = await dispatchAction("fetchRecord" , {
  collection: "dietRegister",
  filters: {
    userId: USER_ID,
    date: { $gte: "2026-03-05", $lt: "2026-03-24" }
  }
});

// ================================================================
// FILTER TESTS
// ================================================================

// 4. Fetch only Food expenses
const test4 = await dispatchAction("fetchRecord", {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    category: "Food"
  }
});

// 5. Fetch expenses paid via UPI only
const test5 = await dispatchAction("fetchRecord", {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    paymentMethod: "UPI"
  }
});

// 6. Fetch expenses above 500
const test6 = await dispatchAction("fetchRecord", {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    amount: { $gt: 500 }
  }
});

// 7. Fetch expenses between 100 and 500
const test7 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    amount: { $gte: 100, $lte: 500 }
  }
});

// 8. Fetch multiple categories using $in
const test8 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    category: { $in: ["Food", "Travel"] }
  }
});

// 9. Fetch diet logs with adherenceScore >= 4 (good diet days)
const test9 = await dispatchAction("fetchRecord" , {
  collection: "dietRegister",
  filters: {
    userId: USER_ID,
    adherenceScore: { $gte: 4 }
  }
});

// 10. Fetch diet logs with low adherence (bad diet days)
const test10 = await dispatchAction("fetchRecord" , {
  collection: "dietRegister",
  filters: {
    userId: USER_ID,
    adherenceScore: { $lte: 2 }
  }
});

// 11. Fetch only Vegetarian diet days
const test11 = await dispatchAction("fetchRecord" , {
  collection: "dietRegister",
  filters: {
    userId: USER_ID,
    dietType: "Vegetarian"
  }
});

// ================================================================
// SORT TESTS
// ================================================================

// 12. Fetch expenses oldest to newest (asc)
const test12 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: { userId: USER_ID },
  sortBy: "date",
  sortOrder: "asc"
});

// 13. Fetch expenses sorted by amount highest to lowest
const test13 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: { userId: USER_ID },
  sortBy: "amount",
  sortOrder: "desc"
});

// 14. Fetch diet logs sorted by calories highest to lowest
const test14 = await dispatchAction("fetchRecord" , {
  collection: "dietRegister",
  filters: { userId: USER_ID },
  sortBy: "dailyTotals.caloriesConsumed",
  sortOrder: "desc"
});

// ================================================================
// LIMIT TESTS
// ================================================================

// 15. Fetch only last 3 expenses
const test15 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: { userId: USER_ID },
  sortBy: "date",
  sortOrder: "desc",
  limit: 3
});

// 16. Fetch only 1 record (latest diet log)
const test16 = await dispatchAction("fetchRecord" , {
  collection: "dietRegister",
  filters: { userId: USER_ID },
  limit: 1
});

// ================================================================
// COMBINED FILTER + SORT + LIMIT TESTS
// ================================================================

// 17. Top 5 most expensive Food expenses
const test17 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    category: "Food"
  },
  sortBy: "amount",
  sortOrder: "desc",
  limit: 5
});

// 18. Last 5 task logs sorted newest first
const test18 = await dispatchAction("fetchRecord" , {
  collection: "taskRegister",
  filters: { userId: USER_ID },
  sortBy: "date",
  sortOrder: "desc",
  limit: 5
});

// 19. February expenses only, sorted by amount desc
const test19 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    date: { $gte: "2026-02-01", $lt: "2026-03-01" }
  },
  sortBy: "amount",
  sortOrder: "desc"
}); 

// ================================================================
// EDGE / FAILURE TESTS
// ================================================================

// 20. Invalid collection — should throw whitelist error
try {
  await dispatchAction("fetchRecord" , {
    collection: "userSecrets",
    filters: { userId: USER_ID }
  });
} catch (e) {
  console.log("TEST 20 PASSED — whitelist blocked:", e.message);
}

// 21. Invalid operator — should throw operator error
try {
  await dispatchAction("fetchRecord" , {
    collection: "expenseRegister",
    filters: {
      userId: USER_ID,
      amount: { $where: "this.amount > 100" }
    }
  });
} catch (e) {
  console.log("TEST 21 PASSED — operator blocked:", e.message);
}

// 22. Empty filters — returns all records for no userId (stress test, limit it)
const test22 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: {},
  limit: 5
});


// 23. No matching records — should return empty array not crash
const test23 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    category: "Health",
    amount: { $gt: 99999 }
  }
});

// 24. $nin test — everything except Food and Travel
const test24 = await dispatchAction("fetchRecord" , {
  collection: "expenseRegister",
  filters: {
    userId: USER_ID,
    category: { $nwvewvn: ["Food", "Travel"] }
  }
});

