import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentDashboard {
  agent_name: string
  queue_count: number
  ptps_due_today: number
  broken_ptps: number
  calls_today: number
  calls_target: number
  dpd_distribution: Array<{ band: string; count: number }>
  my_accounts: Array<{
    id: number
    customer_name: string
    phone: string
    outstanding_kobo: number
    dpd: number
    last_contact: string | null
    next_action: string | null
  }>
}

const OUTCOMES = [
  { value: 'reached',       label: 'Reached' },
  { value: 'not_reached',   label: 'Not Reached' },
  { value: 'ptp',           label: 'Promise to Pay' },
  { value: 'broken_ptp',    label: 'Promise Broken' },
  { value: 'wrong_number',  label: 'Wrong Number' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function dpdColour(dpd: number): string {
  if (dpd >= 90) return '#7F1D1D'
  if (dpd >= 60) return RED
  if (dpd >= 30) return '#EA580C'
  if (dpd > 0)   return AMBER
  return GREEN
}

function fmtNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function Tile({ label, value, colour, sub }: { label: string; value: string | number; colour?: string; sub?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 110, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 16px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: colour ?? 'var(--txt)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── DPD Distribution ──────────────────────────────────────────────────────────

const DPD_BANDS = ['1-30', '31-60', '61-90', '90+']
const DPD_COLOURS: Record<string, string> = { '1-30': AMBER, '31-60': '#EA580C', '61-90': RED, '90+': '#7F1D1D' }

function DPDBar({ dist }: { dist: Array<{ band: string; count: number }> }) {
  const total = dist.reduce((s, d) => s + Number(d.count), 0)
  if (total === 0) return <div style={{ color: 'var(--txt3)', fontSize: 12.5 }}>No accounts in queue</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {DPD_BANDS.map(band => {
        const entry = dist.find(d => d.band === band)
        const count = Number(entry?.count ?? 0)
        const pct   = Math.round((count / total) * 100)
        const colour = DPD_COLOURS[band] ?? AMBER
        return (
          <div key={band} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 50, fontSize: 12, fontWeight: 600, color: colour, flexShrink: 0 }}>{band}</div>
            <div style={{ flex: 1, height: 12, background: 'var(--th-bg)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: colour, borderRadius: 4, transition: 'width .4s' }} />
            </div>
            <div style={{ width: 32, fontSize: 12, fontWeight: 700, color: colour, textAlign: 'right', flexShrink: 0 }}>{count}</div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AgentDashboard() {
  const [data, setData]   = useState<AgentDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Log call modal
  const [logAccount, setLogAccount] = useState<AgentDashboard['my_accounts'][0] | null>(null)
  const [outcome, setOutcome]       = useState('reached')
  const [notes, setNotes]           = useState('')
  const [logging, setLogging]       = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const d = await apiFetch<AgentDashboard>('/api/collections-ops/agent-dashboard')
      setData(d)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleLogCall() {
    if (!logAccount) return
    setLogging(true)
    try {
      await apiPost('/api/collections-ops/log-call', {
        account_id: logAccount.id,
        outcome,
        notes,
      })
      toast.success('Call logged')
      setLogAccount(null)
      setNotes('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setLogging(false) }
  }

  const callsTarget = data?.calls_target ?? 0
  const callsToday  = data?.calls_today  ?? 0
  const callsPct    = callsTarget > 0 ? Math.min(Math.round((callsToday / callsTarget) * 100), 100) : 0
  const callsColour = callsPct >= 100 ? GREEN : callsPct >= 50 ? AMBER : RED

  const cols: TableCol<AgentDashboard['my_accounts'][0]>[] = [
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    {
      key: 'phone', label: 'Phone',
      render: r => (
        <a href={`tel:${r.phone}`} style={{ color: NAVY, fontWeight: 600, textDecoration: 'none' }}>{r.phone}</a>
      ),
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding',
      render: r => <span style={{ fontWeight: 600 }}>{fmtNaira(r.outstanding_kobo)}</span>,
    },
    {
      key: 'dpd', label: 'DPD',
      render: r => (
        <span style={{ fontWeight: 700, color: dpdColour(r.dpd) }}>
          {r.dpd > 0 ? `${r.dpd}d` : 'Current'}
        </span>
      ),
    },
    {
      key: 'last_contact', label: 'Last Contact',
      render: r => r.last_contact ? fmtDate(r.last_contact) : <span style={{ color: 'var(--txt3)' }}>Never</span>,
    },
    {
      key: 'next_action', label: 'Next Action',
      render: r => r.next_action || <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'id', label: '',
      render: r => (
        <button
          onClick={() => { setLogAccount(r); setOutcome('reached'); setNotes('') }}
          style={{ padding: '4px 11px', borderRadius: 6, border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
        >
          Log Call
        </button>
      ),
    },
  ]

  if (loading) return <Page title="My Collections Dashboard"><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>

  return (
    <Page title="My Collections Dashboard" subtitle="Personal queue and performance">
      <ErrBanner error={error} onRetry={load} />

      {data && (
        <>
          {/* Stat strip */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <Tile label="Queue Size"      value={data.queue_count} />
            <Tile label="PTPs Due Today"  value={data.ptps_due_today}  colour={data.ptps_due_today > 0 ? AMBER : GREEN} />
            <Tile label="Broken PTPs"     value={data.broken_ptps}     colour={data.broken_ptps > 0 ? RED : GREEN} />
            <div style={{ flex: 1, minWidth: 160, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt3)', marginBottom: 4 }}>Calls Today</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: callsColour, lineHeight: 1, marginBottom: 6 }}>
                {callsToday} / {callsTarget}
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--th-bg)', overflow: 'hidden' }}>
                <div style={{ width: `${callsPct}%`, height: '100%', background: callsColour, borderRadius: 3, transition: 'width .4s' }} />
              </div>
            </div>
          </div>

          {/* DPD distribution */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16, marginBottom: 16 }}>
            <SectionCard title="DPD Distribution">
              <DPDBar dist={data.dpd_distribution} />
            </SectionCard>

            <SectionCard title="My Accounts">
              {data.my_accounts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt3)', fontSize: 13 }}>
                  No accounts assigned to you.
                </div>
              ) : (
                <DataTable cols={cols} rows={data.my_accounts} />
              )}
            </SectionCard>
          </div>
        </>
      )}

      {/* Log Call modal */}
      <Modal
        open={!!logAccount}
        onClose={() => setLogAccount(null)}
        title={`Log Call — ${logAccount?.customer_name ?? ''}`}
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleLogCall} disabled={logging}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: logging ? 'wait' : 'pointer', opacity: logging ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {logging && <Spinner size={13} color="#fff" />}
              Save
            </button>
            <button onClick={() => setLogAccount(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 6 }}>Outcome</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {OUTCOMES.map(o => (
                <button key={o.value} onClick={() => setOutcome(o.value)}
                  style={{
                    padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    border: `1.5px solid ${outcome === o.value ? NAVY : 'var(--bdr)'}`,
                    background: outcome === o.value ? NAVY : 'var(--card)',
                    color: outcome === o.value ? '#fff' : 'var(--txt)',
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Notes</label>
            <textarea
              value={notes} onChange={e => setNotes(e.target.value)}
              rows={3} placeholder="Optional call notes…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box' }}
            />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
