import { NavLink } from 'react-router-dom'

const navItems = [
  { path: '/', label: '仪表盘', icon: '\uD83D\uDCCA' },
  { path: '/bots', label: '机器人', icon: '\uD83E\uDD16' },
  { path: '/resources', label: '资源管理', icon: '\uD83D\uDD0D' },
  { path: '/config/base', label: '基础配置', icon: '\u2699\uFE0F' },
  { path: '/config/opencode', label: 'OpenCode配置', icon: '\uD83D\uDCDD' },
  { path: '/chat', label: 'AI聊天', icon: '\uD83D\uDCAC' },
  { path: '/logs', label: '日志', icon: '\uD83D\uDCCB' },
  { path: '/agents', label: 'Agent/MCP', icon: '\uD83D\uDD27' },
]

export default function Sidebar() {
  return (
    <aside
      style={{
        width: '240px',
        background: 'var(--color-surface)',
        borderRight: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        padding: 'calc(var(--spacing-unit) * 4)',
      }}
    >
      <div
        style={{
          fontSize: '18px',
          fontWeight: 700,
          color: 'var(--color-accent)',
          marginBottom: 'calc(var(--spacing-unit) * 6)',
          paddingLeft: 'calc(var(--spacing-unit) * 3)',
          letterSpacing: '0.5px',
        }}
      >
        Openplaw
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing-unit) * 2)' }}>
        {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              style={({ isActive: navActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 'calc(var(--spacing-unit) * 3)',
                padding: 'calc(var(--spacing-unit) * 3) calc(var(--spacing-unit) * 4)',
                borderRadius: 'var(--radius-md)',
                fontSize: '14px',
                fontWeight: 500,
                color: navActive ? 'var(--color-accent)' : 'var(--color-text-muted)',
                background: navActive ? 'rgba(0, 212, 255, 0.08)' : 'transparent',
                transition: 'all 0.15s ease',
              })}
            >
              <span style={{ fontSize: '16px', lineHeight: 1 }}>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
        ))}
      </nav>
    </aside>
  )
}
