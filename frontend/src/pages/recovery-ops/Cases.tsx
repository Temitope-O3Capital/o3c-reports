import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/fmt'
import {
  Spinner, ErrBanner, StatusBadge, KpiCard, Page, SectionCard, ColDef, DataTable,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────
interface RecoveryCase {
  id: string
  case_ref: string
  account_cif: string
  agent_name: string
  legal_stage: string
  outstanding_kobo: number
  recovered_kobo: number
  write_off_amount_kobo: number
  status: string
  opened_at: string
  created_at: string
}

interface Dashboard {
  total_open: number
  total_outstanding_kobo: number
  total_recovered_kobo: number
  pending_write_offs: number
  visits_this_month: number
}

interface CaseDetail {
  case: RecoveryCase
  payments: any[]
  legal_proceedings: any[]
  field_visits: any[]
  write_off: any | null
}

const LEGAL_STAGES = ['', 'pre_legal', 'letter_of_demand', 'court_filing', 'hearing', 'garnishee', 'judgment', 'closed']
const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'cheque']
const PROCEEDING_TYPES = ['letter_of_demand', 'court_filing', 'hearing', 'garnishee', 'judgment']
const VISIT_TYPES = ['field_visit', 'office_visit', 'phone_call']

type DrawerTab = 'payments' | 'legal' | 'visits'

