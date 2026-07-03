export default function NotificationBell() {
  return (
    <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt)', display: 'flex', alignItems: 'center', padding: '4px 6px', borderRadius: 6 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>notifications</span>
    </button>
  )
}
