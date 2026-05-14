import { useState, useEffect } from 'react';
import type { AgentInfo, McpServerEntry, AgentContent } from '../lib/types';
import { agentMcpApi } from '../lib/api';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Checkbox from '../components/ui/Checkbox';
import { useToastManager, ToastDisplay } from '../components/ui/Toast';

export function AgentMcp() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentsDir, setAgentsDir] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentContent | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [autoRegister, setAutoRegister] = useState(false);
  const [loading, setLoading] = useState(true);

  const [editingServer, setEditingServer] = useState<McpServerEntry | null>(null);
  const [serverFormName, setServerFormName] = useState('');
  const [serverFormConfig, setServerFormConfig] = useState('');
  const [serverFormEnabled, setServerFormEnabled] = useState(true);
  const [showServerForm, setShowServerForm] = useState(false);
  const [savingServer, setSavingServer] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const toast = useToastManager();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      agentMcpApi.listAgents(),
      agentMcpApi.getMcp(),
    ]).then(([agentsData, mcpData]) => {
      if (!cancelled) {
        setAgents(agentsData.agents);
        setAgentsDir(agentsData.directory);
        setMcpServers(mcpData.servers);
        setAutoRegister(mcpData.autoRegister);
      }
    }).catch(err => {
      if (!cancelled) setErrorMsg(err instanceof Error ? err.message : 'Failed to load data');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (errorMsg) { toast.add('error', errorMsg); setErrorMsg(null); }
  }, [errorMsg]);

  const handleSelectAgent = async (name: string) => {
    try {
      setAgentLoading(true);
      const data = await agentMcpApi.getAgentContent(name);
      setSelectedAgent(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load agent');
    } finally {
      setAgentLoading(false);
    }
  };

  const handleToggleAutoRegister = async () => {
    try {
      const newVal = !autoRegister;
      await agentMcpApi.putMcpAutoRegister(newVal);
      setAutoRegister(newVal);
      toast.add('success', `Auto-register ${newVal ? 'enabled' : 'disabled'}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to toggle auto-register');
    }
  };

  const openAddServer = () => {
    setEditingServer(null);
    setServerFormName('');
    setServerFormConfig('{\n  \n}');
    setServerFormEnabled(true);
    setShowServerForm(true);
  };

  const openEditServer = (server: McpServerEntry) => {
    setEditingServer(server);
    setServerFormName(server.name);
    setServerFormConfig(JSON.stringify(server.config, null, 2));
    setServerFormEnabled(server.enabled);
    setShowServerForm(true);
  };

  const handleSaveServer = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(serverFormConfig);
    } catch {
      toast.add('error', 'Invalid JSON config');
      return;
    }
    try {
      setSavingServer(true);
      await agentMcpApi.putMcpServer(serverFormName, parsed, serverFormEnabled);
      toast.add('success', editingServer ? 'Server updated' : 'Server added');
      setShowServerForm(false);
      const mcpData = await agentMcpApi.getMcp();
      setMcpServers(mcpData.servers);
      setAutoRegister(mcpData.autoRegister);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save server');
    } finally {
      setSavingServer(false);
    }
  };

  const handleDeleteServer = async (name: string) => {
    if (!confirm('Are you sure to delete MCP server "' + name + '"?')) return;
    try {
      await agentMcpApi.deleteMcpServer(name);
      toast.add('success', 'Server deleted');
      const mcpData = await agentMcpApi.getMcp();
      setMcpServers(mcpData.servers);
      setAutoRegister(mcpData.autoRegister);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete server');
    }
  };

  if (loading) {
    return (
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>Agent &amp; MCP配置</h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Loading...</p>
        <ToastDisplay toasts={toast.toasts} />
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>Agent &amp; MCP配置</h2>

      <div style={{ display: 'flex', gap: 'calc(var(--spacing-unit) * 4)', flexWrap: 'wrap' }}>
        {/* Agents */}
        <div style={{ flex: '1 1 400px', minWidth: 0 }}>
          <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'calc(var(--spacing-unit) * 5)' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '4px', color: 'var(--color-text)' }}>Agents列表</h3>
            <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px' }}>{agentsDir}</p>

            {agents.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>No agents found</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
                {agents.map(agent => (
                  <button
                    key={agent.name}
                    onClick={() => handleSelectAgent(agent.name)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      background: selectedAgent?.name === agent.name ? 'rgba(0, 212, 255, 0.12)' : 'var(--color-bg)',
                      borderRadius: 'var(--radius-sm)',
                      border: selectedAgent?.name === agent.name ? '1px solid var(--color-accent)' : '1px solid transparent',
                      cursor: 'pointer',
                      width: '100%',
                    }}
                  >
                    <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text)' }}>{agent.name}</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <Badge variant={agent.type === 'json' ? 'warning' : 'info'}>{agent.type}</Badge>
                      {!agent.exists && (
                        <Badge variant="warning">missing</Badge>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {agentLoading && <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Loading content...</p>}

            {selectedAgent && !agentLoading && (
              <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 'calc(var(--spacing-unit) * 4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <h4 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text)' }}>{selectedAgent.name}</h4>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <Badge variant={selectedAgent.type === 'json' ? 'warning' : 'info'}>{selectedAgent.type}</Badge>
                    <Button variant="ghost" onClick={() => setSelectedAgent(null)} style={{ padding: '4px 10px', fontSize: '12px' }}>关闭</Button>
                  </div>
                </div>
                <div style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '12px', maxHeight: '400px', overflow: 'auto' }}>
                  {selectedAgent.type === 'json' ? (
                    <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--color-text)' }}>
                      {(() => { try { return JSON.stringify(JSON.parse(selectedAgent.content), null, 2); } catch { return selectedAgent.content; } })()}
                    </pre>
                  ) : (
                    <div style={{ fontSize: '14px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--color-text)' }}>{selectedAgent.content}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* MCP Servers */}
        <div style={{ flex: '1 1 400px', minWidth: 0 }}>
          <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'calc(var(--spacing-unit) * 5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'calc(var(--spacing-unit) * 4)' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-text)' }}>MCP Servers配置</h3>
              <Button variant="primary" onClick={openAddServer} style={{ padding: '6px 14px', fontSize: '13px' }}>新增MCP Server</Button>
            </div>

            <div style={{ marginBottom: 'calc(var(--spacing-unit) * 4)' }}>
              <Checkbox label="Auto Register" checked={autoRegister} onChange={handleToggleAutoRegister} />
            </div>

            {mcpServers.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>No MCP servers configured</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {mcpServers.map(server => (
                  <div key={server.name} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '10px 12px', background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', gap: '8px' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text)' }}>{server.name}</span>
                        <Badge variant={server.enabled ? 'success' : 'error'}>{server.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      </div>
                      <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {Object.keys(server.config).join(', ') || 'No config keys'}
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <Button variant="ghost" onClick={() => openEditServer(server)} style={{ padding: '4px 10px', fontSize: '12px' }}>编辑</Button>
                      <Button variant="danger" onClick={() => handleDeleteServer(server.name)} style={{ padding: '4px 10px', fontSize: '12px' }}>删除</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MCP Server Form Modal */}
      <Modal open={showServerForm} onClose={() => setShowServerForm(false)} title={editingServer ? '编辑MCP Server' : '新增MCP Server'} style={{ minWidth: '480px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Input label="Name" value={serverFormName} onChange={e => setServerFormName(e.target.value)} placeholder="Server name" disabled={!!editingServer} />
          <div>
            <label style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 500, display: 'block', marginBottom: '4px' }}>Config (JSON)</label>
            <textarea
              value={serverFormConfig}
              onChange={e => setServerFormConfig(e.target.value)}
              style={{ width: '100%', minHeight: '200px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '12px', fontSize: '13px', fontFamily: 'var(--font-mono)', color: 'var(--color-text)', resize: 'vertical', lineHeight: '1.5', outline: 'none' }}
            />
          </div>
          <Checkbox label="Enabled" checked={serverFormEnabled} onChange={e => setServerFormEnabled(e.target.checked)} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
            <Button variant="ghost" onClick={() => setShowServerForm(false)}>取消</Button>
            <Button variant="primary" onClick={handleSaveServer} disabled={savingServer || !serverFormName.trim()}>
              {savingServer ? 'Saving...' : '保存'}
            </Button>
          </div>
        </div>
      </Modal>

      <ToastDisplay toasts={toast.toasts} />
    </div>
  );
}