import { BaseTool, ToolResult } from "../BaseTool.js";
import { connectApp } from "../../../connectors/oauth/connectApp.js";
import { disconnectApp } from "../../../connectors/oauth/disconnectApp.js";

// appName list is the LLM's only view of what is connectable — keep in sync
// with PROVIDER_MAP in connectors/oauth/init.js.
const APP_NAME = {
    type: "string",
    description: "App identifier. Currently supported: gCalendar, notion.",
};

const USER_ID = { type: "integer", description: "Telegram chat ID of the user." };

export class ConnectAppTool extends BaseTool {
    static name = "connectApp";
    static description =
        "Sends a Connect button so the user can authorize a third-party app. Use whenever the user wants to connect, link, or re-enable an app (e.g. 'connect Google Calendar', 'I accidentally dismissed calendar, reconnect it'). Validates that the app is supported before sending.";
    static parameters = {
        type: "object",
        properties: { userId: USER_ID, appName: APP_NAME },
        required: ["userId", "appName"],
    };

    async execute({ userId, appName }) {
        const res = await connectApp(userId, appName);
        return new ToolResult(res.success, res.message, res);
    }
}

export class DisconnectAppTool extends BaseTool {
    static name = "disconnectApp";
    static description =
        "Disconnects a third-party app for the user — disables the connection and removes all stored tokens. Use when the user explicitly asks to disconnect, unlink, or revoke access for an app.";
    static parameters = {
        type: "object",
        properties: { userId: USER_ID, appName: APP_NAME },
        required: ["userId", "appName"],
    };

    async execute({ userId, appName }) {
        const res = await disconnectApp(userId, appName);
        return new ToolResult(res.success, res.message, res);
    }
}
