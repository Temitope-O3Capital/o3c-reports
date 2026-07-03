import { useState } from 'react'
import { Page, SectionCard } from '../../components/UI'
import { RED, GREEN, AMBER, NAVY, INTER, SORA } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Integration {
  name: string
  type: string
  status: 'active' | 'degraded' | 'down' | 'unknown'
  last_ping?: string
  key_expiry?: string
  owner: string
  notes: string
}

// ── Stub data — Build Guide spec 7.76 ─────────────────────────────────────────

const INTEGRATIONS: Integration[] = [
  { name: 'SendGrid',         type: 'Email Delivery',    status: 'active',   last_ping: '2026-07-03 08:00', owner: 'IT Admin',    notes: 'Transactional email + campaigns. API key in api_credentials.' },
  { name: 'Zoho Voice',       type: 'Call Center',       status: 'active',   last_ping: '2026-07-03 08:00', owner: 'IT Admin',    notes: 'VoIP + call recording for contact centre.' },
  { name: 'Microsoft Graph',  type: 'Email Inbound',     status: 'active',   last_ping: '2026-07-03 07:00', owner: 'IT Admin',    notes: 'OAuth2 for reading inbound mail (helpdesk@o3cards.com).' },
  { name: 'Supabase',         type: 'Primary Database',  status: 'active',   last_ping: '2026-07-03 08:01', owner: 'IT Admin',    notes: 'PostgreSQL. Connection string in DATABASE_URL env var.' },
  { name: 'Railway',          type: 'Hosting / CI/CD',   status: 'active',   last_ping: '2026-07-03 08:00', owner: 'IT Admin',    notes: 'Backend API + workers hosted on Railway. Auto-deploy on push.' },
  { name: 'Cloudflare Pages', type: 'Frontend CDN',      status: 'active',   last_ping: '2026-07-03 08:00', owner: 'IT Admin',    notes: 'Frontend SPA deployed to Cloudflare Pages.' },
  { name: 'MSSQL Tunnel',     type: 'Card Data Source',  status: 'degraded', last_ping: '2026-07-03 07:55', owner: 'Cards Ops',   notes: 'Cloudflare Tunnel → on-site MSSQL for live card data. Intermittent.' },
  { name: 'Eye Service',      type: 'Credit Scoring',    status: 'active',   last_ping: '2026-07-03 08:00', owner: 'Risk Team',   notes: 'Internal ML service on port 8001. Key in EYE_SERVICE_KEY.' },
  { name: 'NIP / NIBSS',      type: 'Payment Rails',     status: 'unknown',  last_ping: undefined,          owner: 'Finance',     notes: 'NIP inter-bank settlement. Credentials pending from NIBSS.' },
  { name: 'WhatsApp API',     type: 'Messaging',         status: 'down',     last_ping: '2026-06-30 12:00', owner: 'Marketing',   notes: 'Meta WhatsApp Business API. Token expired — renew in Meta Business.' },
  { name: 'CRC Bureau',       type: 'Credit Bureau',     status: 'unknown',  last_ping: undefined,          owner: 'Risk Team',   notes: 'CRC credit bureau checks. Integration stub ready; API key needed.' },
  { name: 'FirstCentral',     type: 'Credit Bureau',     status: 'unknown',  last_ping: undefined,          owner: 'Risk Team',   notes: 'FirstCentral credit report integration. Not yet activated.' },
]

// ── Status dot ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { dot: string; txt: string; bg: string }> = {
  active:   { dot: GREEN, txt: GREEN,             bg: 'rgba(22,163,74,.1)'   },
  degraded: { dot: AMBER, txt: AMBER,             bg: 'rgba(217,119,6,.12)'  },
  down:     { dot: RED,   txt: RED,               bg: 'rgba(192,0,0,.1)'     },
  unknown:  { dot: '#9CA3AF', txt: '#6B7280',     bg: 'rgba(107,114,128,.1)' },
}

