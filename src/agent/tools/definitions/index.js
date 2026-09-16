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
import { UpdateScheduleTool } from "./UpdateScheduleTool.js";
import { CreateOneTimeReminderTool, CreateMultiTimeReminderTool, CancelReminderTool } from "./RemindersTool.js";
import { CompleteFlowTool } from "./CompleteFlowTool.js";
import { UpdateFlowScratchpadTool } from "./UpdateFlowScratchpadTool.js";
import { ConnectAppTool, DisconnectAppTool } from "./ConnectorTools.js";
import { AddMealTool, ReplaceMealTool } from "./DietLogTools.js";
import { AddPerformedTaskTool } from "./TaskLogTools.js";
import { UpdateNotesTool, UpdateUserSettingsTool } from "./ProfileTools.js";
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
toolRegistry.register(new UpdateScheduleTool());
toolRegistry.register(new CreateOneTimeReminderTool());
toolRegistry.register(new CreateMultiTimeReminderTool());
toolRegistry.register(new CancelReminderTool());
toolRegistry.register(new CompleteFlowTool());
toolRegistry.register(new UpdateFlowScratchpadTool());
toolRegistry.register(new ConnectAppTool());
toolRegistry.register(new DisconnectAppTool());
toolRegistry.register(new AddMealTool());
toolRegistry.register(new ReplaceMealTool());
toolRegistry.register(new AddPerformedTaskTool());

// Declared, not skill-loaded. Notes are written reactively, in the middle of a
// conversation about something else, and a skill round trip in front of that is
// how the thing someone just said stops getting written down at all.
toolRegistry.register(new UpdateNotesTool());
toolRegistry.register(new LoadSkillTool());

// Registered so it can be EXECUTED, undeclared so it is not advertised. The
// userContextEnrichment skill adds its declaration to a single turn when it
// loads. Settings change rarely, and a declaration costs tokens on every
// request whether or not the turn has anything to do with one.
toolRegistry.register(new UpdateUserSettingsTool(), { declared: false });

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

