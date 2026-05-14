import { useEffect, useState } from 'react';
import { systemApi } from '../lib/api';
import type { SystemStatus } from '../lib/types';

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

type StatCard = { label: string; value: string; color?: string };

function buildCards(status: SystemStatus | null): StatCard[] {
  if (!status) {
    return [
      { label: '机器人数量', value: '—' },
      { label: '项目数量', value: '—' },
      { label: 'MCP数量', value: '—' },
      { label: '运行时间', value: '—' },
      { label: 'Skills数量', value: '—' },
      { label: 'Agents数量', value: '—' },
    ];
  }
  return [
    { label: '机器人数量', value: String(status.bots), color: 'var(--color-accent)' },
    { label: '项目数量', value: String(status.projects), color: 'var(--color-accent)' },
    { label: 'MCP数量', value: String(status.totalMcps), color: 'var(--color-accent)' },
    { label: '运行时间', value: formatUptime(status.uptime), color: 'var(--color-text)' },
    { label: 'Skills数量', value: String(status.skills), color: 'var(--color-accent)' },
    { label: 'Agents数量', value: String(status.agents), color: 'var(--color-accent)' },
  ];
}

export function Dashboard() {
  const [status, setStatus] = useState<SystemStatus | null>(null);

  useEffect(() => {
    systemApi.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const cards = buildCards(status);

  return (
    <div>
      <h2 style={{
        fontSize: '20px',
        fontWeight: 600,
        marginBottom: 'calc(var(--spacing-unit) * 6)',
      }}>
        仪表盘
      </h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 'calc(var(--spacing-unit) * 4)',
      }}>
        {cards.map((card) => (
          <div key={card.label} style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 'calc(var(--spacing-unit) * 5) calc(var(--spacing-unit) * 6)',
          }}>
            <div style={{
              fontSize: '12px',
              color: 'var(--color-text-muted)',
              marginBottom: 'calc(var(--spacing-unit) * 2)',
            }}>
              {card.label}
            </div>
            <div style={{
              fontSize: '28px',
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              color: card.color ?? 'var(--color-accent)',
            }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
