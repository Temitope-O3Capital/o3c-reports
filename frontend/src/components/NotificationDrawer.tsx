// Full-page slide-in drawer showing all notifications with filter tabs.
// Triggered from the "See all notifications" link in NotificationBell.

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNotifications, AppNotification } from '../hooks/useNotifications'

const NAVY = '#0E2841'

const TYPE_LABELS: Record<string, string> = {
  assignment:    'Assignment',
  approval:      'Approval',
  ticket_reply:  'Ticket Reply',
  campaign_done: 'Campaign',
  system:        'System',
  mention:       'Mention',
  sla_breach:    'SLA Breach',
  info:          'Info',
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleString('en-NG', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

export default function NotificationDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [filter, setFilter] = useState<string>('all')
  const navigate = useNavigate()
  const { notifications, unreadCount, markRead, markAllRead, deleteNotif, hasMore, loadMore } =
    useNotifications()

  const filtered = notifications.filter(n => {
    if (filter === 'unread') return !n.read_at
    if (filter !== 'all') return n.type === filter
    return true
  })

  const uniqueTypes = [...new Set(notifications.map(n => n.type))]

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div className="fixed inset-0 z-[350] bg-black/20" onClick={onClose} />
      )}

      {/* Drawer */}
      <div
        className="fixed right-0 top-0 h-full w-[420px] bg-white shadow-2xl z-[360] flex flex-col transition-transform duration-300"
        style={{ transform: open ? 'translateX(0)' : 'translateX(100%)' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}
        >
          <div>
            <h2 className="text-[16px] font-semibold text-slate-800">All Notifications</h2>
            {unreadCount > 0 && (
              <p className="text-[12px] text-slate-400">{unreadCount} unread</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-[12px] text-blue-600 font-medium hover:text-blue-800"
              >
                Mark all read
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-slate-100 transition-colors"
            >
              <span className="material-symbols-rounded text-[20px] text-slate-400">close</span>
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div
          className="flex items-center gap-1 px-4 py-2 border-b overflow-x-auto"
          style={{ borderColor: 'rgba(15,23,42,0.06)' }}
        >
          {(['all', 'unread', ...uniqueTypes] as string[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="whitespace-nowrap px-3 py-1 rounded-lg text-[12px] font-medium transition-colors"
              style={{
                background: filter === f ? NAVY : 'transparent',
                color: filter === f ? '#fff' : '#64748B',
              }}
            >
              {f === 'all'
                ? 'All'
                : f === 'unread'
                  ? `Unread (${unreadCount})`
                  : TYPE_LABELS[f] ?? f}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="py-16 text-center px-6">
              <span className="material-symbols-rounded text-[48px] text-slate-200 block mb-3">
                notifications_none
              </span>
              <p className="text-[14px] text-slate-400">Nothing here yet</p>
            </div>
          ) : (
            filtered.map(n => (
              <div
                key={n.id}
                onClick={() => {
                  markRead(n.id)
                  if (n.action_url) { navigate(n.action_url); onClose() }
                }}
                className="flex items-start gap-3 px-5 py-4 cursor-pointer hover:bg-slate-50 border-b transition-colors"
                style={{
                  borderColor: 'rgba(15,23,42,0.06)',
                  background: !n.read_at ? 'rgba(37,99,235,0.03)' : undefined,
                }}
              >
                {!n.read_at && (
                  <span className="shrink-0 mt-2 w-1.5 h-1.5 rounded-full bg-blue-500" />
                )}
                <div className={`flex-1 ${n.read_at ? 'pl-4' : ''}`}>
                  <p className={`text-[13px] leading-snug ${!n.read_at ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>
                    {n.title}
                  </p>
                  {n.body && (
                    <p className="text-[12px] text-slate-400 mt-1 leading-relaxed">{n.body}</p>
                  )}
                  <p className="text-[11px] text-slate-400 mt-1.5">{formatDate(n.created_at)}</p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); deleteNotif(n.id) }}
                  className="p-0.5 rounded hover:bg-slate-200 shrink-0 mt-0.5 opacity-0 hover:opacity-100 transition-opacity"
                >
                  <span className="material-symbols-rounded text-[14px] text-slate-400">delete</span>
                </button>
              </div>
            ))
          )}
          {hasMore && (
            <button
              onClick={loadMore}
              className="w-full py-3 text-[13px] text-blue-600 hover:bg-slate-50 font-medium transition-colors"
            >
              Load more
            </button>
          )}
        </div>
      </div>
    </>
  )
}
