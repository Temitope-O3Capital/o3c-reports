import { useEffect, useState } from 'react'

const NAVY = '#0E2841'
const RED = '#C00000'
const CHANNEL_LABELS: Record<string, string> = {
  in_app: 'In-App',
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
}
const CHANNELS = ['in_app', 'email', 'sms', 'whatsapp']

const CATEGORY_ORDER: Record<string, number> = {
  task: 0, birthday: 1, loan: 2, ticket: 3, deal: 4, crm: 5,
}
function categoryOf(eventType: string) { return eventType.split('_')[0] }
function categoryLabel(cat: string) {
  const m: Record<string, string> = {
    task: 'Tasks', birthday: 'Birthdays', loan: 'Loans',
    ticket: 'Helpdesk', deal: 'Deals', crm: 'CRM Requests',
  }
  return m[cat] ?? cat
}

interface CfgRow {
  event_type: string
  channel: string
  enabled: boolean
  label: string
  description: string
}

type CfgMap = Record<string, Record<string, boolean>>

export default function NotificationSettings() {
  const [rows, setRows] = useState<CfgRow[]>([])
  const [cfg, setCfg] = useState<CfgMap>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/admin/notification-settings', { credentials: 'include' })
      .then(r => r.json())
      .then((data: CfgRow[]) => {
        setRows(data)
        const map: CfgMap = {}
        data.forEach(r => {
          map[r.event_type] ??= {}
          map[r.event_type][r.channel] = r.enabled
        })
        setCfg(map)
      })
  }, [])

  const toggle = (eventType: string, channel: string) => {
    setCfg(c => ({
      ...c,
      [eventType]: { ...c[eventType], [channel]: !c[eventType]?.[channel] },
    }))
    setSaved(false)
  }

  const save = async () => {
    setSaving(true)
    const items = Object.entries(cfg).flatMap(([event_type, chans]) =>
      Object.entries(chans).map(([channel, enabled]) => ({ event_type, channel, enabled }))
    )
    await fetch('/api/admin/notification-settings', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const categories = Array.from(new Set(rows.map(r => categoryOf(r.event_type))))
    .sort((a, b) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99))

  const eventsByCategory: Record<string, string[]> = {}
  rows.forEach(r => {
    const cat = categoryOf(r.event_type)
    if (!eventsByCategory[cat]) eventsByCategory[cat] = []
    if (!eventsByCategory[cat].includes(r.event_type))
      eventsByCategory[cat].push(r.event_type)
  })

  const labelFor = (et: string) => rows.find(r => r.event_type === et)?.label ?? et
  const descFor  = (et: string) => rows.find(r => r.event_type === et)?.description ?? ''

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: NAVY }}>
          Notification Settings
        </h1>
        <p style={{ margin: '6px 0 0', color: 'var(--txt2)', fontSize: 14 }}>
          Set platform-wide defaults for each notification channel. Staff can override these in
          their personal preferences — but if you disable a channel here, it cannot be re-enabled
          by individual users.
        </p>
        <div style={{
          display: 'flex', gap: 8, alignItems: 'center', marginTop: 12,
          padding: '10px 14px', background: '#fef3c7', borderRadius: 6,
          border: '1px solid #fcd34d',
        }}>
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#d97706" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span style={{ fontSize: 13, color: '#92400e' }}>
            Disabling a channel here overrides all individual user preferences for that channel.
          </span>
        </div>
      </div>

      {categories.map(cat => (
        <div key={cat} style={{ marginBottom: 32 }}>
          <h2 style={{
            fontSize: 13, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: 'var(--txt2)', margin: '0 0 12px',
          }}>
            {categoryLabel(cat)}
          </h2>
          <div style={{
            background: 'var(--card)', borderRadius: 8,
            border: '1px solid var(--bdr)', overflow: 'hidden',
          }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr repeat(4, 80px)',
              padding: '10px 20px', background: 'var(--bg)',
              borderBottom: '1px solid var(--bdr)',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)' }}>Event</span>
              {CHANNELS.map(ch => (
                <span key={ch} style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textAlign: 'center',
                }}>
                  {CHANNEL_LABELS[ch]}
                </span>
              ))}
            </div>
            {eventsByCategory[cat]?.map((evt, i) => (
              <div key={evt} style={{
                display: 'grid', gridTemplateColumns: '1fr repeat(4, 80px)',
                padding: '14px 20px', alignItems: 'center',
                borderBottom: i < (eventsByCategory[cat].length - 1) ? '1px solid var(--bdr)' : 'none',
              }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--txt)' }}>
                    {labelFor(evt)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>
                    {descFor(evt)}
                  </div>
                </div>
                {CHANNELS.map(ch => {
                  const on = cfg[evt]?.[ch] ?? false
                  return (
                    <div key={ch} style={{ display: 'flex', justifyContent: 'center' }}>
                      <button
                        onClick={() => toggle(evt, ch)}
                        style={{
                          width: 40, height: 22, borderRadius: 11, border: 'none',
                          cursor: 'pointer', transition: 'background 0.2s',
                          background: on ? NAVY : 'var(--chip-bg)',
                          position: 'relative',
                        }}
                        title={on ? 'Enabled (global default)' : 'Disabled globally'}
                      >
                        <span style={{
                          position: 'absolute', top: 3,
                          left: on ? 21 : 3,
                          width: 16, height: 16, borderRadius: '50%',
                          background: 'var(--card)',
                          transition: 'left 0.2s',
                          display: 'block',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                        }} />
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      ))}

      {rows.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 0', color: 'var(--txt2)', fontSize: 14,
        }}>
          Loading settings...
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            background: RED, color: '#fff', border: 'none', borderRadius: 6,
            padding: '10px 24px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save Global Defaults'}
        </button>
        {saved && (
          <span style={{ color: '#166534', fontSize: 13, fontWeight: 500 }}>
            Global settings saved
          </span>
        )}
      </div>
    </div>
  )
}
