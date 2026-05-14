import { useLocation } from 'react-router-dom'

const pageTitles: Record<string, string> = {
  '/': '仪表盘',
  '/bots': '机器人配置',
  '/config/base': '基础配置',
  '/config/opencode': 'OpenCode配置',
  '/chat': 'AI聊天',
  '/logs': '日志管理',
  '/agents': 'Agent & MCP配置',
}

export default function Header() {
  const location = useLocation()
  const title = pageTitles[location.pathname] ?? 'Openplaw'

  return (
    <header
      style={{
        height: '56px',
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 calc(var(--spacing-unit) * 6)',
        flexShrink: 0,
      }}
    >
      <h1
        style={{
          fontSize: '16px',
          fontWeight: 600,
          color: 'var(--color-text)',
        }}
      >
        {title}
      </h1>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'calc(var(--spacing-unit) * 3)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'calc(var(--spacing-unit) * 2)',
            fontSize: '12px',
            color: 'var(--color-text-muted)',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: 'var(--color-success)',
              display: 'inline-block',
            }}
          />
          运行中
        </div>
      </div>
    </header>
  )
}
