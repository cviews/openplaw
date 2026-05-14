import { NavLink } from 'react-router-dom'

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string; icon: string }> = [
  { to: '/', label: '仪表盘', icon: '📊' },
  { to: '/bots', label: '机器人', icon: '🤖' },
  { to: '/resources', label: '资源管理', icon: '🔍' },
  { to: '/config/base', label: '基础配置', icon: '⚙' },
  { to: '/config/opencode', label: 'OpenCode配置', icon: '📝' },
  { to: '/chat', label: 'AI聊天', icon: '💬' },
  { to: '/logs', label: '日志', icon: '📋' },
  { to: '/agents', label: 'Agent/MCP', icon: '🔧' },
]

export function Sidebar() {
  return (
    <aside style={{
      width: '220px',
      minWidth: '220px',
      background: 'var(--color-surface)',
      borderRight: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      padding: 'calc(var(--spacing-unit) * 4)',
      gap: 'calc(var(--spacing-unit) * 1)',
    }}>
      <div style={{
        padding: 'calc(var(--spacing-unit) * 3) calc(var(--spacing-unit) * 4)',
        marginBottom: 'calc(var(--spacing-unit) * 4)',
        fontFamily: 'var(--font-mono)',
        fontSize: '18px',
        fontWeight: 700,
        color: 'var(--color-accent)',
        letterSpacing: '-0.5px',
      }}>
        Openplaw
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: 'calc(var(--spacing-unit) * 3)',
              padding: 'calc(var(--spacing-unit) * 3) calc(var(--spacing-unit) * 4)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px',
              color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)',
              background: isActive ? 'var(--color-surface-hover)' : 'transparent',
              transition: 'background 0.15s, color 0.15s',
            })}
          >
            <span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}
