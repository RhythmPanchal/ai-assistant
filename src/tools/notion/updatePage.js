import { Client } from "@notionhq/client";
import "dotenv/config";

const notion = new Client({
    auth: process.env.NOTION_API_KEY,
});

export async function updateNotionPage({
    pageId,
    name,
    summary,
    overallScore,
    emoji,
    coverUrl,
}) {
    try {
        const response = await notion.pages.update({
            page_id: pageId,

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
                ...(name && {
                    Name: {
                        title: [
                            {
                                text: {
                                    content: name,
                                },
                            },
                        ],
                    },
                }),

                ...(summary && {
                    Summary: {
                        rich_text: [
                            {
                                text: {
                                    content: summary,
                                },
                            },
                        ],
                    },
                }),

                ...(overallScore !== undefined && {
                    "Overall Score": {
                        number: overallScore,
                    },
                }),
            },
        });

        return {
            success: true,
            pageId: response.id,
        };
    } catch (error) {
        console.error("Error updating Notion page:", error);

        return {
            success: false,
            error: error.message,
        };
    }
}
