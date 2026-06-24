import { toolRegistry } from "../ToolRegistry.js";

import { FetchCollectionNameAndSchemaTool } from "./FetchCollectionNameAndSchemaTool.js";
import { CreateCollectionTool } from "./CreateCollectionTool.js";
import { CreateRecordTool } from "./CreateRecordTool.js";
import { FetchRecordTool } from "./FetchRecordTool.js";
import { UpdateRecordsTool } from "./UpdateRecordsTool.js";
import { CreateTaskTool } from "./CreateTaskTool.js";
import { InsertScheduleTool } from "./InsertScheduleTool.js";
import { CreateOneTimeReminderTool, CreateMultiTimeReminderTool } from "./RemindersTool.js";
import { CompleteFlowTool } from "./CompleteFlowTool.js";
import { SendMessageTool } from "./SendMessageTool.js";
import { UpdateFlowScratchpadTool } from "./UpdateFlowScratchpadTool.js";

// Instantiate and register tools
toolRegistry.register(new FetchCollectionNameAndSchemaTool());
toolRegistry.register(new CreateCollectionTool());
toolRegistry.register(new CreateRecordTool());
toolRegistry.register(new FetchRecordTool());
toolRegistry.register(new UpdateRecordsTool());
toolRegistry.register(new CreateTaskTool());
toolRegistry.register(new InsertScheduleTool());
toolRegistry.register(new CreateOneTimeReminderTool());
toolRegistry.register(new CreateMultiTimeReminderTool());
toolRegistry.register(new CompleteFlowTool());
toolRegistry.register(new SendMessageTool());
toolRegistry.register(new UpdateFlowScratchpadTool());

// Verify registration
console.log(`[ToolRegistry] Registered ${toolRegistry.getAllTools().length} tools.`);

export default toolRegistry;

