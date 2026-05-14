import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChatSession, ChatMessage } from '../lib/types';
import { chatApi } from '../lib/api';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { useToastManager, ToastDisplay } from '../components/ui/Toast';

export function Chat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const toast = useToastManager();

  useEffect(() => {
    let cancelled = false;
    setLoadingSessions(true);
    chatApi.listSessions()
      .then(data => { if (!cancelled) setSessions(data); })
      .catch(err => { if (!cancelled) setErrorMsg(err instanceof Error ? err.message : 'Failed to load sessions'); })
      .finally(() => { if (!cancelled) setLoadingSessions(false); });
    return () => { cancelled = true; };
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      setLoadingMessages(true);
      const data = await chatApi.getMessages(sessionId);
      setMessages(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (selectedSessionId) {
      loadMessages(selectedSessionId);
    } else {
      setMessages([]);
    }
  }, [selectedSessionId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleCreateSession = async () => {
    try {
      const session = await chatApi.createSession();
      setSessions((prev) => [session, ...prev]);
      setSelectedSessionId(session.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create session');
    }
  };

  const handleSend = async () => {
    if (!selectedSessionId || !prompt.trim()) return;
    const text = prompt.trim();
    try {
      setSending(true);
      setPrompt('');
      const optimisticUserMessage: ChatMessage = {
        info: { role: 'user', sessionId: selectedSessionId },
        parts: [{ type: 'text', text }],
      };
      setMessages((prev) => [...prev, optimisticUserMessage]);
      await chatApi.sendPrompt(selectedSessionId, text);
      const refreshed = await chatApi.getMessages(selectedSessionId);
      setMessages(refreshed);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (errorMsg) {
      toast.add('error', errorMsg);
      setErrorMsg(null);
    }
  }, [errorMsg]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: 'calc(var(--spacing-unit) * 4)' }}>
        AI聊天
      </h2>

      <div style={{ display: 'flex', flex: 1, gap: 'calc(var(--spacing-unit) * 4)', overflow: 'hidden' }}>
<div
            style={{
              width: '280px',
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'calc(var(--spacing-unit) * 3)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              padding: 'calc(var(--spacing-unit) * 4)',
              overflow: 'hidden',
            }}
          >
            <Button variant="primary" onClick={handleCreateSession} disabled={loadingSessions}>
              新建会话
            </Button>

            <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {loadingSessions && sessions.length === 0 && (
                <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>Loading...</p>
              )}
              {sessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => setSelectedSessionId(session.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: selectedSessionId === session.id ? 'rgba(0, 212, 255, 0.12)' : 'transparent',
                    color: selectedSessionId === session.id ? 'var(--color-accent)' : 'var(--color-text)',
                    fontSize: '13px',
                    fontWeight: selectedSessionId === session.id ? 600 : 400,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontFamily: 'inherit',
                  }}
                >
                  {session.title || session.id}
                </button>
            ))}
            {sessions.length === 0 && !loadingSessions && (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No sessions</p>
            )}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: 'calc(var(--spacing-unit) * 4)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            {!selectedSessionId && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Select or create a session to start chatting</p>
              </div>
            )}
            {selectedSessionId && loadingMessages && messages.length === 0 && (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Loading messages...</p>
            )}
            {messages.map((msg, idx) => {
              const role = msg.info.role;
              const text = msg.parts.map((p) => p.text).join('');
              const isUser = role === 'user';
              return (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    justifyContent: isUser ? 'flex-start' : 'flex-end',
                  }}
                >
                  <div
                    style={{
                      maxWidth: '70%',
                      padding: '10px 14px',
                      borderRadius: 'var(--radius-md)',
                      fontSize: '14px',
                      lineHeight: '1.5',
                      background: isUser ? 'var(--color-bg)' : 'rgba(0, 212, 255, 0.12)',
                      color: isUser ? 'var(--color-text)' : 'var(--color-accent)',
                      border: isUser ? '1px solid var(--color-border)' : '1px solid rgba(0, 212, 255, 0.25)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {text}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {selectedSessionId && (
            <div
              style={{
                display: 'flex',
                gap: '8px',
                padding: 'calc(var(--spacing-unit) * 3) calc(var(--spacing-unit) * 4)',
                borderTop: '1px solid var(--color-border)',
                background: 'var(--color-surface)',
              }}
            >
              <form
                onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                style={{ display: 'flex', gap: '8px', flex: 1 }}
              >
                <Input
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Type a message..."
                  disabled={sending}
                  style={{ flex: 1 }}
                />
                <Button variant="primary" onClick={handleSend} disabled={sending || !prompt.trim()}>
                  发送
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>

      <ToastDisplay toasts={toast.toasts} />
    </div>
  );
}
