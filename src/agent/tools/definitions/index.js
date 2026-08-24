import { toolRegistry } from "../ToolRegistry.js";

import { FetchCollectionNameAndSchemaTool } from "./FetchCollectionNameAndSchemaTool.js";
import { CreateCollectionTool } from "./CreateCollectionTool.js";
import { CreateRecordTool } from "./CreateRecordTool.js";
import { FetchRecordTool } from "./FetchRecordTool.js";
import { UpdateRecordsTool } from "./UpdateRecordsTool.js";
import { DeleteRecordTool } from "./DeleteRecordTool.js";
import { CreateTaskTool } from "./CreateTaskTool.js";
import { InsertScheduleTool } from "./InsertScheduleTool.js";
import { CreateOneTimeReminderTool, CreateMultiTimeReminderTool } from "./RemindersTool.js";
import { CompleteFlowTool } from "./CompleteFlowTool.js";
import { UpdateFlowScratchpadTool } from "./UpdateFlowScratchpadTool.js";
import { ConnectAppTool, DisconnectAppTool } from "./ConnectorTools.js";
import { RememberFactTool } from "./RememberFactTool.js";

// Instantiate and register tools
toolRegistry.register(new FetchCollectionNameAndSchemaTool());
toolRegistry.register(new CreateCollectionTool());
toolRegistry.register(new CreateRecordTool());
toolRegistry.register(new FetchRecordTool());
toolRegistry.register(new UpdateRecordsTool());
toolRegistry.register(new DeleteRecordTool());
toolRegistry.register(new CreateTaskTool());
toolRegistry.register(new InsertScheduleTool());
toolRegistry.register(new CreateOneTimeReminderTool());
toolRegistry.register(new CreateMultiTimeReminderTool());
toolRegistry.register(new CompleteFlowTool());
toolRegistry.register(new UpdateFlowScratchpadTool());
toolRegistry.register(new ConnectAppTool());
toolRegistry.register(new DisconnectAppTool());
toolRegistry.register(new RememberFactTool());

// SendMessageTool deliberately NOT registered: on main sendMessage is
// scheduler-only (via actionDispatcher). Exposing it would let the model send
// arbitrary Telegram messages, which it has never been able to do.

// Verify registration
console.log(`[ToolRegistry] Registered ${toolRegistry.getAllTools().length} tools.`);

export default toolRegistry;

