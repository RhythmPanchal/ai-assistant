export class ToolResult {
    constructor(success, message, data = {}) {
        this.success = success;
        this.message = message;
        this.data = data;
    }

    toString() {
        const status = this.success ? "✅ Success" : "❌ Error";
        const dataStr = this.data && Object.keys(this.data).length > 0 ? `\nData: ${JSON.stringify(this.data)}` : "";
        return `${status}: ${this.message}${dataStr}`;
    }
}

export class BaseTool {
    static name = "";
    static description = "";
    static parameters = {};

    async execute(args) {
        throw new Error(`${this.constructor.name} must implement execute()`);
    }

    toFunctionDeclaration() {
        return {
            name: this.constructor.name,
            description: this.constructor.description,
            parameters: this.constructor.parameters,
        };
    }
}
