import type { BotConfig, GroupConfig, OpenplawFileConfig, SystemStatus, ChatSession, ChatMessage, LogResponse, AgentInfo, AgentContent, McpResponse, ResourceSkill, ResourceCommand, ResourceMcp, ResourceAgent, ResourceAllResponse } from './types';

const API_BASE = '/api';

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const configApi = {
  getOpenplaw: () => fetchApi<OpenplawFileConfig>('/config/openplaw'),
  putOpenplaw: (config: OpenplawFileConfig) =>
    fetchApi<{ ok: boolean }>('/config/openplaw', { method: 'PUT', body: JSON.stringify(config) }),
  getMerged: () => fetchApi<unknown>('/config/merged'),
  getOpencode: () => fetchApi<Record<string, unknown>>('/config/opencode'),
  putOpencode: (config: Record<string, unknown>) =>
    fetchApi<{ ok: boolean }>('/config/opencode', { method: 'PUT', body: JSON.stringify(config) }),
  getOmo: () => fetchApi<Record<string, unknown>>('/config/omo'),
  putOmo: (config: Record<string, unknown>) =>
    fetchApi<{ ok: boolean }>('/config/omo', { method: 'PUT', body: JSON.stringify(config) }),
};

export const botApi = {
  list: () => fetchApi<BotConfig[]>('/bots'),
  create: (bot: BotConfig) =>
    fetchApi<BotConfig>('/bots', { method: 'POST', body: JSON.stringify(bot) }),
  update: (id: string, updates: Partial<BotConfig>) =>
    fetchApi<BotConfig>(`/bots/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
  delete: (id: string) =>
    fetchApi<{ ok: boolean }>(`/bots/${id}`, { method: 'DELETE' }),
};

export const groupApi = {
  list: () => fetchApi<GroupConfig[]>('/bots/groups'),
  create: (group: GroupConfig) =>
    fetchApi<GroupConfig>('/bots/groups', { method: 'POST', body: JSON.stringify(group) }),
  update: (id: string, updates: Partial<GroupConfig>) =>
    fetchApi<GroupConfig>(`/bots/groups/${id}`, { method: 'PUT', body: JSON.stringify(updates) }),
  delete: (id: string) =>
    fetchApi<{ ok: boolean }>(`/bots/groups/${id}`, { method: 'DELETE' }),
};

export const systemApi = {
  status: () => fetchApi<SystemStatus>('/system/status'),
  reload: () => fetchApi<{ ok: boolean }>('/system/reload', { method: 'POST' }),
  health: () => fetchApi<{ status: string; version: string }>('/system/health'),
};

export const chatApi = {
  listSessions: () => fetchApi<ChatSession[]>('/chat/sessions'),
  createSession: (parentID?: string) =>
    fetchApi<ChatSession>('/chat/sessions', { method: 'POST', body: JSON.stringify(parentID ? { parentID } : {}) }),
  getMessages: (sessionId: string) =>
    fetchApi<ChatMessage[]>(`/chat/sessions/${sessionId}/messages`),
  sendPrompt: (sessionId: string, text: string, agent?: string) =>
    fetchApi<{ ok: boolean }>(`/chat/sessions/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ agent, parts: [{ type: 'text', text }] }),
    }),
  deleteSession: (sessionId: string) =>
    fetchApi<{ ok: boolean }>(`/chat/sessions/${sessionId}`, { method: 'DELETE' }),
};

export const logApi = {
  list: (params?: { level?: string; source?: string; search?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.level) query.set('level', params.level);
    if (params?.source) query.set('source', params.source);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return fetchApi<LogResponse>(`/logs${qs ? `?${qs}` : ''}`);
  },
  clear: () => fetchApi<{ ok: boolean }>('/logs', { method: 'DELETE' }),
};

export const agentMcpApi = {
  listAgents: () => fetchApi<{ agents: AgentInfo[]; directory: string }>('/agents-mcp/agents'),
  getAgentContent: (name: string) => fetchApi<AgentContent>(`/agents-mcp/agents/${name}/content`),
  getMcp: () => fetchApi<McpResponse>('/agents-mcp/mcp'),
  putMcpAutoRegister: (autoRegister: boolean) =>
    fetchApi<{ ok: boolean }>('/agents-mcp/mcp/autoRegister', { method: 'PUT', body: JSON.stringify({ autoRegister }) }),
  putMcpServer: (name: string, config: Record<string, unknown>, enabled?: boolean) =>
    fetchApi<{ ok: boolean }>(`/agents-mcp/mcp/servers/${name}`, { method: 'PUT', body: JSON.stringify({ config, enabled }) }),
  deleteMcpServer: (name: string) =>
    fetchApi<{ ok: boolean }>(`/agents-mcp/mcp/servers/${name}`, { method: 'DELETE' }),
};

export const resourceApi = {
  getSkills: (project?: string) => fetchApi<ResourceSkill[]>(`/resources/skills${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  getCommands: (project?: string) => fetchApi<ResourceCommand[]>(`/resources/commands${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  getMcps: (project?: string) => fetchApi<ResourceMcp[]>(`/resources/mcps${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  getAgents: (project?: string) => fetchApi<ResourceAgent[]>(`/resources/agents${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  getProjects: () => fetchApi<string[]>('/resources/projects'),
  getAll: (project?: string) => fetchApi<ResourceAllResponse>(`/resources/all${project ? `?project=${encodeURIComponent(project)}` : ''}`),
};