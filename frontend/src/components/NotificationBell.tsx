// INTEGRATION NOTE:
// In App.tsx, inside the header/topbar area, import and add:
//   import NotificationBell from './components/NotificationBell'
//   <NotificationBell />
// Place it next to the logout/user menu button.

import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNotifications, AppNotification } from '../hooks/useNotifications'
import NotificationDrawer from './NotificationDrawer'

const RED = '#C00000'

const NOTIF_ICONS: Record<string, string> = {
  assignment:    'person_add',
  approval:      'approval',
  ticket_reply:  'chat',
  campaign_done: 'campaign',
  system:        'info',
  mention:       'alternate_email',
  sla_breach:    'warning',
  info:          'notifications',
}

const NOTIF_COLORS: Record<string, string> = {
  assignment:    '#2563EB',
  approval:      '#16A34A',
  ticket_reply:  '#7C3AED',
  campaign_done: '#0E2841',
  sla_breach:    RED,
  system:        '#64748B',
  mention:       '#D97706',
  info:          '#64748B',
}

function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}

function NotifItem({ notif, onRead, onDelete }: {
  notif: AppNotification
  onRead: () => void
  onDelete: () => void
}) {
  const unread = !notif.read_at
  const icon  = NOTIF_ICONS[notif.type] ?? 'notifications'
  const color = NOTIF_COLORS[notif.type] ?? '#64748B'

  return (
    <div
      onClick={onRead}
      className="group flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 transition-colors border-b last:border-b-0 relative"
      style={{
        borderColor: 'rgba(15,23,42,0.06)',
        background: unread ? 'rgba(37,99,235,0.03)' : undefined,
      }}
    >
      {unread && (
        <span className="absolute left-2 top-[18px] w-1.5 h-1.5 rounded-full" style={{ background: '#2563EB' }} />
      )}
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: `${color}18` }}
      >
        <span className="material-symbols-rounded text-[16px]" style={{ color }}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0 pr-4">
        <p className={`text-[13px] leading-snug ${unread ? 'font-semibold text-slate-800' : 'font-medium text-slate-600'}`}>
          {notif.title}
        </p>
        {notif.body && (
          <p className="text-[11.5px] text-slate-400 mt-0.5 line-clamp-2 leading-relaxed">{notif.body}</p>
        )}
        <p className="text-[11px] text-slate-400 mt-1">{formatRelative(notif.created_at)}</p>
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete() }}
        className="absolute right-3 top-3 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-200 transition-all"
        aria-label="Dismiss"
      >
        <span className="material-symbols-rounded text-[13px] text-slate-400">close</span>
      </button>
    </div>
  )
}

export default function NotificationBell() {
  const [open, setOpen]           = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const { notifications, unreadCount, loading, markRead, markAllRead, deleteNotif, hasMore, loadMore } =
    useNotifications()

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleRead(notif: AppNotification) {
    markRead(notif.id)
    if (notif.action_url) {
      navigate(notif.action_url)
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="relative w-9 h-9 flex items-center justify-center rounded-xl hover:bg-slate-100 transition-colors"
        aria-label="Notifications"
      >
        <span className="material-symbols-rounded text-[20px] text-slate-500">notifications</span>
        {unreadCount > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold flex items-center justify-center text-white"
            style={{ background: RED }}
          >
            {unreadCount > 99 ? '99+' : unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 w-[340px] bg-white rounded-2xl shadow-2xl border z-[400] overflow-hidden"
          style={{ borderColor: 'rgba(15,23,42,0.1)' }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 border-b"
            style={{ borderColor: 'rgba(15,23,42,0.08)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold text-slate-800">Notifications</span>
              {unreadCount > 0 && (
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded-full font-semibold text-white"
                  style={{ background: RED }}
                >
                  {unreadCount}
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-[12px] text-blue-600 hover:text-blue-800 font-medium transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="max-h-[400px] overflow-y-auto">
            {loading ? (
              <div className="py-6 text-center">
                <div className="w-5 h-5 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin mx-auto" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-10 text-center px-4">
                <span className="material-symbols-rounded text-[36px] text-slate-200 block mb-2">
                  notifications_none
                </span>
                <p className="text-[13px] text-slate-400">You're all caught up</p>
              </div>
            ) : (
              notifications.map(n => (
                <NotifItem
                  key={n.id}
                  notif={n}
                  onRead={() => handleRead(n)}
                  onDelete={() => deleteNotif(n.id)}
                />
              ))
            )}

            {hasMore && (
              <button
                onClick={loadMore}
                className="w-full py-3 text-[12px] text-blue-600 hover:bg-slate-50 transition-colors font-medium border-t"
                style={{ borderColor: 'rgba(15,23,42,0.06)' }}
              >
                Load older notifications
              </button>
            )}
          </div>

          {/* Footer — open full drawer */}
          <div className="border-t" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
            <button
              onClick={() => { setOpen(false); setDrawerOpen(true) }}
              className="w-full py-2.5 text-[12px] text-blue-600 hover:bg-slate-50 transition-colors font-medium"
            >
              See all notifications →
            </button>
          </div>
        </div>
      )}

      <NotificationDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  )
}
