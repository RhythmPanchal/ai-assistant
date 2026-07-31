import { BaseTool, ToolResult } from "../BaseTool.js";
import { sendMessage } from "../../../tools/telegram/sendMessage.js";

export class SendMessageTool extends BaseTool {
    static name = "sendMessage";
    static description = "Send a Telegram message to a specific user.";
    static parameters = {
        type: "object",
        properties: {
            chatId: {
                type: "integer",
                description: "The Telegram chat ID to send the message to (same as userId for private chats)."
            },
            text: {
                type: "string",
                description: "The text message to send."
            }
        },
        required: ["chatId", "text"]
    };

    async execute({ chatId, text }) {
        const result = await sendMessage(chatId, text);
        return new ToolResult(true, `Sent message to chat ${chatId}`, result);
    }
}

