import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { Page, KpiCard, SectionCard, Spinner, ErrBanner } from '../../components/UI'

const NAVY  = '#0E2841'
const RED   = '#C00000'
const INTER = "'Inter', ui-sans-serif, sans-serif"
const MONO  = "'DM Mono', ui-monospace, monospace"

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  draft:    { label: 'Draft',    color: 'var(--txt2)', bg: 'var(--chip-bg)' },
  review:   { label: 'Review',  color: '#D97706',     bg: '#FEF3C722' },
  approved: { label: 'Approved',color: '#166534',     bg: '#DCFCE722' },
  paid:     { label: 'Paid',    color: NAVY,           bg: '#EFF6FF' },
}

function StatusChip({ status }: { status: string }) {
  const m = STATUS_META[status] ?? STATUS_META.draft
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, fontFamily: INTER, background: m.bg, color: m.color }}>
      {m.label}
    </span>
  )
}

function monthName(y: number, m: number) {
  return new Date(y, m - 1, 1).toLocaleString('en-NG', { month: 'long', year: 'numeric' })
}

export default function PayrollOverview() {
  const nav = useNavigate()
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState('')
  const [runs, setRuns]           = useState<any[]>([])
  const [activeEmp, setActiveEmp] = useState(0)
  const [creating, setCreating]   = useState(false)
  const [createErr, setCreateErr] = useState('')

  const now = new Date()
  const [newYear,  setNewYear]  = useState(now.getFullYear())
  const [newMonth, setNewMonth] = useState(now.getMonth() + 1)

  useEffect(() => {
    apiFetch('/api/payroll/summary').then(r => r.json()).then(d => {
      setRuns(d.runs ?? [])
      setActiveEmp(d.active_employees ?? 0)
    }).catch(() => setErr('Failed to load payroll summary')).finally(() => setLoading(false))
  }, [])

  async function createRun() {
    setCreating(true)
    setCreateErr('')
    try {
      const res = await apiFetch('/api/payroll/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_year: newYear, period_month: newMonth }),
      })
      if (!res.ok) {
        const d = await res.json()
        setCreateErr(d.detail ?? 'Failed to create run')
        return
      }
      const d = await res.json()
      nav(`/payroll/runs/${d.id}`)
    } catch {
      setCreateErr('Network error')
    } finally {
      setCreating(false)
    }
  }

  const latest = runs[0]
  const ytdNet = runs
    .filter(r => r.period_year === now.getFullYear() && r.status === 'paid')
    .reduce((s: number, r: any) => s + (r.total_net_kobo ?? 0), 0)

  return (
    <Page title="Payroll">
      {loading && <Spinner />}
      {err && <ErrBanner msg={err} />}
      {!loading && !err && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 24 }}>
            <KpiCard label="Active Employees" value={fmtNum(activeEmp)}                              icon="people"                 accent={NAVY} />
            <KpiCard label="Latest Gross"     value={latest ? fmtKobo(latest.total_gross_kobo) : '—'} icon="payments"               accent={NAVY} />
            <KpiCard label="Latest Net Pay"   value={latest ? fmtKobo(latest.total_net_kobo)   : '—'} icon="account_balance_wallet" accent={NAVY} />
            <KpiCard label="YTD Net Paid"     value={fmtKobo(ytdNet)}                              icon="bar_chart"              accent={NAVY} />
          </div>

          <SectionCard title="New Payroll Run">
            <div style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>Year</label>
                  <select value={newYear} onChange={e => setNewYear(+e.target.value)}
                    style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 13, outline: 'none' }}>
                    {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y =>
                      <option key={y} value={y}>{y}</option>
                    )}
                  </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>Month</label>
                  <select value={newMonth} onChange={e => setNewMonth(+e.target.value)}
                    style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 13, outline: 'none' }}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(m =>
                      <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleString('en', { month: 'long' })}</option>
                    )}
                  </select>
                </div>
                <button onClick={createRun} disabled={creating}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: creating ? 'not-allowed' : 'pointer', opacity: creating ? 0.7 : 1 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                    {creating ? 'hourglass_empty' : 'play_arrow'}
                  </span>
                  {creating ? 'Generating…' : 'Generate Run'}
                </button>
                {createErr && <span style={{ fontSize: 12, color: RED }}>{createErr}</span>}
              </div>
              <p style={{ marginTop: 10, fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER }}>
                Automatically computes gross, PAYE, pension (8%), NHF (2.5% of basic), and staff loan deductions for all {fmtNum(activeEmp)} active employees.
              </p>
            </div>
          </SectionCard>

          <div style={{ marginTop: 20 }}>
            <SectionCard title="Payroll History">
              {runs.length === 0 ? (
                <p style={{ padding: 20, color: 'var(--txt2)', fontSize: 13 }}>No payroll runs yet.</p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Period','Status','Headcount','Gross Pay','Net Pay','PAYE','Pension','Created'].map(h => (
                        <th key={h} style={{
                          padding: '10px 14px',
                          textAlign: h === 'Headcount' || h === 'Created' || h === 'Status' ? 'left' : 'right',
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                          color: 'var(--txt2)', background: 'var(--th-bg)', fontFamily: INTER,
                          whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)',
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r: any) => (
                      <tr key={r.id} onClick={() => nav(`/payroll/runs/${r.id}`)}
                        className="tbl-row" style={{ cursor: 'pointer', borderBottom: '1px solid var(--bdr)' }}>
                        <td style={{ padding: '12px 14px', fontWeight: 600, color: 'var(--txt)', whiteSpace: 'nowrap' }}>
                          {monthName(r.period_year, r.period_month)}
                        </td>
                        <td style={{ padding: '12px 14px' }}><StatusChip status={r.status} /></td>
                        <td style={{ padding: '12px 14px', color: 'var(--txt)', fontFamily: INTER }}>{fmtNum(r.headcount)}</td>
                        <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{fmtKobo(r.total_gross_kobo)}</td>
                        <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: MONO, fontWeight: 700, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{fmtKobo(r.total_net_kobo)}</td>
                        <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKobo(r.total_paye_kobo)}</td>
                        <td style={{ padding: '12px 14px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKobo(r.total_pension_kobo)}</td>
                        <td style={{ padding: '12px 14px', color: 'var(--txt2)', fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </Page>
  )
}
