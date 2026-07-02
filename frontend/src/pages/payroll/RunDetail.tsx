import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { Page, KpiCard, SectionCard, Spinner, ErrBanner, ConfirmModal } from '../../components/UI'

const NAVY  = '#0E2841'
const RED   = '#C00000'
const INTER = "'Inter', ui-sans-serif, sans-serif"
const MONO  = "'DM Mono', ui-monospace, monospace"

const STATUS_FLOW: Record<string, { next: string; label: string; action: string }> = {
  draft:    { next: 'review',   label: 'Submit for Review', action: 'submit'  },
  review:   { next: 'approved', label: 'Approve Run',       action: 'approve' },
  approved: { next: 'paid',     label: 'Mark as Paid',      action: 'pay'     },
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--txt2)', review: '#D97706', approved: '#166534', paid: NAVY,
}

interface Run {
  id: number; period_year: number; period_month: number; status: string
  headcount: number; total_gross_kobo: number; total_net_kobo: number
  total_paye_kobo: number; total_pension_kobo: number; total_nhf_kobo: number
  total_loan_deduction_kobo: number; notes: string | null
  created_by_name: string | null; approved_by_name: string | null
  created_at: string; approved_at: string | null; paid_at: string | null
}

interface Item {
  id: number; employee_id: number; employee_name: string; staff_id: string
  department: string; grade_level: string; job_title: string
  bank_name: string | null; account_number: string | null
  gross_kobo: number; basic_kobo: number; paye_kobo: number
  employee_pension_kobo: number; nhf_kobo: number
  loan_deduction_kobo: number; other_deduction_kobo: number; net_kobo: number
  notes: string | null
}

function monthName(y: number, m: number) {
  return new Date(y, m - 1, 1).toLocaleString('en-NG', { month: 'long', year: 'numeric' })
}

