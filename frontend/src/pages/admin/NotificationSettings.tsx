import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { GREEN, NAVY, INTER, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────
// Backend GET /api/admin/notification-settings returns rows from
// notification_event_config: one row per (event_type, channel).
interface NotifRow {
  event_type: string
  channel: string
  enabled: boolean
  label?: string
  description?: string
}

const CHANNELS: { key: string; label: string }[] = [
  { key: 'in_app',   label: 'In-app' },
  { key: 'email',    label: 'Email' },
  { key: 'sms',      label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
]

// ── Toggle component ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 40, height: 22, borderRadius: RADIUS.lg, border: 'none', cursor: 'pointer',
        background: checked ? GREEN : 'var(--bdr)',
        position: 'relative', flexShrink: 0, transition: 'background .2s',
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3, width: 16, height: 16,
        borderRadius: '50%', background: '#fff', transition: 'left .2s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </button>
  )
}

function labelOf(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminNotificationSettings() {
  const [rows,    setRows]    = useState<NotifRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [dirty,   setDirty]   = useState(false)
  const [saving,  setSaving]  = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<NotifRow[] | { data?: NotifRow[] }>('/api/admin/notification-settings')
      const list = Array.isArray(data) ? data : (data?.data ?? [])
      setRows(list)
      setDirty(false)
    } catch (e: any) {
      if (!e.message?.includes('404')) setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Group the flat rows into one entry per event, keyed by channel.
  const events = useMemo(() => {
    const m = new Map<string, { event_type: string; label: string; description: string; channels: Record<string, boolean | undefined> }>()
    for (const r of rows) {
      let e = m.get(r.event_type)
      if (!e) {
        e = { event_type: r.event_type, label: r.label || labelOf(r.event_type), description: r.description || '', channels: {} }
        m.set(r.event_type, e)
      }
      if (r.label && !e.label) e.label = r.label
      if (r.description && !e.description) e.description = r.description
      e.channels[r.channel] = r.enabled
    }
    return Array.from(m.values())
  }, [rows])

  function toggle(event_type: string, channel: string, val: boolean) {
    setRows(rs => rs.map(r =>
      r.event_type === event_type && r.channel === channel ? { ...r, enabled: val } : r))
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    try {
      const payload = rows.map(r => ({ event_type: r.event_type, channel: r.channel, enabled: r.enabled }))
      await apiFetch('/api/admin/notification-settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      toast.success('Notification settings saved')
      setDirty(false)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const th: React.CSSProperties = {
    padding: '10px 14px', textAlign: 'left', fontSize: TEXT.xs, fontWeight: FW.bold,
    color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.05em',
  }

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Notification Settings"
      subtitle="Control which channels fire for each system event"
      actions={
        dirty ? (
          <button onClick={save} disabled={saving} style={{
            display: 'flex', alignItems: 'center', gap: SP[1], padding: '8px 18px', borderRadius: RADIUS.md,
            border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
          }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        ) : null
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--txt3)' }}>Loading…</div>
      ) : events.length === 0 ? (
        <SectionCard title="Event Notifications">
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>
            No notification events are configured.
          </div>
        </SectionCard>
      ) : (
        <SectionCard title="Event Notifications" subtitle="Choose which channels fire for each event. A dash means that channel is not available for the event.">
          <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  <th style={th}>Event</th>
                  {CHANNELS.map(c => (
                    <th key={c.key} style={{ ...th, textAlign: 'center' }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={e.event_type} style={{ borderTop: '1px solid var(--bdr)', background: i % 2 === 0 ? 'transparent' : 'var(--th-bg)' }}>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{e.label}</div>
                      {e.description && (
                        <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', marginTop: 2 }}>{e.description}</div>
                      )}
                    </td>
                    {CHANNELS.map(c => (
                      <td key={c.key} style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                          {e.channels[c.key] === undefined ? (
                            <span style={{ color: 'var(--txt3)' }}>—</span>
                          ) : (
                            <Toggle checked={!!e.channels[c.key]} onChange={v => toggle(e.event_type, c.key, v)} />
                          )}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
