import { ToolResult } from "./BaseTool.js";

export class ToolRegistry {
    constructor() {
        this._tools = new Map();
    }

    register(toolInstance) {
        this._tools.set(toolInstance.constructor.name, toolInstance);
    }

    getTool(name) {
        return this._tools.get(name);
    }

    getAllTools() {
        return Array.from(this._tools.values());
    }

    getToolDeclarations() {
        return this.getAllTools().map(t => t.toFunctionDeclaration());
    }

    async execute(toolName, args) {
        const tool = this.getTool(toolName);
        if (!tool) {
            return new ToolResult(false, `Unknown tool: '${toolName}'. Available: ${Array.from(this._tools.keys()).join(", ")}`);
        }

        try {
            return await tool.execute(args);
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            return new ToolResult(false, `Tool '${toolName}' crashed: ${error.message}`);
        }
    }
}

// Export a singleton instance
export const toolRegistry = new ToolRegistry();
