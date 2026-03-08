import "dotenv/config";
import { getDB } from "../tools/mongo/mongoClient.js";
import testValidatorSchema from "../tools/mongo/schema/testValidator.js";
import fetchCollectionNameAndSchema from "../tools/mongo/fetchCollectionSchema.js";
import ValidateSchema from "../tools/mongo/validateSchema.js";
import { valid } from "semver";

const tests = [
        // ===== VALID CASES =====
        {
            name: "Valid task - all fields",
            collectionName: "taskCalendar",
            data: {
                id: "task_1",
                userId: "user_123",
                title: "Complete project",
                requiredMinutes: 120,
                importance: "High",
                priorityScore: 5,
                category: "Work",
                deadline: new Date("2026-03-01T10:00:00Z"),
                status: "Pending",
                recurring: "weekly",
                scheduledEventId: "event_456",
                createdAt: new Date("2026-02-01T08:00:00Z"),
                updatedAt: new Date("2026-02-01T08:00:00Z")
            },
            shouldPass: true
        },
        {
            name: "Valid task - only required fields",
            collectionName: "taskCalendar",
            data: {
                id: "task_2",
                userId: "user_456",
                title: "Buy groceries",
                status: "Completed",
                createdAt: new Date("2026-02-05T12:00:00Z")
            },
            shouldPass: true
        },
        {
            name: "Valid task - null optional fields",
            collectionName: "taskCalendar",
            data: {
                id: "task_3",
                userId: "user_789",
                title: "Read book",
                requiredMinutes: null,
                importance: null,
                priorityScore: null,
                category: null,
                deadline: null,
                status: "Pending",
                recurring: null,
                scheduledEventId: null,
                createdAt: new Date("2026-02-06T14:00:00Z"),
                updatedAt: new Date("2026-02-06T14:00:00Z")
            },
            shouldPass: true
        },
        {
            name: "Valid task - extra fields allowed",
            collectionName: "taskCalendar",
            data: {
                id: "task_4",
                userId: "user_101",
                title: "Morning workout",
                status: "Scheduled",
                createdAt: new Date("2026-02-07T06:00:00Z"),
                extraField1: "This should be ignored",
                extraField2: 12345,
                extraField3: { nested: "object" }
            },
            shouldPass: true
        },
        {
            name: "Valid task - all enum values for importance",
            collectionName: "taskCalendar",
            data: {
                id: "task_5",
                userId: "user_102",
                title: "Low priority task",
                importance: "Low",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Valid task - all enum values for status",
            collectionName: "taskCalendar",
            data: {
                id: "task_6",
                userId: "user_103",
                title: "Cancelled meeting",
                status: "Cancelled",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Valid task - all recurring options",
            collectionName: "taskCalendar",
            data: {
                id: "task_7",
                userId: "user_104",
                title: "Monthly review",
                status: "Scheduled",
                recurring: "monthly",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Valid task - boundary value for requiredMinutes (minimum)",
            collectionName: "taskCalendar",
            data: {
                id: "task_8",
                userId: "user_105",
                title: "Quick task",
                requiredMinutes: 1,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Valid task - boundary value for priorityScore (minimum)",
            collectionName: "taskCalendar",
            data: {
                id: "task_9",
                userId: "user_106",
                title: "Low priority",
                priorityScore: 1,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Valid task - boundary value for priorityScore (maximum)",
            collectionName: "taskCalendar",
            data: {
                id: "task_10",
                userId: "user_107",
                title: "Highest priority",
                priorityScore: 5,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },

        // ===== MISSING REQUIRED FIELDS =====
        {
            name: "Missing required field - id",
            collectionName: "taskCalendar",
            data: {
                userId: "user_201",
                title: "Task without id",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "id is required but not present in userData"
        },
        {
            name: "Missing required field - userId",
            collectionName: "taskCalendar",
            data: {
                id: "task_20",
                title: "Task without userId",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "userId is required but not present in userData"
        },
        {
            name: "Missing required field - title",
            collectionName: "taskCalendar",
            data: {
                id: "task_21",
                userId: "user_202",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "title is required but not present in userData"
        },
        {
            name: "Missing required field - status",
            collectionName: "taskCalendar",
            data: {
                id: "task_22",
                userId: "user_203",
                title: "Task without status",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "status is required but not present in userData"
        },
        {
            name: "Missing required field - createdAt",
            collectionName: "taskCalendar",
            data: {
                id: "task_23",
                userId: "user_204",
                title: "Task without createdAt",
                status: "Pending"
            },
            shouldPass: false,
            expectedError: "createdAt is required but not present in userData"
        },
        {
            name: "Missing all required fields",
            collectionName: "taskCalendar",
            data: {
                requiredMinutes: 60,
                importance: "Medium"
            },
            shouldPass: false,
            expectedError: "id is required but not present in userData"
        },

        // ===== INVALID TYPES =====
        {
            name: "Invalid type - id should be string",
            collectionName: "taskCalendar",
            data: {
                id: 12345,
                userId: "user_301",
                title: "Task with numeric id",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'id' must be a string"
        },
        {
            name: "Invalid type - userId should be string",
            collectionName: "taskCalendar",
            data: {
                id: "task_30",
                userId: 999,
                title: "Task with numeric userId",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'userId' must be a string"
        },
        {
            name: "Invalid type - title should be string",
            collectionName: "taskCalendar",
            data: {
                id: "task_31",
                userId: "user_302",
                title: 12345,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'title' must be a string"
        },
        {
            name: "Invalid type - requiredMinutes should be int",
            collectionName: "taskCalendar",
            data: {
                id: "task_32",
                userId: "user_303",
                title: "Task with float minutes",
                requiredMinutes: 45.5,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'requiredMinutes' must be an integer"
        },
        {
            name: "Invalid type - requiredMinutes string instead of int",
            collectionName: "taskCalendar",
            data: {
                id: "task_33",
                userId: "user_304",
                title: "Task with string minutes",
                requiredMinutes: "60",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'requiredMinutes' has invalid type"
        },
        {
            name: "Invalid type - priorityScore should be int",
            collectionName: "taskCalendar",
            data: {
                id: "task_34",
                userId: "user_305",
                title: "Task with float priority",
                priorityScore: 3.5,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'priorityScore' must be an integer"
        },
        {
            name: "Invalid type - deadline should be date",
            collectionName: "taskCalendar",
            data: {
                id: "task_35",
                userId: "user_306",
                title: "Task with string deadline",
                deadline: "2026-03-01",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'deadline' must be a valid Date object"
        },
        {
            name: "Invalid type - createdAt should be date",
            collectionName: "taskCalendar",
            data: {
                id: "task_36",
                userId: "user_307",
                title: "Task with string createdAt",
                status: "Pending",
                createdAt: "2026-02-01T08:00:00Z"
            },
            shouldPass: false,
            expectedError: "Field 'createdAt' must be a valid Date object"
        },
        {
            name: "Invalid type - createdAt invalid Date object",
            collectionName: "taskCalendar",
            data: {
                id: "task_37",
                userId: "user_308",
                title: "Task with invalid date",
                status: "Pending",
                createdAt: new Date("invalid")
            },
            shouldPass: false,
            expectedError: "Field 'createdAt' must be a valid Date object"
        },

        // ===== INVALID ENUM VALUES =====
        {
            name: "Invalid enum - status not in allowed values",
            collectionName: "taskCalendar",
            data: {
                id: "task_40",
                userId: "user_401",
                title: "Task with invalid status",
                status: "InProgress",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'status' must be one of [Pending, Scheduled, Completed, Cancelled]"
        },
        {
            name: "Invalid enum - importance not in allowed values",
            collectionName: "taskCalendar",
            data: {
                id: "task_41",
                userId: "user_402",
                title: "Task with invalid importance",
                importance: "Critical",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'importance' must be one of [Low, Medium, High, null]"
        },
        {
            name: "Invalid enum - recurring not in allowed values",
            collectionName: "taskCalendar",
            data: {
                id: "task_42",
                userId: "user_403",
                title: "Task with invalid recurring",
                recurring: "biweekly",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'recurring' must be one of [hourly, daily, weekly, monthly, annually, null]"
        },
        {
            name: "Invalid enum - status is null (not allowed)",
            collectionName: "taskCalendar",
            data: {
                id: "task_43",
                userId: "user_404",
                title: "Task with null status",
                status: null,
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'status' cannot be null"
        },

        // ===== BOUNDARY VIOLATIONS =====
        {
            name: "Boundary violation - requiredMinutes below minimum",
            collectionName: "taskCalendar",
            data: {
                id: "task_50",
                userId: "user_501",
                title: "Task with 0 minutes",
                requiredMinutes: 0,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'requiredMinutes' must be >= 1"
        },
        {
            name: "Boundary violation - requiredMinutes negative",
            collectionName: "taskCalendar",
            data: {
                id: "task_51",
                userId: "user_502",
                title: "Task with negative minutes",
                requiredMinutes: -10,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'requiredMinutes' must be >= 1"
        },
        {
            name: "Boundary violation - priorityScore below minimum",
            collectionName: "taskCalendar",
            data: {
                id: "task_52",
                userId: "user_503",
                title: "Task with 0 priority",
                priorityScore: 0,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'priorityScore' must be >= 1"
        },
        {
            name: "Boundary violation - priorityScore above maximum",
            collectionName: "taskCalendar",
            data: {
                id: "task_53",
                userId: "user_504",
                title: "Task with priority 6",
                priorityScore: 6,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'priorityScore' must be <= 5"
        },
        {
            name: "Boundary violation - priorityScore way above maximum",
            collectionName: "taskCalendar",
            data: {
                id: "task_54",
                userId: "user_505",
                title: "Task with priority 100",
                priorityScore: 100,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'priorityScore' must be <= 5"
        },

        // ===== NULL/UNDEFINED HANDLING =====
        {
            name: "Null value - importance can be null",
            collectionName: "taskCalendar",
            data: {
                id: "task_60",
                userId: "user_601",
                title: "Task with null importance",
                importance: null,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Undefined value - optional field omitted",
            collectionName: "taskCalendar",
            data: {
                id: "task_61",
                userId: "user_602",
                title: "Task without optional fields",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Null value - required field cannot be null",
            collectionName: "taskCalendar",
            data: {
                id: "task_62",
                userId: "user_603",
                title: null,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: false,
            expectedError: "Field 'title' cannot be null"
        },

        // ===== EDGE CASES =====
        {
            name: "Empty strings - id",
            collectionName: "taskCalendar",
            data: {
                id: "",
                userId: "user_701",
                title: "Task with empty id",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true // Empty string is still a valid string type
        },
        {
            name: "Empty strings - title",
            collectionName: "taskCalendar",
            data: {
                id: "task_71",
                userId: "user_702",
                title: "",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true // Empty string is still a valid string type
        },
        {
            name: "Very long string - title",
            collectionName: "taskCalendar",
            data: {
                id: "task_72",
                userId: "user_703",
                title: "A".repeat(10000),
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Special characters in strings",
            collectionName: "taskCalendar",
            data: {
                id: "task_73",
                userId: "user_704",
                title: "Task with émojis 🎉 and spëcial çhars!@#$%^&*()",
                category: "Work/Life-Balance",
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Very large integer - requiredMinutes",
            collectionName: "taskCalendar",
            data: {
                id: "task_74",
                userId: "user_705",
                title: "Long task",
                requiredMinutes: 999999999,
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "Date in past",
            collectionName: "taskCalendar",
            data: {
                id: "task_75",
                userId: "user_706",
                title: "Historical task",
                deadline: new Date("2000-01-01T00:00:00Z"),
                status: "Completed",
                createdAt: new Date("1999-12-31T23:59:59Z")
            },
            shouldPass: true
        },
        {
            name: "Date in far future",
            collectionName: "taskCalendar",
            data: {
                id: "task_76",
                userId: "user_707",
                title: "Future task",
                deadline: new Date("2099-12-31T23:59:59Z"),
                status: "Pending",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "All recurring options - hourly",
            collectionName: "taskCalendar",
            data: {
                id: "task_77",
                userId: "user_708",
                title: "Hourly task",
                recurring: "hourly",
                status: "Scheduled",
                createdAt: new Date()
            },
            shouldPass: true
        },
        {
            name: "All recurring options - annually",
            collectionName: "taskCalendar",
            data: {
                id: "task_78",
                userId: "user_709",
                title: "Annual task",
                recurring: "annually",
                status: "Scheduled",
                createdAt: new Date()
            },
            shouldPass: true
        }
    ];


// Test runner function
async function runTests() {
    console.log("=".repeat(80));
    console.log("RUNNING TASK CALENDAR SCHEMA VALIDATION TESTS");
    console.log("=".repeat(80));
    console.log();

    let passedTests = 0;
    let failedTests = 0;
    const failedTestDetails = [];

    // CHANGE: Use for...of instead of forEach to properly handle async/await
    for (let index = 0; index < tests.length; index++) {
        const test = tests[index];
        let validationError = null;
        let validationPassed = false;

        // Try to run validation
        try {
            await ValidateSchema(test.collectionName, test.data);
            validationPassed = true;
        } catch (error) {
            validationError = error;
            validationPassed = false;
        }

        // Check if result matches expectation
        if (test.shouldPass && validationPassed) {
            // Expected to pass and it passed
            console.log(`✓ Test ${index + 1}: ${test.name} - PASSED`);
            passedTests++;
        } else if (!test.shouldPass && !validationPassed) {
            // Expected to fail and it failed - check error message
            const errorMatches = test.expectedError 
                ? validationError.message.includes(test.expectedError)
                : true;
            
            if (errorMatches) {
                console.log(`✓ Test ${index + 1}: ${test.name} - PASSED (Correctly failed: ${validationError.message})`);
                passedTests++;
            } else {
                console.log(`✗ Test ${index + 1}: ${test.name} - FAILED (Wrong error message)`);
                console.log(`   Expected: ${test.expectedError}`);
                console.log(`   Got: ${validationError.message}`);
                failedTests++;
                failedTestDetails.push({
                    testNumber: index + 1,
                    testName: test.name,
                    reason: "Wrong error message",
                    expectedError: test.expectedError,
                    actualError: validationError.message
                });
            }
        } else if (test.shouldPass && !validationPassed) {
            // Expected to pass but it failed
            console.log(`✗ Test ${index + 1}: ${test.name} - FAILED (Unexpected error: ${validationError.message})`);
            failedTests++;
            failedTestDetails.push({
                testNumber: index + 1,
                testName: test.name,
                reason: "Unexpected error",
                error: validationError.message
            });
        } else {
            // Expected to fail but it passed
            console.log(`✗ Test ${index + 1}: ${test.name} - FAILED (Expected error but validation passed)`);
            failedTests++;
            failedTestDetails.push({
                testNumber: index + 1,
                testName: test.name,
                reason: "Expected error but validation passed",
                expectedError: test.expectedError
            });
        }
    }

    console.log();
    console.log("=".repeat(80));
    console.log("TEST SUMMARY");
    console.log("=".repeat(80));
    console.log(`Total Tests: ${tests.length}`);
    console.log(`Passed: ${passedTests} (${((passedTests / tests.length) * 100).toFixed(2)}%)`);
    console.log(`Failed: ${failedTests} (${((failedTests / tests.length) * 100).toFixed(2)}%)`);
    console.log();

    if (failedTests > 0) {
        console.log("=".repeat(80));
        console.log("FAILED TEST DETAILS");
        console.log("=".repeat(80));
        failedTestDetails.forEach(detail => {
            console.log(`Test ${detail.testNumber}: ${detail.testName}`);
            console.log(`  Reason: ${detail.reason}`);
            if (detail.expectedError) {
                console.log(`  Expected Error: ${detail.expectedError}`);
            }
            if (detail.actualError) {
                console.log(`  Actual Error: ${detail.actualError}`);
            }
            if (detail.error) {
                console.log(`  Error: ${detail.error}`);
            }
            console.log();
        });
    }

    return {
        total: tests.length,
        passed: passedTests,
        failed: failedTests,
        successRate: ((passedTests / tests.length) * 100).toFixed(2) + "%"
    };
}

// Run tests if this is the main module
runTests();