export default function PayrollRunDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [run, setRun]       = useState<Run | null>(null)
  const [items, setItems]   = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState('')
  const [acting, setActing] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; msg: string; fn: () => void } | null>(null)
  const [search, setSearch] = useState('')
  const [editItem, setEditItem] = useState<Item | null>(null)
  const [editOtherDed, setEditOtherDed] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  async function load() {
    try {
      const [r, it] = await Promise.all([
        apiFetch(`/api/payroll/runs/${id}`).then(r => r.json()),
        apiFetch(`/api/payroll/runs/${id}/items`).then(r => r.json()),
      ])
      setRun(r)
      setItems(Array.isArray(it) ? it : [])
    } catch {
      setErr('Failed to load payroll run')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  async function advance(action: string) {
    setActing(true)
    try {
      await apiFetch(`/api/payroll/runs/${id}/${action}`, { method: 'POST' })
      await load()
    } catch {
      setErr('Action failed')
    } finally {
      setActing(false)
      setConfirm(null)
    }
  }

  async function saveEdit() {
    if (!editItem) return
    setEditSaving(true)
    try {
      await apiFetch(`/api/payroll/runs/${id}/items/${editItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ other_deduction_kobo: Math.round(parseFloat(editOtherDed || '0') * 100) }),
      })
      setEditItem(null)
      await load()
    } catch {
      setErr('Failed to save')
    } finally {
      setEditSaving(false)
    }
  }

  const flow = run ? STATUS_FLOW[run.status] : null
  const filtered = items.filter(i =>
    !search || i.employee_name.toLowerCase().includes(search.toLowerCase()) ||
    (i.staff_id ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (i.department ?? '').toLowerCase().includes(search.toLowerCase())
  )

  const deptGroups = Array.from(new Set(items.map(i => i.department ?? 'Unknown'))).sort()

  return (
    <Page
      title={run ? monthName(run.period_year, run.period_month) : 'Payroll Run'}
      dept="Payroll" deptPath="/payroll"
    >
      {loading && <Spinner />}
      {err && <ErrBanner msg={err} />}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.msg}
          confirmLabel="Confirm"
          onConfirm={confirm.fn}
          onCancel={() => setConfirm(null)}
        />
      )}

      {run && !loading && (
        <>
          {/* Status bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: STATUS_COLOR[run.status], textTransform: 'uppercase', letterSpacing: 0.6, fontFamily: INTER }}>
                {run.status}
              </span>
              {run.approved_by_name && (
                <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
                  Approved by {run.approved_by_name} · {fmtDate(run.approved_at)}
                </span>
              )}
              {run.paid_at && (
                <span style={{ fontSize: 12, color: NAVY, fontFamily: INTER }}>
                  Paid {fmtDate(run.paid_at)}
                </span>
              )}
            </div>
            {flow && (
              <button
                disabled={acting}
                onClick={() => setConfirm({ title: flow.label, msg: `Proceed to ${flow.next} this payroll run for ${monthName(run.period_year, run.period_month)}?`, fn: () => advance(flow.action) })}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 20px', borderRadius: 9, border: 'none', background: flow.action === 'pay' ? RED : NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: acting ? 'not-allowed' : 'pointer', opacity: acting ? 0.7 : 1 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                  {flow.action === 'submit' ? 'send' : flow.action === 'approve' ? 'check_circle' : 'payments'}
                </span>
                {flow.label}
              </button>
            )}
          </div>

          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12, marginBottom: 24 }}>
            <KpiCard label="Headcount"     value={fmtNum(run.headcount)}                        icon="people"         accent={NAVY} />
            <KpiCard label="Gross Pay"     value={fmtKobo(run.total_gross_kobo)}                icon="payments"       accent={NAVY} />
            <KpiCard label="Net Pay"       value={fmtKobo(run.total_net_kobo)}                  icon="account_balance_wallet" accent={NAVY} />
            <KpiCard label="PAYE"          value={fmtKobo(run.total_paye_kobo)}                 icon="receipt_long"   accent={RED} />
            <KpiCard label="Pension (EE)"  value={fmtKobo(run.total_pension_kobo)}              icon="savings"        accent={NAVY} />
            <KpiCard label="Loan Deductions" value={fmtKobo(run.total_loan_deduction_kobo)}     icon="money_off"      accent={RED} />
          </div>

          {/* Items table */}
          <SectionCard
            title={`Payroll Items (${fmtNum(items.length)})`}
            actions={
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search employee…"
                style={{ padding: '6px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 12.5, outline: 'none', width: 200 }}
              />
            }
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  {['Employee','Dept','Grade','Gross','Basic','PAYE','Pension','NHF','Loan Ded.','Other Ded.','Net Pay',''].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: h === 'Employee' || h === 'Dept' || h === 'Grade' || h === '' ? 'left' : 'right', fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--txt2)', background: 'var(--th-bg)', fontFamily: INTER, whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deptGroups.map(dept => {
                  const deptItems = filtered.filter(i => (i.department ?? 'Unknown') === dept)
                  if (deptItems.length === 0) return null
                  const deptNet = deptItems.reduce((s, i) => s + i.net_kobo, 0)
                  return [
                    <tr key={`dept-${dept}`}>
                      <td colSpan={12} style={{ padding: '8px 12px', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--txt2)', background: 'var(--th-bg)', fontFamily: INTER }}>
                        {dept} — {deptItems.length} staff · Net {fmtKobo(deptNet)}
                      </td>
                    </tr>,
                    ...deptItems.map((item) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid var(--bdr)' }} className="tbl-row">
                        <td style={{ padding: '10px 12px', color: 'var(--txt)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          <div>{item.employee_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>{item.staff_id} · {item.job_title}</div>
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{item.department ?? '—'}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{item.grade_level ?? '—'}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{fmtKobo(item.gross_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKobo(item.basic_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKobo(item.paye_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKobo(item.employee_pension_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKobo(item.nhf_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: item.loan_deduction_kobo > 0 ? RED : 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKobo(item.loan_deduction_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, color: item.other_deduction_kobo > 0 ? RED : 'var(--txt2)', whiteSpace: 'nowrap' }}>
                          {fmtKobo(item.other_deduction_kobo)}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: MONO, fontWeight: 700, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{fmtKobo(item.net_kobo)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'left' }}>
                          {(run.status === 'draft' || run.status === 'review') && (
                            <button
                              onClick={() => { setEditItem(item); setEditOtherDed(String(item.other_deduction_kobo / 100)) }}
                              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--txt2)', padding: 2 }}>
                              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>edit</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    )),
                  ]
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={12} style={{ padding: 24, textAlign: 'center', color: 'var(--txt2)' }}>No items found</td></tr>
                )}
              </tbody>
            </table>
          </SectionCard>
        </>
      )}

      {/* Edit deduction modal */}
      {editItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setEditItem(null)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--card)', borderRadius: 14, border: '1px solid var(--card-bdr)', padding: 28, width: 380, boxShadow: 'var(--card-shadow)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)', marginBottom: 4 }}>Edit Deductions</div>
            <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 18, fontFamily: INTER }}>{editItem.employee_name}</div>
            <label style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER, display: 'block', marginBottom: 6 }}>Other Deduction (₦)</label>
            <input
              type="number" min="0" step="0.01"
              value={editOtherDed}
              onChange={e => setEditOtherDed(e.target.value)}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 14, fontFamily: MONO, outline: 'none', marginBottom: 20 }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditItem(null)}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={saveEdit} disabled={editSaving}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: editSaving ? 'not-allowed' : 'pointer', opacity: editSaving ? 0.7 : 1 }}>
                {editSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
