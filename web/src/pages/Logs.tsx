import { useState, useEffect } from 'react';
import type { LogEntry, LogResponse } from '../lib/types';
import { logApi } from '../lib/api';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import { useToastManager, ToastDisplay } from '../components/ui/Toast';

const LEVEL_OPTIONS = ['all', 'debug', 'info', 'warn', 'error'];

function levelToBadgeVariant(level: string): 'info' | 'success' | 'warning' | 'error' {
  const l = level.toLowerCase();
  if (l === 'debug') return 'info';
  if (l === 'info') return 'info';
  if (l === 'warn' || l === 'warning') return 'warning';
  if (l === 'error') return 'error';
  return 'info';
}

export function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState('100');
  const [loading, setLoading] = useState(false);
  const [expandedMeta, setExpandedMeta] = useState<Set<number>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const toast = useToastManager();

  useEffect(() => {
    let cancelled = false;

    async function loadLogs() {
      try {
        setLoading(true);
        const params: Parameters<typeof logApi.list>[0] = {};
        if (level && level !== 'all') params.level = level;
        if (search.trim()) params.search = search.trim();
        const parsedLimit = parseInt(limit, 10);
        if (!isNaN(parsedLimit) && parsedLimit > 0) params.limit = parsedLimit;

        const data: LogResponse = await logApi.list(params);
        if (!cancelled) {
          setEntries(data.entries);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load logs');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadLogs();

    return () => { cancelled = true; };
  }, [level, search, limit]);

  useEffect(() => {
    if (errorMsg) {
      toast.add('error', errorMsg);
      setErrorMsg(null);
    }
  }, [errorMsg, toast]);

  // Manual refresh function for button
  const loadLogs = async () => {
    try {
      setLoading(true);
      const params: Parameters<typeof logApi.list>[0] = {};
      if (level && level !== 'all') params.level = level;
      if (search.trim()) params.search = search.trim();
      const parsedLimit = parseInt(limit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) params.limit = parsedLimit;

      const data: LogResponse = await logApi.list(params);
      setEntries(data.entries);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    try {
      await logApi.clear();
      toast.add('success', 'Logs cleared');
      setEntries([]);
    } catch (err) {
      toast.add('error', err instanceof Error ? err.message : 'Failed to clear logs');
    }
  };

  const toggleMeta = (index: number) => {
    setExpandedMeta((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: 'calc(var(--spacing-unit) * 4)' }}>
        日志
      </h2>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'calc(var(--spacing-unit) * 3)',
          marginBottom: 'calc(var(--spacing-unit) * 4)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontWeight: 500 }}>Level:</label>
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            style={{
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 10px',
              fontSize: '14px',
              color: 'var(--color-text)',
              outline: 'none',
              minWidth: '100px',
              fontFamily: 'inherit',
            }}
          >
            {LEVEL_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        <Input
          label="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search message..."
          style={{ minWidth: '200px' }}
        />

        <Input
          label="Limit"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          type="number"
          placeholder="100"
          style={{ minWidth: '120px' }}
        />

        <Button variant="ghost" onClick={loadLogs} disabled={loading}>
          刷新
        </Button>
        <Button variant="danger" onClick={handleClear} disabled={loading}>
          清空
        </Button>
      </div>

      <div
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding: 'calc(var(--spacing-unit) * 4)',
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {loading && entries.length === 0 && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Loading logs...</p>
        )}

        {entries.length === 0 && !loading && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>No logs found</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {entries.map((entry, idx) => {
            const isExpanded = expandedMeta.has(idx);
            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '10px 12px',
                  background: 'var(--color-bg)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: '12px',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-muted)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {entry.timestamp}
                  </span>
                  <Badge variant={levelToBadgeVariant(entry.level)}>{entry.level}</Badge>
                  {entry.source && (
                    <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                      {entry.source}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '14px', color: 'var(--color-text)', lineHeight: '1.5' }}>
                  {entry.message}
                </div>
                {entry.meta && Object.keys(entry.meta).length > 0 && (
                  <div>
                    <button
                      onClick={() => toggleMeta(idx)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--color-accent)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        padding: 0,
                        fontFamily: 'inherit',
                      }}
                    >
                      {isExpanded ? 'Hide meta' : 'Show meta'}
                    </button>
                    {isExpanded && (
                      <pre
                        style={{
                          marginTop: '6px',
                          background: 'var(--color-surface)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '8px',
                          fontSize: '12px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--color-text-muted)',
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {JSON.stringify(entry.meta, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ToastDisplay toasts={toast.toasts} />
    </div>
  );
}
