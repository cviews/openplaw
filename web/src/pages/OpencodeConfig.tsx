import { useState, useEffect } from 'react';
import { configApi } from '../lib/api';
import Button from '../components/ui/Button';
import { useToastManager, ToastDisplay } from '../components/ui/Toast';

export function OpencodeConfig() {
  const [configText, setConfigText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const toast = useToastManager();

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        setLoading(true);
        const data = await configApi.getOpencode();
        if (!cancelled) {
          setConfigText(JSON.stringify(data, null, 2));
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load config');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadConfig();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (errorMsg) {
      toast.add('error', errorMsg);
      setErrorMsg(null);
    }
  }, [errorMsg, toast]);

  const handleSave = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(configText) as Record<string, unknown>;
    } catch (err) {
      toast.add('error', err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }
    try {
      setSaving(true);
      await configApi.putOpencode(parsed);
      toast.add('success', 'Config saved successfully');
    } catch (err) {
      toast.add('error', err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>
          OpenCode配置
        </h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '14px' }}>Loading...</p>
        <ToastDisplay toasts={toast.toasts} />
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px', color: 'var(--color-text)' }}>
        OpenCode配置
      </h2>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>

      <textarea
        value={configText}
        onChange={(e) => setConfigText(e.target.value)}
        style={{
          width: '100%',
          minHeight: '400px',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          padding: '12px',
          fontSize: '13px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text)',
          resize: 'vertical',
          lineHeight: '1.5',
          outline: 'none',
        }}
      />

      <ToastDisplay toasts={toast.toasts} />
    </div>
  );
}
