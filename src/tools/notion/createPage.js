import { Client } from "@notionhq/client";
import "dotenv/config";

const TASK_REGISTER = "taskRegister";
const EXPENSE_REGISTER = "expenseRegister"; 
const DIET_REGISTER = "dietRegister"; 

async function createTaskNotionPage(){
    try {
        const response = await notion.pages.create({
            parent: {
                type: "database_id",
                database_id: databaseId,
            },
            icon: emoji
                ? {
                    type: "emoji",
                    emoji: emoji,
                }
                : undefined,
            cover: coverUrl
                ? {
                    type: "external",
                    external: {
                        url: coverUrl,
                    },
                }
                : undefined,
            properties: {
                Name: {
                    title: [
                        {
                            text: {
                                content: name,
                            },
                        },
                    ],
                },
                Summary: {
                    rich_text: [
                        {
                            text: {
                                content: summary,
                            },
                        },
                    ],
                },
                "Overall Score": {
                    number: overallScore,
                },
            },
        });

        return {
            success: true,
            pageId: response.id,
        };
    } catch (error) {
        console.error("Error creating Notion page:", error);

        return {
            success: false,
            error: error.message,
        };
    }
}


const notion = new Client({
    auth: process.env.NOTION_API_KEY,
});

/**
 * Create a Notion page with name, summary, and overall score
 */
export async function createNotionPage( {
    databaseId,
    name,
    summary,
    overallScore,
    emoji,
    coverUrl,
}) {
    try {
        const response = await notion.pages.create({
            parent: {
                type: "database_id",
                database_id: databaseId,
            },
            icon: emoji
                ? {
                    type: "emoji",
                    emoji: emoji,
                }
                : undefined,
            cover: coverUrl
                ? {
                    type: "external",
                    external: {
                        url: coverUrl,
                    },
                }
                : undefined,
            properties: {
                Name: {
                    title: [
                        {
                            text: {
                                content: name,
                            },
                        },
                    ],
                },
                Summary: {
                    rich_text: [
                        {
                            text: {
                                content: summary,
                            },
                        },
                    ],
                },
                "Overall Score": {
                    number: overallScore,
                },
            },
        });

        return {
            success: true,
            pageId: response.id,
        };
    } catch (error) {
        console.error("Error creating Notion page:", error);

        return {
            success: false,
            error: error.message,
        };
    }
}
