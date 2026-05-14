import { Routes, Route } from 'react-router-dom'
import { Sidebar } from './layout/Sidebar'
import { Header } from './layout/Header'
import { Dashboard } from './pages/Dashboard'
import { BotConfig } from './pages/BotConfig'
import { BaseConfig } from './pages/BaseConfig'
import { OpencodeConfig } from './pages/OpencodeConfig'
import { Chat } from './pages/Chat'
import { Logs } from './pages/Logs'
import { AgentMcp } from './pages/AgentMcp'
import { Resources } from './pages/Resources'

export function App() {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Header />
        <main style={{
          flex: 1,
          overflow: 'auto',
          padding: 'calc(var(--spacing-unit) * 6)',
          background: 'var(--color-bg)',
        }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/bots" element={<BotConfig />} />
            <Route path="/resources" element={<Resources />} />
            <Route path="/config/base" element={<BaseConfig />} />
            <Route path="/config/opencode" element={<OpencodeConfig />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/agents" element={<AgentMcp />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