function StatusBadge({ status }: { status: Integration['status'] }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.unknown
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: c.txt, textTransform: 'capitalize' }}>{status}</span>
    </div>
  )
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({ integ, onClose }: { integ: Integration; onClose: () => void }) {
  const [notes, setNotes] = useState(integ.notes)

  function save() {
    toast.info('Integration registry requires persistent backend (Wave 5 admin DB tables)')
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 480, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>{integ.name}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          {[
            ['Type', integ.type],
            ['Owner', integ.owner],
            ['Status', integ.status],
            ['Last Ping', integ.last_ping ?? 'Never'],
          ].map(([l, v]) => (
            <div key={l}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 3 }}>{l}</div>
              <div style={{ fontSize: 13, color: 'var(--txt)', textTransform: l === 'Status' ? 'capitalize' : 'none' }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Notes</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            style={{ display: 'block', width: '100%', padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none', resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>Close</button>
          <button onClick={save} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER }}>Save Notes</button>
        </div>
      </div>
    </div>
  )
}

// ── Register modal ────────────────────────────────────────────────────────────

function RegisterModal({ onClose }: { onClose: () => void }) {
  function submit() {
    toast.info('Integration registry requires persistent backend (Wave 5 admin DB tables)')
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 440, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>Register Integration</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--txt2)', marginBottom: 20, background: 'var(--input-bg)', borderRadius: 8, padding: 12 }}>
          The integration registry will be backed by a dedicated database table in Wave 5. For now, new integrations should be added directly to the static list and the api_credentials table.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>Close</button>
          <button onClick={submit} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER }}>Add Integration</button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminIntegrations() {
  const [editing, setEditing]   = useState<Integration | null>(null)
  const [showNew, setShowNew]   = useState(false)
  const [typeFilter, setTypeFilter] = useState('')

  const types = [...new Set(INTEGRATIONS.map(i => i.type))].sort()
  const displayed = typeFilter ? INTEGRATIONS.filter(i => i.type === typeFilter) : INTEGRATIONS

  const active   = INTEGRATIONS.filter(i => i.status === 'active').length
  const degraded = INTEGRATIONS.filter(i => i.status === 'degraded').length
  const down     = INTEGRATIONS.filter(i => i.status === 'down').length
  const unknown  = INTEGRATIONS.filter(i => i.status === 'unknown').length

  async function ping(integ: Integration) {
    toast.info(`Ping ${integ.name}: live ping requires backend integration table (Wave 5)`)
  }

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Integrations"
      subtitle="External service registry — status, credentials, and health"
      actions={
        <button onClick={() => setShowNew(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9,
          border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          Register Integration
        </button>
      }
    >

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Active',   value: active,   color: GREEN },
          { label: 'Degraded', value: degraded, color: AMBER },
          { label: 'Down',     value: down,     color: RED   },
          { label: 'Unknown',  value: unknown,  color: '#9CA3AF' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px' }}>{label}</div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Info banner */}
      <div style={{ background: 'rgba(14,40,65,.07)', border: '1px solid rgba(14,40,65,.15)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY, flexShrink: 0, marginTop: 1 }}>info</span>
        <div style={{ fontSize: 12.5, color: 'var(--txt2)' }}>
          Status shown is from the last known ping. Live health checks and persistent registry data will be available in Wave 5. Current data is seeded from platform configuration.
        </div>
      </div>

      <SectionCard title="All Integrations" badge={displayed.length} padding={false}
        actions={
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        }
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--th-bg)' }}>
              {['Integration', 'Type', 'Status', 'Last Ping', 'Owner', 'Notes', ''].map(h => (
                <th key={h} style={{ padding: '10px 18px', textAlign: 'left', fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.map(integ => (
              <tr key={integ.name} style={{ borderBottom: '1px solid var(--bdr)' }}>
                <td style={{ padding: '12px 18px', fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{integ.name}</td>
                <td style={{ padding: '12px 18px' }}>
                  <span style={{ fontSize: 12, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: 6, padding: '2px 9px', fontWeight: 600 }}>{integ.type}</span>
                </td>
                <td style={{ padding: '12px 18px' }}><StatusBadge status={integ.status} /></td>
                <td style={{ padding: '12px 18px', fontSize: 12, color: 'var(--txt3)' }}>{integ.last_ping ?? '—'}</td>
                <td style={{ padding: '12px 18px', fontSize: 12.5, color: 'var(--txt2)' }}>{integ.owner}</td>
                <td style={{ padding: '12px 18px', fontSize: 12, color: 'var(--txt3)', maxWidth: 240 }}>
                  <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}>
                    {integ.notes}
                  </span>
                </td>
                <td style={{ padding: '12px 18px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => ping(integ)} style={{ padding: '3px 10px', borderRadius: 6, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 11.5, cursor: 'pointer' }}>Ping</button>
                    <button onClick={() => setEditing(integ)} style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: `${NAVY}12`, color: NAVY, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      {editing && <EditModal integ={editing} onClose={() => setEditing(null)} />}
      {showNew  && <RegisterModal onClose={() => setShowNew(false)} />}
    </Page>
  )
}

