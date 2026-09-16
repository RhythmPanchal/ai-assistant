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
    /**
     * True only for a tool that reads and changes nothing. runAgent never
     * repeats an identical successful call to a tool that is NOT read-only
     * within one turn, so the default is the safe one: a new tool is guarded
     * until someone decides it only reads. A read is always re-run — after a
     * write, the fresh answer is the whole point of asking again.
     */
    static readOnly = false;

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
