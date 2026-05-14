import { useLocation } from 'react-router-dom'

const PAGE_NAMES: Record<string, string> = {
  '/': '仪表盘',
  '/bots': '机器人配置',
  '/config/base': '基础配置',
  '/config/opencode': 'OpenCode配置',
  '/chat': 'AI聊天',
  '/logs': '日志管理',
  '/agents': 'Agent & MCP配置',
}

export function Header() {
  const location = useLocation()
  const pageName = PAGE_NAMES[location.pathname] ?? 'Openplaw'

  return (
    <header style={{
      height: '48px',
      minHeight: '48px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 calc(var(--spacing-unit) * 6)',
      background: 'var(--color-surface)',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <span style={{
        fontSize: '15px',
        fontWeight: 600,
        color: 'var(--color-text)',
      }}>
        {pageName}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing-unit) * 2)' }}>
        <span style={{
          display: 'inline-block',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: 'var(--color-success)',
        }} />
        <span style={{
          fontSize: '12px',
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono)',
        }}>
          v0.1.0
        </span>
      </div>
    </header>
  )
}
