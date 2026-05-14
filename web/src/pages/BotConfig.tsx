import { useState, useEffect } from 'react';
import type { BotConfig, GroupConfig } from '../lib/types';
import { botApi, groupApi } from '../lib/api';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Checkbox from '../components/ui/Checkbox';
import { useToastManager, ToastDisplay } from '../components/ui/Toast';

const emptyBot: BotConfig = {
  id: '',
  agent: '',
  appId: '',
  appSecret: '',
  verificationToken: '',
  encryptKey: '',
  botName: '',
  project: '',
};

const emptyGroup: GroupConfig = {
  id: '',
  chatId: '',
  name: '',
  bots: [],
};

export function BotConfig() {
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [groups, setGroups] = useState<GroupConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [botModalOpen, setBotModalOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<BotConfig | null>(null);
  const [botForm, setBotForm] = useState<BotConfig>({ ...emptyBot });

  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<GroupConfig | null>(null);
  const [groupForm, setGroupForm] = useState<GroupConfig>({ ...emptyGroup });

  const toast = useToastManager();

  useEffect(() => {
    let cancelled = false;

    async function doLoad() {
      try {
        setLoading(true);
        const [botsData, groupsData] = await Promise.all([
          botApi.list(),
          groupApi.list(),
        ]);
        if (!cancelled) {
          setBots(botsData);
          setGroups(groupsData);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load data');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    doLoad();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (errorMsg) {
      toast.add('error', errorMsg);
      setErrorMsg(null);
    }
  }, [errorMsg, toast]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [botsData, groupsData] = await Promise.all([
        botApi.list(),
        groupApi.list(),
      ]);
      setBots(botsData);
      setGroups(groupsData);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const openBotModal = (bot?: BotConfig) => {
    if (bot) {
      setEditingBot(bot);
      setBotForm({ ...bot });
    } else {
      setEditingBot(null);
      setBotForm({ ...emptyBot });
    }
    setBotModalOpen(true);
  };

  const openGroupModal = (group?: GroupConfig) => {
    if (group) {
      setEditingGroup(group);
      setGroupForm({ ...group });
    } else {
      setEditingGroup(null);
      setGroupForm({ ...emptyGroup });
    }
    setGroupModalOpen(true);
  };

  const handleSaveBot = async () => {
    try {
      if (editingBot) {
        await botApi.update(editingBot.id, botForm);
        toast.add('success', 'Bot updated');
      } else {
        await botApi.create(botForm);
        toast.add('success', 'Bot created');
      }
      setBotModalOpen(false);
      loadData();
    } catch (err) {
      toast.add('error', err instanceof Error ? err.message : 'Failed to save bot');
    }
  };

  const handleDeleteBot = async (id: string) => {
    if (!confirm('Are you sure to delete this bot?')) return;
    try {
      await botApi.delete(id);
      toast.add('success', 'Bot deleted');
      loadData();
    } catch (err) {
      toast.add('error', err instanceof Error ? err.message : 'Failed to delete bot');
    }
  };

  const handleSaveGroup = async () => {
    try {
      if (editingGroup) {
        await groupApi.update(editingGroup.id, groupForm);
        toast.add('success', 'Group updated');
      } else {
        await groupApi.create(groupForm);
        toast.add('success', 'Group created');
      }
      setGroupModalOpen(false);
      loadData();
    } catch (err) {
      toast.add('error', err instanceof Error ? err.message : 'Failed to save group');
    }
  };

  const handleDeleteGroup = async (id: string) => {
    if (!confirm('Are you sure to delete this group?')) return;
    try {
      await groupApi.delete(id);
      toast.add('success', 'Group deleted');
      loadData();
    } catch (err) {
      toast.add('error', err instanceof Error ? err.message : 'Failed to delete group');
    }
  };

  const toggleGroupBot = (botId: string) => {
    setGroupForm((prev) => {
      const has = prev.bots.includes(botId);
      return {
        ...prev,
        bots: has ? prev.bots.filter((b) => b !== botId) : [...prev.bots, botId],
      };
    });
  };

  if (loading && bots.length === 0 && groups.length === 0) {
    return (
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>
          机器人配置
        </h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Loading...</p>
        <ToastDisplay toasts={toast.toasts} />
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>
        机器人配置
      </h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-text)' }}>机器人列表</h3>
            <Button variant="primary" onClick={() => openBotModal()} style={{ padding: '6px 14px', fontSize: '13px' }}>
              新增机器人
            </Button>
          </div>

          {bots.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>暂无机器人配置</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {bots.map((bot) => (
                <div
                  key={bot.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--color-bg)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text)' }}>{bot.botName}</span>
                    <Badge variant="info">{bot.agent}</Badge>
                    {bot.project && (
                      <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{bot.project}</span>
                    )}
                    <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {bot.id}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <Button variant="ghost" onClick={() => openBotModal(bot)} style={{ padding: '4px 10px', fontSize: '12px' }}>
                      编辑
                    </Button>
                    <Button variant="danger" onClick={() => handleDeleteBot(bot.id)} style={{ padding: '4px 10px', fontSize: '12px' }}>
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            padding: '20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-text)' }}>群组列表</h3>
            <Button variant="primary" onClick={() => openGroupModal()} style={{ padding: '6px 14px', fontSize: '13px' }}>
              新增群组
            </Button>
          </div>

          {groups.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>暂无群组配置</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {groups.map((group) => (
                <div
                  key={group.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--color-bg)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-text)' }}>{group.name}</span>
                    <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {group.chatId}
                    </span>
                    <Badge variant="success">{group.bots.length} bots</Badge>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <Button variant="ghost" onClick={() => openGroupModal(group)} style={{ padding: '4px 10px', fontSize: '12px' }}>
                      编辑
                    </Button>
                    <Button variant="danger" onClick={() => handleDeleteGroup(group.id)} style={{ padding: '4px 10px', fontSize: '12px' }}>
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={botModalOpen}
        onClose={() => setBotModalOpen(false)}
        title={editingBot ? '编辑机器人' : '新增机器人'}
        style={{ minWidth: '480px' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Input
            label="ID"
            value={botForm.id}
            onChange={(e) => setBotForm((prev) => ({ ...prev, id: e.target.value }))}
            placeholder="唯一标识"
            disabled={!!editingBot}
          />
          <Input
            label="Agent"
            value={botForm.agent}
            onChange={(e) => setBotForm((prev) => ({ ...prev, agent: e.target.value }))}
            placeholder="Agent 名称"
          />
          <Input
            label="App ID"
            value={botForm.appId}
            onChange={(e) => setBotForm((prev) => ({ ...prev, appId: e.target.value }))}
            placeholder="App ID"
          />
          <Input
            label="App Secret"
            value={botForm.appSecret}
            onChange={(e) => setBotForm((prev) => ({ ...prev, appSecret: e.target.value }))}
            placeholder="App Secret"
          />
          <Input
            label="Verification Token"
            value={botForm.verificationToken}
            onChange={(e) => setBotForm((prev) => ({ ...prev, verificationToken: e.target.value }))}
            placeholder="Verification Token"
          />
          <Input
            label="Encrypt Key"
            value={botForm.encryptKey}
            onChange={(e) => setBotForm((prev) => ({ ...prev, encryptKey: e.target.value }))}
            placeholder="Encrypt Key"
          />
          <Input
            label="Bot Name"
            value={botForm.botName}
            onChange={(e) => setBotForm((prev) => ({ ...prev, botName: e.target.value }))}
            placeholder="机器人名称"
          />
          <Input
            label="Project (可选)"
            value={botForm.project ?? ''}
            onChange={(e) => setBotForm((prev) => ({ ...prev, project: e.target.value || undefined }))}
            placeholder="项目名"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
            <Button variant="ghost" onClick={() => setBotModalOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSaveBot}>保存</Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={groupModalOpen}
        onClose={() => setGroupModalOpen(false)}
        title={editingGroup ? '编辑群组' : '新增群组'}
        style={{ minWidth: '480px' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Input
            label="ID"
            value={groupForm.id}
            onChange={(e) => setGroupForm((prev) => ({ ...prev, id: e.target.value }))}
            placeholder="唯一标识"
            disabled={!!editingGroup}
          />
          <Input
            label="Chat ID"
            value={groupForm.chatId}
            onChange={(e) => setGroupForm((prev) => ({ ...prev, chatId: e.target.value }))}
            placeholder="Chat ID"
          />
          <Input
            label="Name"
            value={groupForm.name}
            onChange={(e) => setGroupForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="群组名称"
          />
          <div>
            <label style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 500, display: 'block', marginBottom: '8px' }}>
              Bots
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {bots.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>暂无机器人可选</p>
              ) : (
                bots.map((bot) => (
                  <Checkbox
                    key={bot.id}
                    label={bot.botName}
                    checked={groupForm.bots.includes(bot.id)}
                    onChange={() => toggleGroupBot(bot.id)}
                  />
                ))
              )}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
            <Button variant="ghost" onClick={() => setGroupModalOpen(false)}>取消</Button>
            <Button variant="primary" onClick={handleSaveGroup}>保存</Button>
          </div>
        </div>
      </Modal>

      <ToastDisplay toasts={toast.toasts} />
    </div>
  );
}
