import { useLocation } from 'react-router-dom'

export default function ComingSoon() {
  const { pathname } = useLocation()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', textAlign: 'center', padding: '0 32px' }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: 'rgba(14,40,65,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 24, color: '#0E2841' }}>construction</span>
      </div>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--txt)', marginBottom: 6 }}>Page being rebuilt</h2>
      <p style={{ fontSize: 13, color: 'var(--txt2)', maxWidth: 300, lineHeight: 1.6 }}>
        <code style={{ fontSize: 11, background: 'var(--th-bg)', padding: '1px 5px', borderRadius: 4 }}>{pathname}</code>
        {' '}is part of the platform rebuild and will be available soon.
      </p>
    </div>
  )
}
