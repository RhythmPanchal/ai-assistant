import { ToolResult } from "./BaseTool.js";

export class ToolRegistry {
    constructor() {
        this._tools = new Map();
        // Registered and executable, but absent from getToolDeclarations(). A
        // skill adds these to a single turn's declarations when it loads; the
        // registry still has to know how to run them, because execution happens
        // through the same path either way.
        this._undeclared = new Set();
    }

    /**
     * @param {object}  toolInstance
     * @param {object}  [options]
     * @param {boolean} [options.declared] false to hide it from the default
     *                  declaration list — a skill-loaded tool.
     */
    register(toolInstance, { declared = true } = {}) {
        const name = toolInstance.constructor.name;
        this._tools.set(name, toolInstance);
        if (declared) this._undeclared.delete(name);
        else this._undeclared.add(name);
    }

    getTool(name) {
        return this._tools.get(name);
    }

    getAllTools() {
        return Array.from(this._tools.values());
    }

    /** What every request advertises. Skill-only tools are excluded. */
    getToolDeclarations() {
        return this.getAllTools()
            .filter(t => !this._undeclared.has(t.constructor.name))
            .map(t => t.toFunctionDeclaration());
    }

    /**
     * Declarations for a named subset, for a skill widening one turn's tool
     * list. Unknown names are skipped rather than throwing: a skill naming a
     * tool that no longer exists should lose that tool, not break the turn.
     */
    getDeclarationsFor(names = []) {
        return names
            .map(n => this._tools.get(n))
            .filter(Boolean)
            .map(t => t.toFunctionDeclaration());
    }

    isDeclared(name) {
        return this._tools.has(name) && !this._undeclared.has(name);
    }

    async execute(toolName, args) {
        const tool = this.getTool(toolName);
        if (!tool) {
            // Only names the model could legitimately have seen are listed — an
            // undeclared tool in this message would be an invitation to guess at
            // one it was never offered.
            const available = this.getAllTools()
                .map(t => t.constructor.name)
                .filter(n => !this._undeclared.has(n));
            return new ToolResult(false, `Unknown tool: '${toolName}'. Available: ${available.join(", ")}`);
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