export default function Cases() {
  const [cases, setCases]     = useState<RecoveryCase[]>([])
  const [dash, setDash]       = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  // filters
  const [statusF, setStatusF]     = useState('')
  const [legalF, setLegalF]       = useState('')
  const [search, setSearch]       = useState('')
  const [page, setPage]           = useState(0)
  const limit = 50

  // expanded drawer
  const [expanded, setExpanded]   = useState<string | null>(null)
  const [detail, setDetail]       = useState<CaseDetail | null>(null)
  const [detailL, setDetailL]     = useState(false)
  const [tab, setTab]             = useState<DrawerTab>('payments')

  // payment form
  const [payAmt, setPayAmt]         = useState('')
  const [payDate, setPayDate]       = useState('')
  const [payMethod, setPayMethod]   = useState('transfer')
  const [payRef, setPayRef]         = useState('')
  const [payErr, setPayErr]         = useState('')
  const [payBusy, setPayBusy]       = useState(false)

  // legal form
  const [legalType, setLegalType]   = useState('letter_of_demand')
  const [court, setCourt]           = useState('')
  const [caseNum, setCaseNum]       = useState('')
  const [filingDate, setFilingDate] = useState('')
  const [hearingDate, setHearingDate] = useState('')
  const [legalNotes, setLegalNotes] = useState('')
  const [legalErr, setLegalErr]     = useState('')
  const [legalBusy, setLegalBusy]   = useState(false)

  // visit form
  const [visitDate, setVisitDate]   = useState('')
  const [visitType, setVisitType]   = useState('field_visit')
  const [visitOutcome, setVisitOutcome] = useState('')
  const [visitNotes, setVisitNotes] = useState('')
  const [visitErr, setVisitErr]     = useState('')
  const [visitBusy, setVisitBusy]   = useState(false)

  // write-off form
  const [woAmt, setWoAmt]           = useState('')
  const [woReason, setWoReason]     = useState('')
  const [woErr, setWoErr]           = useState('')
  const [woBusy, setWoBusy]         = useState(false)

  // write-off approval
  const [woApproveNotes, setWoApproveNotes] = useState('')
  const [woActBusy, setWoActBusy]           = useState(false)
  const [woActErr, setWoActErr]             = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
        ...(statusF ? { status: statusF }       : {}),
        ...(legalF  ? { legal_stage: legalF }   : {}),
        ...(search  ? { q: search }             : {}),
      })
      const [cRes, dRes] = await Promise.all([
        apiFetch<{ data: RecoveryCase[] } | RecoveryCase[]>(`/api/recovery-ops/cases?${params}`),
        apiFetch<Dashboard>('/api/recovery-ops/dashboard'),
      ])
      setCases(Array.isArray(cRes) ? cRes : (cRes.data ?? []))
      setDash(dRes)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusF, legalF, search, page])

  useEffect(() => { load() }, [load])

  async function expandCase(id: string) {
    if (expanded === id) { setExpanded(null); setDetail(null); return }
    setExpanded(id); setDetail(null); setDetailL(true)
    try {
      const res = await apiFetch<CaseDetail>(`/api/recovery-ops/cases/${id}`)
      setDetail(res)
    } finally {
      setDetailL(false)
    }
  }

  function currentCase(): RecoveryCase | undefined {
    return cases.find(c => c.id === expanded)
  }

  async function submitPayment() {
    if (!expanded) return
    setPayBusy(true); setPayErr('')
    try {
      await apiPost(`/api/recovery-ops/cases/${expanded}/payment`, {
        amount_kobo: Math.round(parseFloat(payAmt) * 100),
        payment_date: payDate,
        payment_method: payMethod,
        receipt_ref: payRef,
      })
      setPayAmt(''); setPayDate(''); setPayRef('')
      expandCase(expanded)
    } catch (e: any) {
      setPayErr(e.message)
    } finally {
      setPayBusy(false)
    }
  }

  async function submitLegal() {
    if (!expanded) return
    setLegalBusy(true); setLegalErr('')
    try {
      await apiPost(`/api/recovery-ops/cases/${expanded}/legal`, {
        proceeding_type: legalType,
        court_name: court,
        case_number: caseNum,
        filing_date: filingDate,
        next_hearing_date: hearingDate || undefined,
        notes: legalNotes,
      })
      setCourt(''); setCaseNum(''); setFilingDate(''); setHearingDate(''); setLegalNotes('')
      expandCase(expanded)
    } catch (e: any) {
      setLegalErr(e.message)
    } finally {
      setLegalBusy(false)
    }
  }

  async function submitVisit() {
    if (!expanded) return
    setVisitBusy(true); setVisitErr('')
    try {
      await apiPost(`/api/recovery-ops/cases/${expanded}/visit`, {
        visit_date: visitDate,
        visit_type: visitType,
        outcome: visitOutcome,
        notes: visitNotes,
      })
      setVisitDate(''); setVisitOutcome(''); setVisitNotes('')
      expandCase(expanded)
    } catch (e: any) {
      setVisitErr(e.message)
    } finally {
      setVisitBusy(false)
    }
  }

  async function submitWriteOff() {
    if (!expanded) return
    setWoBusy(true); setWoErr('')
    try {
      await apiPost(`/api/recovery-ops/cases/${expanded}/write-off`, {
        amount_kobo: Math.round(parseFloat(woAmt) * 100),
        reason: woReason,
      })
      setWoAmt(''); setWoReason('')
      expandCase(expanded)
    } catch (e: any) {
      setWoErr(e.message)
    } finally {
      setWoBusy(false)
    }
  }

  async function actWriteOff(wid: string, action: 'approve' | 'reject') {
    setWoActBusy(true); setWoActErr('')
    try {
      await apiPut(`/api/recovery-ops/write-off/${wid}/${action}`, { notes: woApproveNotes })
      setWoApproveNotes('')
      if (expanded) expandCase(expanded)
    } catch (e: any) {
      setWoActErr(e.message)
    } finally {
      setWoActBusy(false)
    }
  }

  const d = dash

  const cols: ColDef<RecoveryCase>[] = [
    { key: 'case_ref',   label: 'Case Ref', render: r => <span className="font-mono text-[12px]">{r.case_ref}</span> },
    { key: 'account_cif', label: 'CIF',    render: r => <span className="font-mono text-[12px] text-slate-500">{r.account_cif}</span> },
    { key: 'agent_name', label: 'Agent' },
    { key: 'legal_stage', label: 'Legal Stage', render: r => <StatusBadge status={r.legal_stage} /> },
    { key: 'outstanding_kobo', label: 'Outstanding', right: true, render: r => <span className="font-mono font-semibold">{fmt(r.outstanding_kobo / 100)}</span> },
    { key: 'recovered_kobo',   label: 'Recovered',   right: true, render: r => <span className="font-mono font-semibold" style={{ color: GREEN }}>{fmt(r.recovered_kobo / 100)}</span> },
    { key: 'status',  label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: 'opened_at', label: 'Opened', render: r => fmtDate(r.opened_at) },
    {
      key: '_expand', label: '', sortable: false,
      render: r => (
        <button onClick={e => { e.stopPropagation(); expandCase(r.id) }}
          className="text-slate-400 hover:text-slate-700">
          <span className="material-symbols-rounded text-[18px]">
            {expanded === r.id ? 'expand_less' : 'expand_more'}
          </span>
        </button>
      ),
    },
  ]

  return (
    <Page
      dept="Recovery Ops"
      title="Case Management"
      subtitle="Track recovery cases, payments, legal proceedings and field visits"
    >
      <ErrBanner msg={error} />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <KpiCard label="Total Open"       value={String(d?.total_open ?? '—')}                        icon="folder_open"    accent={NAVY}  loading={loading && !d} />
        <KpiCard label="Total Outstanding" value={d ? fmt(d.total_outstanding_kobo / 100) : '—'}      icon="account_balance" accent={RED}   loading={loading && !d} />
        <KpiCard label="Total Recovered"   value={d ? fmt(d.total_recovered_kobo / 100) : '—'}        icon="savings"        accent={GREEN} loading={loading && !d} />
        <KpiCard label="Pending Write-offs" value={String(d?.pending_write_offs ?? '—')}              icon="do_not_disturb" accent={AMBER} loading={loading && !d} />
        <KpiCard label="Visits This Month"  value={String(d?.visits_this_month ?? '—')}               icon="directions_car" accent={NAVY}  loading={loading && !d} />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-black/[0.06] shadow-sm p-4 mb-4">
        <div className="flex flex-wrap gap-3">
          <input
            className="w-full max-w-xs px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
            placeholder="Search by CIF or case ref…"
            value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} />
          <select className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
            value={statusF} onChange={e => { setStatusF(e.target.value); setPage(0) }}>
            <option value="">All Statuses</option>
            {['open', 'closed', 'written_off', 'settled'].map(s => <option key={s} value={s}>{snake(s)}</option>)}
          </select>
          <select className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
            value={legalF} onChange={e => { setLegalF(e.target.value); setPage(0) }}>
            <option value="">All Legal Stages</option>
            {LEGAL_STAGES.filter(Boolean).map(s => <option key={s} value={s}>{snake(s)}</option>)}
          </select>
        </div>
      </div>

      <SectionCard title="Cases" badge={cases.length}>
        <DataTable cols={cols} rows={cases} loading={loading} emptyIcon="folder_open" emptyMsg="No cases found" />

        {/* Expandable drawer */}
        {expanded && (
          <div className="border-t border-slate-200 bg-slate-50">
            <div className="px-5 py-4">
              {detailL && <div className="flex items-center justify-center py-10"><Spinner size={28} /></div>}
              {!detailL && detail && (
                <>
                  {/* Case summary bar */}
                  <div className="flex flex-wrap gap-4 mb-4 text-[13px]">
                    <span><span className="text-slate-400">Case: </span><strong>{detail.case.case_ref}</strong></span>
                    <span><span className="text-slate-400">CIF: </span><span className="font-mono">{detail.case.account_cif}</span></span>
                    <span><span className="text-slate-400">Agent: </span>{detail.case.agent_name}</span>
                    <span><span className="text-slate-400">Outstanding: </span><span className="font-semibold font-mono" style={{ color: RED }}>{fmt(detail.case.outstanding_kobo / 100)}</span></span>
                    <span><span className="text-slate-400">Recovered: </span><span className="font-semibold font-mono" style={{ color: GREEN }}>{fmt(detail.case.recovered_kobo / 100)}</span></span>
                  </div>

                  {/* Tabs */}
                  <div className="flex gap-1 mb-4">
                    {(['payments', 'legal', 'visits'] as DrawerTab[]).map(t => (
                      <button key={t}
                        onClick={() => setTab(t)}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-semibold capitalize transition-colors"
                        style={{
                          background: tab === t ? NAVY : 'rgba(14,40,65,0.06)',
                          color: tab === t ? '#fff' : '#475569',
                        }}>
                        {t}
                      </button>
                    ))}
                  </div>

                  {/* Payments tab */}
                  {tab === 'payments' && (
                    <div>
                      {detail.payments.length === 0
                        ? <p className="text-[13px] text-slate-400 mb-4">No payments recorded</p>
                        : (
                          <div className="space-y-2 mb-4">
                            {detail.payments.map((p: any, i: number) => (
                              <div key={i} className="flex items-center justify-between bg-white rounded-lg px-4 py-2 border border-slate-100">
                                <span className="text-[13px] text-slate-700">{fmtDate(p.payment_date)} · {p.payment_method} · {p.receipt_ref || '—'}</span>
                                <span className="font-mono font-semibold text-[13px]" style={{ color: GREEN }}>{fmt(p.amount_kobo / 100)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Add Payment</p>
                      <ErrBanner msg={payErr} />
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Amount (₦)</label>
                          <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={payAmt} onChange={e => setPayAmt(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Date</label>
                          <input type="date" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={payDate} onChange={e => setPayDate(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Method</label>
                          <select className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                            {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Receipt Ref</label>
                          <input type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={payRef} onChange={e => setPayRef(e.target.value)} />
                        </div>
                      </div>
                      <button
                        className="mt-3 px-4 py-2 rounded-lg text-[12px] font-semibold text-white disabled:opacity-60"
                        style={{ background: GREEN }}
                        disabled={payBusy || !payAmt || !payDate}
                        onClick={submitPayment}>
                        {payBusy ? 'Saving…' : 'Add Payment'}
                      </button>
                    </div>
                  )}

                  {/* Legal tab */}
                  {tab === 'legal' && (
                    <div>
                      {detail.legal_proceedings.length === 0
                        ? <p className="text-[13px] text-slate-400 mb-4">No legal proceedings recorded</p>
                        : (
                          <div className="space-y-2 mb-4">
                            {detail.legal_proceedings.map((p: any, i: number) => (
                              <div key={i} className="bg-white rounded-lg px-4 py-2.5 border border-slate-100">
                                <div className="flex items-center justify-between">
                                  <span className="text-[13px] font-semibold text-slate-700">{snake(p.proceeding_type)}</span>
                                  <StatusBadge status={p.status ?? 'pending'} />
                                </div>
                                <p className="text-[12px] text-slate-500 mt-0.5">{p.court_name} · #{p.case_number} · Filed {fmtDate(p.filing_date)}</p>
                                {p.next_hearing_date && <p className="text-[11px] text-slate-400 mt-0.5">Next hearing: {fmtDate(p.next_hearing_date)}</p>}
                              </div>
                            ))}
                          </div>
                        )}
                      <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Add Proceeding</p>
                      <ErrBanner msg={legalErr} />
                      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Type</label>
                          <select className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={legalType} onChange={e => setLegalType(e.target.value)}>
                            {PROCEEDING_TYPES.map(t => <option key={t} value={t}>{snake(t)}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Court Name</label>
                          <input type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={court} onChange={e => setCourt(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Case Number</label>
                          <input type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={caseNum} onChange={e => setCaseNum(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Filing Date</label>
                          <input type="date" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={filingDate} onChange={e => setFilingDate(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Next Hearing Date</label>
                          <input type="date" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={hearingDate} onChange={e => setHearingDate(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Notes</label>
                          <input type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={legalNotes} onChange={e => setLegalNotes(e.target.value)} />
                        </div>
                      </div>
                      <button
                        className="mt-3 px-4 py-2 rounded-lg text-[12px] font-semibold text-white disabled:opacity-60"
                        style={{ background: NAVY }}
                        disabled={legalBusy || !court || !caseNum || !filingDate}
                        onClick={submitLegal}>
                        {legalBusy ? 'Saving…' : 'Add Proceeding'}
                      </button>
                    </div>
                  )}

                  {/* Visits tab */}
                  {tab === 'visits' && (
                    <div>
                      {detail.field_visits.length === 0
                        ? <p className="text-[13px] text-slate-400 mb-4">No visits recorded</p>
                        : (
                          <div className="space-y-2 mb-4">
                            {detail.field_visits.map((v: any, i: number) => (
                              <div key={i} className="bg-white rounded-lg px-4 py-2.5 border border-slate-100">
                                <div className="flex items-center justify-between">
                                  <span className="text-[13px] font-semibold text-slate-700">{snake(v.visit_type)}</span>
                                  <span className="text-[12px] text-slate-400">{fmtDate(v.visit_date)}</span>
                                </div>
                                <p className="text-[12px] text-slate-500 mt-0.5">Outcome: {snake(v.outcome) || '—'}</p>
                                {v.notes && <p className="text-[11px] text-slate-400 mt-0.5">{v.notes}</p>}
                              </div>
                            ))}
                          </div>
                        )}
                      <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Log Visit</p>
                      <ErrBanner msg={visitErr} />
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Visit Date</label>
                          <input type="date" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={visitDate} onChange={e => setVisitDate(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Visit Type</label>
                          <select className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={visitType} onChange={e => setVisitType(e.target.value)}>
                            {VISIT_TYPES.map(t => <option key={t} value={t}>{snake(t)}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Outcome</label>
                          <input type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={visitOutcome} onChange={e => setVisitOutcome(e.target.value)} />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-400 mb-1">Notes</label>
                          <input type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                            value={visitNotes} onChange={e => setVisitNotes(e.target.value)} />
                        </div>
                      </div>
                      <button
                        className="mt-3 px-4 py-2 rounded-lg text-[12px] font-semibold text-white disabled:opacity-60"
                        style={{ background: AMBER }}
                        disabled={visitBusy || !visitDate}
                        onClick={submitVisit}>
                        {visitBusy ? 'Saving…' : 'Log Visit'}
                      </button>
                    </div>
                  )}

                  {/* Write-off section */}
                  <div className="mt-5 pt-5 border-t border-slate-200">
                    <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-3">Write-off</p>
                    {detail.write_off ? (
                      <div className="bg-white rounded-xl border border-slate-200 p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[13px] font-semibold text-slate-800">
                            {fmt(detail.write_off.amount_kobo / 100)} — {detail.write_off.reason}
                          </span>
                          <StatusBadge status={detail.write_off.status ?? 'pending'} />
                        </div>
                        {detail.write_off.status === 'pending' && (
                          <>
                            <ErrBanner msg={woActErr} />
                            <div className="flex items-center gap-2 mt-2">
                              <input type="text" className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-[12px] focus:outline-none"
                                placeholder="Approval notes (optional)"
                                value={woApproveNotes} onChange={e => setWoApproveNotes(e.target.value)} />
                              <button
                                disabled={woActBusy}
                                onClick={() => actWriteOff(detail.write_off.id, 'approve')}
                                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-60"
                                style={{ background: GREEN }}>
                                {woActBusy ? '…' : 'Approve'}
                              </button>
                              <button
                                disabled={woActBusy}
                                onClick={() => actWriteOff(detail.write_off.id, 'reject')}
                                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-60"
                                style={{ background: RED }}>
                                {woActBusy ? '…' : 'Reject'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        <ErrBanner msg={woErr} />
                        <div className="flex items-end gap-3">
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-400 mb-1">Amount (₦)</label>
                            <input type="number" min="0" step="0.01" className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none w-40"
                              value={woAmt} onChange={e => setWoAmt(e.target.value)} />
                          </div>
                          <div className="flex-1">
                            <label className="block text-[11px] font-semibold text-slate-400 mb-1">Reason</label>
                            <input type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                              value={woReason} onChange={e => setWoReason(e.target.value)} />
                          </div>
                          <button
                            disabled={woBusy || !woAmt || !woReason}
                            onClick={submitWriteOff}
                            className="px-4 py-2 rounded-lg text-[12px] font-semibold text-white disabled:opacity-60"
                            style={{ background: RED }}>
                            {woBusy ? 'Requesting…' : 'Request Write-off'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-between items-center px-5 py-3 border-t border-slate-100">
          <span className="text-[12px] text-slate-400">Page {page + 1}</span>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] disabled:opacity-40">Prev</button>
            <button disabled={cases.length < limit} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] disabled:opacity-40">Next</button>
          </div>
        </div>
      </SectionCard>
    </Page>
  )
}
