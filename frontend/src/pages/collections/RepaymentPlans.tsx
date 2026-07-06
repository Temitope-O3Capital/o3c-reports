import { useEffect, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Modal, Spinner, DateFilter, TblSearch } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, n, today, monthStart } from '../../lib/fmt'
import { BLUE, GREEN, RED, NAVY, MONO, SORA } from '../../lib/design'
import { IcoTune } from '../../lib/icons'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlanRow {
  id: number
  account_cif: string
  customer_name: string | null
  total_kobo: number
  paid_kobo: number
  instalment_count: number
  paid_count: number
  next_payment_date: string | null
  status: string
  agent_name: string | null
}

interface Instalment {
  id: number
  instalment_number: number
  due_date: string
  amount_kobo: number
  status: string
}

interface RepaymentKPIs {
  active: number
  on_track: number
  behind: number
  monthly_due_kobo: number
}

// ── Status pills ──────────────────────────────────────────────────────────────

const PLAN_STATUS: Record<string, { bg: string; color: string }> = {
  Active:    { bg: `${BLUE}1F`,  color: BLUE  },
  Completed: { bg: `${GREEN}1F`, color: GREEN },
  Defaulted: { bg: `${RED}1A`,  color: RED   },
}

function PlanPill({ status }: { status: string }) {
  const s = PLAN_STATUS[status] ?? { bg: 'rgba(75,85,99,.1)', color: '#6B7280' }
  return (
    <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', borderRadius: 3, padding: '2px 7px', background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  )
}

const INST_STATUS: Record<string, { bg: string; color: string }> = {
  Pending:   { bg: `${BLUE}1F`,  color: BLUE  },
  Scheduled: { bg: `${BLUE}1F`,  color: BLUE  },
  Paid:      { bg: `${GREEN}1F`, color: GREEN },
  Missed:    { bg: `${RED}1A`,  color: RED   },
}

function InstPill({ status }: { status: string }) {
  const s = INST_STATUS[status] ?? { bg: 'rgba(75,85,99,.1)', color: '#6B7280' }
  return (
    <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 700, borderRadius: 3, padding: '2px 7px', background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  )
}

// ── Sort icon ─────────────────────────────────────────────────────────────────

function SortIco({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <span style={{ color: RED, opacity: active ? 1 : 0.3, fontSize: 10, marginLeft: 3, verticalAlign: 'middle' }}>
      {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function InstalmentProgress({ paid, total }: { paid: number; total: number }) {
  const pct = total > 0 ? (paid / total) * 100 : 0
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)', marginBottom: 4 }}>{paid}/{total}</div>
      <div style={{ height: 4, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden', width: 72 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? GREEN : NAVY, borderRadius: 99 }} />
      </div>
    </div>
  )
}

// ── Pagination bar ────────────────────────────────────────────────────────────

function Pager({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size))
  if (pages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: MONO }}>
        {(page - 1) * size + 1}–{Math.min(page * size, total)} of {total}
      </span>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <button onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: page === 1 ? 'default' : 'pointer', fontFamily: SORA, opacity: page === 1 ? 0.4 : 1 }}>
          ← Prev
        </button>
        <span style={{ fontSize: 12, fontFamily: MONO, fontWeight: 600, color: 'var(--txt)', minWidth: 64, textAlign: 'center' }}>
          {page} / {pages}
        </span>
        <button onClick={() => onChange(Math.min(pages, page + 1))} disabled={page === pages}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: page === pages ? 'default' : 'pointer', fontFamily: SORA, opacity: page === pages ? 0.4 : 1 }}>
          Next →
        </button>
      </div>
    </div>
  )
}

// ── Field style ───────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: SORA, outline: 'none', boxSizing: 'border-box',
}

// ── New Plan Modal ────────────────────────────────────────────────────────────

function NewPlanModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [cif, setCif]                     = useState('')
  const [amountNaira, setAmountNaira]     = useState('')
  const [instalmentCount, setInstalmentCount] = useState('3')
  const [firstPaymentDate, setFirstPaymentDate] = useState('')
  const [notes, setNotes]                 = useState('')
  const [saving, setSaving]               = useState(false)
  const [err, setErr]                     = useState<string | null>(null)

  function reset() { setCif(''); setAmountNaira(''); setInstalmentCount('3'); setFirstPaymentDate(''); setNotes(''); setErr(null) }

  async function submit() {
    const kobo = Math.round(parseFloat(amountNaira) * 100)
    const count = parseInt(instalmentCount, 10)
    if (!cif.trim() || !kobo || !firstPaymentDate || !count) return
    setSaving(true); setErr(null)
    try {
      const baseEach = Math.floor(kobo / count)
      const remainder = kobo - baseEach * count
      const instalments = Array.from({ length: count }, (_, i) => {
        const d = new Date(firstPaymentDate)
        d.setMonth(d.getMonth() + i)
        return {
          due_date: d.toISOString().slice(0, 10),
          amount_kobo: i === count - 1 ? baseEach + remainder : baseEach,
        }
      })
      await apiPost('/api/collections-ops/repayment-plans', {
        account_cif: cif.trim(), notes, instalments,
      })
      toast.success('Repayment plan created')
      reset(); onCreated()
    } catch (e: any) { setErr(e.message ?? 'Failed to create plan') }
    finally { setSaving(false) }
  }

  const isValid = cif.trim().length > 0 && parseFloat(amountNaira) > 0 && firstPaymentDate.length > 0

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="New Repayment Plan" width={560}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={() => { reset(); onClose() }} style={{ padding: '7px 15px', borderRadius: 8, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: SORA }}>Cancel</button>
          <button onClick={submit} disabled={!isValid || saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: !isValid || saving ? 'not-allowed' : 'pointer', opacity: !isValid || saving ? 0.6 : 1, fontFamily: SORA }}>
            {saving && <Spinner size={13} color="#fff" />} Create Plan
          </button>
        </div>
      }
    >
      {err && <div style={{ padding: '10px 12px', borderRadius: 8, background: `${RED}1A`, color: RED, fontSize: 13, marginBottom: 14 }}>{err}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {[
          { label: 'Customer CIF', el: <input type="text" value={cif} onChange={e => setCif(e.target.value)} placeholder="e.g. CIF-00123" style={{ ...fieldStyle, height: 36 }} /> },
          { label: 'Total Amount ₦', el: <input type="number" value={amountNaira} onChange={e => setAmountNaira(e.target.value)} placeholder="e.g. 150000" min="0" style={{ ...fieldStyle, height: 36 }} /> },
          { label: 'Number of Instalments', el: (
            <select value={instalmentCount} onChange={e => setInstalmentCount(e.target.value)} style={{ ...fieldStyle, height: 36 }}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map(n => <option key={n} value={String(n)}>{n} instalment{n > 1 ? 's' : ''}</option>)}
            </select>
          )},
          { label: 'First Payment Date', el: <input type="date" value={firstPaymentDate} onChange={e => setFirstPaymentDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} /> },
          { label: <><span>Notes</span> <span style={{ fontWeight: 400, color: 'var(--txt3)' }}>(optional)</span></>, el: <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Additional notes…" style={{ ...fieldStyle, resize: 'vertical' }} /> },
        ].map(({ label, el }, i) => (
          <div key={i}>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: SORA }}>{label}</label>
            {el}
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ── Plan Detail Modal ─────────────────────────────────────────────────────────

function PlanDetailModal({ plan, open, onClose, onUpdated }: { plan: PlanRow | null; open: boolean; onClose: () => void; onUpdated: () => void }) {
  const [instalments, setInstalments] = useState<Instalment[]>([])
  const [instLoading, setInstLoading] = useState(false)
  const [markingId, setMarkingId]     = useState<number | null>(null)

  useEffect(() => {
    if (!plan || !open) return
    setInstLoading(true)
    apiFetch<{ data: Instalment[] }>(`/api/collections-ops/repayment-plans/${plan.id}/instalments`)
      .then(res => setInstalments(res.data ?? []))
      .catch(() => setInstalments([]))
      .finally(() => setInstLoading(false))
  }, [plan, open])

  async function markPaid(instId: number) {
    setMarkingId(instId)
    try {
      await apiPut(`/api/collections-ops/repayment-plans/instalments/${instId}/paid`, {})
      toast.success('Instalment marked as Paid')
      if (plan) {
        const res = await apiFetch<{ data: Instalment[] }>(`/api/collections-ops/repayment-plans/${plan.id}/instalments`)
        setInstalments(res.data ?? [])
      }
      onUpdated()
    } catch (e: any) { toast.error(e.message ?? 'Failed to mark instalment') }
    finally { setMarkingId(null) }
  }

  if (!plan) return null
  const remaining = n(plan.total_kobo) - n(plan.paid_kobo)

  const TH2: React.CSSProperties = { padding: '9px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' as const, color: 'var(--txt3)', borderBottom: '1px solid var(--bdr)', background: 'var(--bg)', fontFamily: MONO }

  return (
    <Modal open={open} onClose={onClose} title="Repayment Plan Detail" width={640}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, padding: '12px 16px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--bdr)' }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{plan.account_cif}</div>
          {plan.customer_name && <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2, fontFamily: SORA }}>{plan.customer_name}</div>}
        </div>
        <PlanPill status={plan.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Total Agreed', value: fmtKobo(plan.total_kobo) },
          { label: 'Paid So Far', value: fmtKobo(plan.paid_kobo) },
          { label: 'Remaining', value: fmtKobo(remaining) },
        ].map(({ label, value }) => (
          <div key={label} style={{ padding: '10px 12px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--txt3)', marginBottom: 4, fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{label}</div>
            <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 10, fontFamily: MONO }}>Instalments</div>
      {instLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 0', gap: 8, color: 'var(--txt2)', fontSize: 13, fontFamily: SORA }}>
          <Spinner size={16} color={NAVY} /> Loading…
        </div>
      ) : instalments.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--txt2)', padding: '16px 0', fontFamily: SORA }}>No instalments found.</div>
      ) : (
        <div style={{ border: '1px solid var(--bdr)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={TH2}>#</th>
                <th style={TH2}>Due Date</th>
                <th style={{ ...TH2, textAlign: 'right' }}>Amount</th>
                <th style={TH2}>Status</th>
                <th style={TH2} />
              </tr>
            </thead>
            <tbody>
              {instalments.map((inst, idx) => (
                <tr key={inst.id} style={{ background: idx % 2 ? 'var(--bg)' : undefined }}>
                  <td style={{ padding: '9px 12px', fontFamily: MONO, fontSize: 12, fontWeight: 600, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{inst.instalment_number}</td>
                  <td style={{ padding: '9px 12px', fontFamily: MONO, fontSize: 12, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)' }}>{fmtDate(inst.due_date)}</td>
                  <td style={{ padding: '9px 12px', fontFamily: MONO, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: 'var(--txt)', borderBottom: '1px solid var(--bdr)' }}>{fmtKobo(inst.amount_kobo)}</td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid var(--bdr)' }}><InstPill status={inst.status} /></td>
                  <td style={{ padding: '9px 12px', borderBottom: '1px solid var(--bdr)' }}>
                    {(inst.status === 'Pending' || inst.status === 'Scheduled') && (
                      <button onClick={() => markPaid(inst.id)} disabled={markingId === inst.id}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: `${GREEN}1F`, color: GREEN, opacity: markingId === inst.id ? 0.6 : 1, fontFamily: SORA }}>
                        {markingId === inst.id && <Spinner size={11} color={GREEN} />} Mark Paid
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportCsv(rows: PlanRow[]) {
  const header = ['CIF', 'Customer', 'Total (₦)', 'Paid (₦)', 'Instalments', 'Paid', 'Next Due', 'Status', 'Agent']
  const lines = rows.map(r => [
    r.account_cif ?? '', `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
    (r.total_kobo / 100).toFixed(2), (r.paid_kobo / 100).toFixed(2),
    r.instalment_count ?? '', r.paid_count ?? '',
    r.next_payment_date ?? '', r.status ?? '',
    `"${String(r.agent_name ?? '').replace(/"/g, '""')}"`,
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `repayment-plans-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main component ────────────────────────────────────────────────────────────

const PAGE_SIZE = 25

export default function RepaymentPlans() {
  const [rows, setRows]         = useState<PlanRow[]>([])
  const [kpis, setKpis]         = useState<RepaymentKPIs | null>(null)
  const [loading, setLoading]   = useState(true)

  const [search,      setSearch]      = useState('')
  const [filterOpen,  setFilterOpen]  = useState(false)
  const [statusSel,   setStatusSel]   = useState<Set<string>>(new Set())
  const [dateFrom,    setDateFrom]    = useState(monthStart())
  const [dateTo,      setDateTo]      = useState(today())
  const [sortKey,     setSortKey]     = useState<string | null>(null)
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('asc')
  const [page,        setPage]        = useState(1)

  const [showNewPlan, setShowNewPlan] = useState(false)
  const [detailPlan,  setDetailPlan]  = useState<PlanRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const p = new URLSearchParams({ limit: '500' })
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo)   p.set('date_to', dateTo)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: PlanRow[] }>(`/api/collections-ops/repayment-plans?${p}`),
        apiFetch<{ data: RepaymentKPIs }>('/api/collections/repayment-kpis'),
      ])
      const sorted = (res.data ?? []).slice().sort((a, b) => {
        if (!a.next_payment_date && !b.next_payment_date) return 0
        if (!a.next_payment_date) return 1
        if (!b.next_payment_date) return -1
        return new Date(a.next_payment_date).getTime() - new Date(b.next_payment_date).getTime()
      })
      setRows(sorted)
      setKpis(kpiRes.data)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, statusSel, dateFrom, dateTo])

  function toggleStatus(v: string) { setStatusSel(prev => { const next = new Set(prev); next.has(v) ? next.delete(v) : next.add(v); return next }) }
  function toggleSort(key: string) { if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir('asc') } }
  function resetFilters() { setSearch(''); setStatusSel(new Set()) }

  const activeCount = statusSel.size

  const filtered = useMemo(() => {
    let r = [...rows]
    if (search.trim()) {
      const q = search.toLowerCase()
      r = r.filter(x => (x.account_cif ?? '').toLowerCase().includes(q) || (x.customer_name ?? '').toLowerCase().includes(q))
    }
    if (statusSel.size) r = r.filter(x => statusSel.has(x.status))
    if (sortKey) r.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sortKey] ?? ''
      const vb = (b as unknown as Record<string, unknown>)[sortKey] ?? ''
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return r
  }, [rows, search, statusSel, sortKey, sortDir])

  const availableStatuses = useMemo(() => Array.from(new Set(rows.map(r => r.status))).filter(Boolean).sort(), [rows])
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  type Chip = { key: string; label: string; clear: () => void }
  const chips: Chip[] = [...statusSel].map(v => ({ key: v, label: v, clear: () => toggleStatus(v) }))

  const statusCount = (s: string) => rows.filter(r => r.status === s).length

  const TH: React.CSSProperties = {
    position: 'sticky', top: 0, background: 'var(--bg)',
    fontSize: 10, fontWeight: 600, letterSpacing: '.1em',
    textTransform: 'uppercase', color: 'var(--txt3)',
    textAlign: 'left', padding: '8px 14px',
    borderTop: '1px solid var(--bdr)', borderBottom: '1px solid var(--bdr)',
    zIndex: 2, whiteSpace: 'nowrap', cursor: 'pointer',
  }
  const TD: React.CSSProperties = { padding: '0 14px', height: 42, borderBottom: '1px solid var(--bdr)', fontSize: 12.5 }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, fontFamily: SORA }}>

      {/* ── Hero ── */}
      <section style={{ display: 'flex', alignItems: 'flex-end', gap: 48, flexWrap: 'wrap', padding: '26px 28px 24px', borderBottom: '1px solid var(--bdr)' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 8, fontFamily: MONO }}>
            Repayment Plans · {dateFrom && dateTo ? `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}` : 'All time'}
          </div>
          <div style={{ fontFamily: MONO, fontWeight: 600, fontSize: 46, lineHeight: 1, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>
            {loading && !kpis ? '—' : fmtNum(kpis?.active ?? rows.filter(r => r.status === 'Active').length)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500, marginTop: 8 }}>active plans</div>
        </div>

        <div style={{ display: 'flex', gap: 40, paddingBottom: 4, flexWrap: 'wrap' }}>
          {[
            ['On Track',    String(kpis?.on_track ?? '—'),                    '', 'meeting schedule'],
            ['Behind',      String(kpis?.behind ?? '—'),                      '', 'overdue next payment'],
            ['Monthly Due', fmtKobo(kpis?.monthly_due_kobo ?? 0),             '', 'this month'],
            ['Total Plans', String(fmtNum(rows.length)),                       '', 'all statuses'],
          ].map(([lbl, val, unit, sub]) => (
            <div key={lbl}>
              <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--txt3)', fontWeight: 600, marginBottom: 5, fontFamily: MONO }}>{lbl}</div>
              <div style={{ fontFamily: MONO, fontSize: 19, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)' }}>
                {loading && !kpis ? '—' : val}
                <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>{unit}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 3 }}>{sub}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Table section ── */}
      <section style={{ paddingBottom: 40 }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--bdr)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', marginRight: 4, whiteSpace: 'nowrap' }}>Plans</span>

          <TblSearch value={search} onChange={setSearch} placeholder="Search CIF or customer…" />

          <button onClick={() => setFilterOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, border: `1.5px solid ${activeCount > 0 ? RED : 'var(--bdr)'}`, background: 'transparent', color: activeCount > 0 ? RED : 'var(--txt2)', cursor: 'pointer', fontFamily: SORA, whiteSpace: 'nowrap', position: 'relative' }}>
            <IcoTune width={14} height={14} style={{ flexShrink: 0 }} />
            Filters
            {activeCount > 0 && <span style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: RED, color: '#fff', fontSize: 9, fontWeight: 700, fontFamily: MONO, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{activeCount}</span>}
          </button>

          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />

          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: MONO, whiteSpace: 'nowrap' }}>
            {filtered.length} of {rows.length}
          </span>

          <button onClick={() => exportCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: SORA, whiteSpace: 'nowrap' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV
          </button>

          <button onClick={() => setShowNewPlan(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: SORA, whiteSpace: 'nowrap' }}>
            + New Plan
          </button>
        </div>

        {/* Filter panel */}
        {filterOpen && (
          <div style={{ borderBottom: '1px solid var(--bdr)' }}>
            <div style={{ padding: '20px 20px 0' }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: MONO }}>Status</div>
              {availableStatuses.length === 0
                ? <div style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>No data yet</div>
                : availableStatuses.map(v => (
                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                    <input type="checkbox" checked={statusSel.has(v)} onChange={() => toggleStatus(v)} style={{ accentColor: NAVY, width: 14, height: 14, cursor: 'pointer', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: 'var(--txt)' }}>{v}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: MONO }}>{statusCount(v)}</span>
                  </label>
                ))
              }
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{activeCount === 0 ? `No filters applied — ${rows.length} rows` : `${activeCount} filter${activeCount !== 1 ? 's' : ''} active`}</span>
              <button onClick={resetFilters} style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: SORA }}>Reset</button>
              <button onClick={() => setFilterOpen(false)} style={{ padding: '5px 16px', borderRadius: 7, border: 'none', background: RED, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto', fontFamily: SORA }}>
                Done · {filtered.length} results
              </button>
            </div>
          </div>
        )}

        {/* Active chips */}
        {!filterOpen && chips.length > 0 && (
          <div style={{ padding: '8px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {chips.map(c => (
              <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: `${NAVY}18`, color: NAVY }}>
                {c.label}
                <span onClick={c.clear} style={{ cursor: 'pointer', fontSize: 11, lineHeight: 1, marginLeft: 2 }}>✕</span>
              </span>
            ))}
            <button onClick={resetFilters} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--txt3)', padding: 0, fontFamily: SORA }}>Clear all</button>
          </div>
        )}

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[
                  { key: 'account_cif',       label: 'Customer',     r: false, pl: 28 },
                  { key: 'total_kobo',         label: 'Total',        r: true  },
                  { key: 'paid_kobo',          label: 'Paid',         r: true  },
                  { key: '_remaining',         label: 'Remaining',    r: true, nosort: true },
                  { key: 'paid_count',         label: 'Instalments',  r: false, nosort: true },
                  { key: 'next_payment_date',  label: 'Next Payment', r: false },
                  { key: 'status',             label: 'Status',       r: false, nosort: true, pr: 28 },
                ].map(col => (
                  <th key={col.key} style={{ ...TH, ...(col.nosort ? { cursor: 'default' } : {}), ...(col.r ? { textAlign: 'right' } : {}), ...(col.pl ? { paddingLeft: col.pl } : {}), ...(col.pr ? { paddingRight: col.pr } : {}) }}
                    onClick={col.nosort ? undefined : () => toggleSort(col.key)}>
                    {col.label}{!col.nosort && <SortIco active={sortKey === col.key} dir={sortDir} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>{Array.from({ length: 7 }).map((_, j) => (
                    <td key={j} style={TD}><div style={{ height: 12, borderRadius: 4, background: 'var(--bdr)', width: j === 0 ? '60%' : '75%' }} /></td>
                  ))}</tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: 12.5 }}>No records match the current filters</td></tr>
              ) : pageRows.map(r => {
                const remaining = n(r.total_kobo) - n(r.paid_kobo)
                const isPast = r.next_payment_date && new Date(r.next_payment_date) < new Date()
                return (
                  <tr key={r.id} onClick={() => setDetailPlan(r)} style={{ cursor: 'pointer' }}
                    onMouseEnter={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = 'var(--row-hvr)' }) }}
                    onMouseLeave={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = '' }) }}>
                    <td style={{ ...TD, paddingLeft: 28 }}>
                      <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--txt2)' }}>{r.account_cif}</div>
                      {r.customer_name && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 1 }}>{r.customer_name}</div>}
                    </td>
                    <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{fmtKobo(r.total_kobo)}</td>
                    <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: GREEN }}>{fmtKobo(r.paid_kobo)}</td>
                    <td style={{ ...TD, textAlign: 'right', fontFamily: MONO, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: remaining > 0 ? RED : GREEN }}>{fmtKobo(remaining)}</td>
                    <td style={TD}><InstalmentProgress paid={r.paid_count} total={r.instalment_count} /></td>
                    <td style={{ ...TD, fontFamily: MONO, fontSize: 11.5, fontWeight: isPast ? 600 : 400, color: isPast ? RED : 'var(--txt)' }}>
                      {r.next_payment_date ? fmtDate(r.next_payment_date) : '—'}
                    </td>
                    <td style={{ ...TD, paddingRight: 28 }}><PlanPill status={r.status} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <Pager page={page} total={filtered.length} size={PAGE_SIZE} onChange={setPage} />
      </section>

      <NewPlanModal open={showNewPlan} onClose={() => setShowNewPlan(false)} onCreated={() => { setShowNewPlan(false); load() }} />
      <PlanDetailModal plan={detailPlan} open={detailPlan !== null} onClose={() => setDetailPlan(null)} onUpdated={load} />
    </div>
  )
}
