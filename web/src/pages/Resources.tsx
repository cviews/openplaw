import { useState, useEffect } from 'react';
import type { ResourceSkill, ResourceCommand, ResourceMcp, ResourceAgent } from '../lib/types';
import { resourceApi } from '../lib/api';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import { useToastManager, ToastDisplay } from '../components/ui/Toast';

type TabKey = 'skills' | 'commands' | 'mcps' | 'agents';

const tabs: { key: TabKey; label: string }[] = [
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
  { key: 'mcps', label: 'MCP' },
  { key: 'agents', label: 'Agents' },
];

export function Resources() {
  const [activeTab, setActiveTab] = useState<TabKey>('skills');
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [skills, setSkills] = useState<ResourceSkill[]>([]);
  const [commands, setCommands] = useState<ResourceCommand[]>([]);
  const [mcps, setMcps] = useState<ResourceMcp[]>([]);
  const [agents, setAgents] = useState<ResourceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailModal, setDetailModal] = useState<{ title: string; content: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const toast = useToastManager();

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        setLoading(true);
        const project = selectedProject || undefined;
        const [projectList, skillsData, commandsData, mcpsData, agentsData] = await Promise.all([
          resourceApi.getProjects(),
          resourceApi.getSkills(project),
          resourceApi.getCommands(project),
          resourceApi.getMcps(project),
          resourceApi.getAgents(project),
        ]);
        if (!cancelled) {
          setProjects(projectList);
          setSkills(skillsData);
          setCommands(commandsData);
          setMcps(mcpsData);
          setAgents(agentsData);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load resources');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => { cancelled = true; };
  }, [selectedProject]);

  useEffect(() => {
    if (errorMsg) {
      toast.add('error', errorMsg);
      setErrorMsg(null);
    }
  }, [errorMsg, toast]);

  // Manual refresh function
  const loadData = async () => {
    try {
      setLoading(true);
      const project = selectedProject || undefined;
      const [projectList, skillsData, commandsData, mcpsData, agentsData] = await Promise.all([
        resourceApi.getProjects(),
        resourceApi.getSkills(project),
        resourceApi.getCommands(project),
        resourceApi.getMcps(project),
        resourceApi.getAgents(project),
      ]);
      setProjects(projectList);
      setSkills(skillsData);
      setCommands(commandsData);
      setMcps(mcpsData);
      setAgents(agentsData);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load resources');
    } finally {
      setLoading(false);
    }
  };

  const currentData = activeTab === 'skills' ? skills
    : activeTab === 'commands' ? commands
    : activeTab === 'mcps' ? mcps
    : agents;

  const showDetail = (name: string, content: string | Record<string, unknown>) => {
    setDetailModal({
      title: name,
      content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    });
  };

  if (loading && currentData.length === 0) {
    return (
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>
          资源管理
        </h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Loading...</p>
        <ToastDisplay toasts={toast.toasts} />
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>
        资源管理
      </h2>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <label style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 500 }}>项目:</label>
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            fontSize: '14px',
            color: 'var(--color-text)',
            outline: 'none',
            minWidth: '200px',
          }}
        >
          <option value="">全局 (Global)</option>
          {projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <Button variant="ghost" onClick={loadData} style={{ padding: '4px 10px', fontSize: '12px' }}>刷新</Button>
      </div>

      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: activeTab === tab.key ? 600 : 400,
              color: activeTab === tab.key ? 'var(--color-accent)' : 'var(--color-text-muted)',
              background: activeTab === tab.key ? 'rgba(0, 212, 255, 0.08)' : 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            {tab.label} ({activeTab === 'skills' ? skills.length : activeTab === 'commands' ? commands.length : activeTab === 'mcps' ? mcps.length : agents.length})
          </button>
        ))}
      </div>

      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding: '20px',
        }}
      >
        {currentData.length === 0 && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>
            No {activeTab} found for the selected scope.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {currentData.map((item) => (
            <div
              key={item.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: 'var(--color-bg)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text)' }}>{item.name}</span>
                <Badge variant={item.source === 'project' ? 'success' : 'info'}>{item.source}</Badge>
                {item.projectPath && (
                  <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{item.projectPath}</span>
                )}
              </div>
              <Button variant="ghost" onClick={() => showDetail(item.name, activeTab === 'mcps' ? (item as ResourceMcp).config : (item as ResourceSkill | ResourceCommand | ResourceAgent).content)} style={{ padding: '4px 10px', fontSize: '12px' }}>View</Button>
            </div>
          ))}
        </div>
      </div>

      <Modal open={detailModal !== null} onClose={() => setDetailModal(null)} title={detailModal?.title ?? ''} style={{ minWidth: '500px' }}>
        <textarea
          value={detailModal?.content ?? ''}
          readOnly
          style={{
            width: '100%',
            minHeight: '300px',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px',
            fontSize: '13px',
            lineHeight: '1.5',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-mono)',
            resize: 'vertical',
          }}
        />
      </Modal>

      <ToastDisplay toasts={toast.toasts} />
    </div>
  );
}