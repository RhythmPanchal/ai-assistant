import { toolRegistry } from "../ToolRegistry.js";

import { FetchCollectionNameAndSchemaTool } from "./FetchCollectionNameAndSchemaTool.js";
import { CreateCollectionTool } from "./CreateCollectionTool.js";
import { CreateRecordTool } from "./CreateRecordTool.js";
import { FetchRecordTool } from "./FetchRecordTool.js";
import { UpdateRecordsTool } from "./UpdateRecordsTool.js";
import { DeleteRecordTool } from "./DeleteRecordTool.js";
import { CreateTaskTool } from "./CreateTaskTool.js";
import { UpdateTaskStatusTool, DeferTaskTool } from "./TaskStateTools.js";
import { InsertScheduleTool } from "./InsertScheduleTool.js";
import { CreateOneTimeReminderTool, CreateMultiTimeReminderTool } from "./RemindersTool.js";
import { CompleteFlowTool } from "./CompleteFlowTool.js";
import { UpdateFlowScratchpadTool } from "./UpdateFlowScratchpadTool.js";
import { ConnectAppTool, DisconnectAppTool } from "./ConnectorTools.js";
import { RememberFactTool } from "./RememberFactTool.js";
import {
    FetchUserContextTool, UpdateUserSettingsTool, ForgetFactTool, ManageFactKeyTool,
} from "./ProfileTools.js";
import { LoadSkillTool } from "./LoadSkillTool.js";
import { allSkillToolNames } from "../../skills/index.js";

// Instantiate and register tools
toolRegistry.register(new FetchCollectionNameAndSchemaTool());
toolRegistry.register(new CreateCollectionTool());
toolRegistry.register(new CreateRecordTool());
toolRegistry.register(new FetchRecordTool());
toolRegistry.register(new UpdateRecordsTool());
toolRegistry.register(new DeleteRecordTool());
toolRegistry.register(new CreateTaskTool());
toolRegistry.register(new UpdateTaskStatusTool());
toolRegistry.register(new DeferTaskTool());
toolRegistry.register(new InsertScheduleTool());
toolRegistry.register(new CreateOneTimeReminderTool());
toolRegistry.register(new CreateMultiTimeReminderTool());
toolRegistry.register(new CompleteFlowTool());
toolRegistry.register(new UpdateFlowScratchpadTool());
toolRegistry.register(new ConnectAppTool());
toolRegistry.register(new DisconnectAppTool());
toolRegistry.register(new RememberFactTool());

// Reading a profile is always available; editing one is not.
toolRegistry.register(new FetchUserContextTool());
toolRegistry.register(new LoadSkillTool());

// Registered so they can be EXECUTED, undeclared so they are not advertised.
// A skill adds their declarations to a single turn when it loads. They are
// rarer, destructive or structural, and a declaration costs tokens on every
// request whether or not the turn has anything to do with a profile.
toolRegistry.register(new UpdateUserSettingsTool(), { declared: false });
toolRegistry.register(new ForgetFactTool(), { declared: false });
toolRegistry.register(new ManageFactKeyTool(), { declared: false });

// Every tool a skill can name must be registered above, or loading the skill
// widens the declaration list with something execute() cannot find — the model
// would then call a tool that always fails. Fails at boot rather than mid-turn.
const missing = allSkillToolNames().filter(n => !toolRegistry.getTool(n));
if (missing.length) {
    throw new Error(`[ToolRegistry] skills name unregistered tools: ${missing.join(", ")}`);
}

// SendMessageTool deliberately NOT registered: on main sendMessage is
// scheduler-only (via actionDispatcher). Exposing it would let the model send
// arbitrary Telegram messages, which it has never been able to do.

// Verify registration
console.log(`[ToolRegistry] Registered ${toolRegistry.getAllTools().length} tools.`);

export default toolRegistry;

