export type BotConfig = {
  id: string;
  agent: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  botName: string;
  project?: string;
};

export type GroupConfig = {
  id: string;
  chatId: string;
  name: string;
  bots: string[];
};

export type OpenplawFileConfig = {
  bots?: BotConfig[];
  groups?: GroupConfig[];
  agents?: {
    directory?: string;
    botAgentMap?: Record<string, string>;
  };
  mcp?: {
    servers?: Record<string, unknown>;
    autoRegister?: boolean;
  };
  verbose?: boolean;
};

export type SystemStatus = {
  bots: number;
  groups: number;
  mcpServers: number;
  agentsDir: string;
  uptime: number;
  projects: number;
  skills: number;
  commands: number;
  agents: number;
  totalMcps: number;
};

export type LogEntry = {
  timestamp: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
  source?: string;
};

export type LogResponse = {
  entries: LogEntry[];
  total: number;
  filtered: number;
};

export type AgentInfo = {
  name: string;
  filename: string;
  type: 'md' | 'json';
  exists: boolean;
};

export type AgentContent = {
  name: string;
  type: string;
  content: string;
};

export type McpServerEntry = {
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
};

export type McpResponse = {
  servers: McpServerEntry[];
  autoRegister: boolean;
};

export type ChatSession = {
  id: string;
  createdAt?: string;
  title?: string;
};

export type ChatMessage = {
  info: {
    role: 'user' | 'assistant' | 'system';
    sessionId?: string;
  };
  parts: Array<{
    type: 'text' | 'tool-invocation' | 'tool-result';
    text?: string;
    toolInvocation?: unknown;
    toolResult?: unknown;
  }>;
};

export type ResourceSkill = {
  name: string;
  content: string;
  source: 'project' | 'global';
  projectPath?: string;
};

export type ResourceCommand = {
  name: string;
  content: string;
  source: 'project' | 'global';
  projectPath?: string;
};

export type ResourceMcp = {
  name: string;
  config: Record<string, unknown>;
  source: 'project' | 'global';
  projectPath?: string;
};

export type ResourceAgent = {
  name: string;
  content: string;
  source: 'project' | 'global';
  projectPath?: string;
  filePath?: string;
};

export type ResourceAllResponse = {
  globalSkills: ResourceSkill[];
  globalCommands: ResourceCommand[];
  globalMcps: ResourceMcp[];
  globalAgents: ResourceAgent[];
  projects: Record<string, {
    projectPath: string;
    skills: ResourceSkill[];
    commands: ResourceCommand[];
    mcps: ResourceMcp[];
    agents: ResourceAgent[];
  }>;
  skills?: ResourceSkill[];
  commands?: ResourceCommand[];
  mcps?: ResourceMcp[];
  agents?: ResourceAgent[];
};