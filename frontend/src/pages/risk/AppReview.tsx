import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, KpiCard, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, DateFilter, NameCell, ActionRow, Modal } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtDate, fmtPct, fmtNum, today, monthStart } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, GREEN, AMBER, RED, INTER, NUM } from '../../lib/design'
import { canAdvance, canDecline, stageMeta, decisionMeta, syncStateMeta } from '../../lib/losFlow'
import { downloadCsv, stamp } from '../../lib/csv'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReviewKPIs {
  reviewed: number
  approved: number
  declined: number
  pending: number
  origination_live?: boolean
}

interface RiskApp {
  id: number
  reference: string
  applicant_name: string
  employer_name: string | null
  eye_score: number | null
  risk_band: string | null
  monthly_income_kobo: number
  dti_pct: number | null
  amount_requested_kobo: number
  product_type: string
  submitted_at: string | null
  stage?: string | null
  days_in_stage?: number | null
  decision?: string | null
  phoenix_sync_state?: string | null
  // True when the viewer is the person who moved this file into its current stage —
  // deciding it on is then a single-reviewer decision, and is recorded as one.
  entered_stage_by_me?: boolean
}

// The stages where advancing a file IS a credit decision, and so where one pair of eyes
// is worth saying out loud. Mirrors decisionTransitions in handlers/los.go.
const DECISION_STAGES = ['risk_review', 'risk_head_review', 'pending_committee', 'pending_conditions', 'finance_approval']

// ── Risk band pill ────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, { bg: string; txt: string }> = {
  Prime:        { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  'Near-Prime': { bg: 'rgba(37,99,235,.12)', txt: '#2563EB' },
  'Sub-Prime':  { bg: 'rgba(217,119,6,.12)', txt: '#D97706' },
  'High-Risk':  { bg: 'rgba(192,0,0,.1)',    txt: '#C00000' },
}

function BandPill({ band }: { band: string | null }) {
  if (!band) return <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>—</span>
  const s = BAND_COLORS[band] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: s.bg, color: s.txt, whiteSpace: 'nowrap' }}>
      {band}
    </span>
  )
}

function ProductPill({ product }: { product: string }) {
  const label = product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function eyeScoreColor(score: number | null): string {
  if (score === null) return 'var(--txt2)'
  if (score >= 700) return GREEN
  if (score >= 500) return AMBER
  return RED
}

// ── AdvanceModal ──────────────────────────────────────────────────────────────

// The LOS pipeline is linear; this mirrors allowedTransitions in handlers/los.go so
// the modal can name the destination. The server still resolves the destination
// itself when to_stage is omitted, so this map being stale can only affect the label,
// never the outcome.
const NEXT_STAGE: Record<string, string> = {
  draft:               'submitted',
  submitted:           'document_collection',
  document_collection: 'risk_review',
  risk_review:         'risk_head_review',
  risk_head_review:    'pending_conditions',
  pending_conditions:  'finance_approval',
  finance_approval:    'booking',
  booking:             'active',
}

const prettyStage = (s?: string | null) =>
  s ? s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—'

function AdvanceModal({ app, open, onClose, onDone }: { app: RiskApp | null; open: boolean; onClose: () => void; onDone: () => void }) {
  const [notes,   setNotes]   = useState('')
  const [amount,  setAmount]  = useState('')
  const [saving,  setSaving]  = useState(false)

  const nextStage = app?.stage ? NEXT_STAGE[app.stage] : undefined
  // The risk head's sign-off is the moment the credit is granted and its amount fixed.
  // Nothing used to ask for a figure, so amount_approved_kobo was never written and the
  // disbursement journal fell back to what the customer requested — a number no approver
  // had confirmed. The server now requires it on this transition.
  const isApproval    = app?.stage === 'risk_head_review'
  const requestedKobo = app?.amount_requested_kobo ?? 0

  useEffect(() => {
    if (!open) return
    setNotes('')
    // Pre-filled with the requested figure — approving in full is the common case — but
    // it is still confirmed by a person rather than assumed by the code.
    setAmount(requestedKobo > 0 ? String(requestedKobo / 100) : '')
  }, [open, requestedKobo])

  const approvedKobo = Math.round(parseFloat(amount.replace(/,/g, '')) * 100)
  const amountError  = !isApproval ? null
    : !isFinite(approvedKobo) || approvedKobo <= 0 ? 'Enter the amount you are approving.'
    : requestedKobo > 0 && approvedKobo > requestedKobo ? `That is more than the ${fmtKoboExact(requestedKobo)} requested.`
    : null

  async function handleSubmit() {
    if (!app || amountError) return
    setSaving(true)
    try {
      // to_stage is required by the API. This used to send only { notes }, so every
      // click returned 422 and the button had never worked.
      await apiPut(`/api/los/${app.id}/advance`, {
        notes,
        ...(nextStage ? { to_stage: nextStage } : {}),
        ...(isApproval ? { amount_approved_kobo: approvedKobo } : {}),
      })
      toast.success(`Application ${app.reference} advanced`)
      onClose(); onDone()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to advance')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Advance: ${app?.reference ?? ''}`} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0 }}>
          Move <strong>{app?.applicant_name}</strong> from{' '}
          <strong>{prettyStage(app?.stage)}</strong> to{' '}
          <strong>{prettyStage(nextStage)}</strong>. Add optional review notes below.
        </p>

        {/* Said before the click, not discovered afterwards. With one risk officer and
            one risk head, covering for each other is normal and is not blocked — but the
            approval is recorded as a single-reviewer decision so it can be found later. */}
        {app?.entered_stage_by_me && DECISION_STAGES.includes(app?.stage ?? '') && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 11px', borderRadius: RADIUS.md, background: `${AMBER}12`, border: `1px solid ${AMBER}40` }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17, color: AMBER, marginTop: 1 }}>visibility</span>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.45 }}>
              You also performed the previous step on this application. Continuing will be
              recorded as a <strong style={{ color: 'var(--txt)' }}>single-reviewer decision</strong>.
            </span>
          </div>
        )}

        {isApproval && (
          <div>
            <label htmlFor="approve-amt" style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              Amount To Approve
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: TEXT.md, color: 'var(--txt2)', fontWeight: FW.semibold }}>₦</span>
              <input
                id="approve-amt" inputMode="decimal" value={amount}
                onChange={e => setAmount(e.target.value)}
                style={{
                  ...NUM, flex: 1, padding: '9px 11px', borderRadius: RADIUS.md,
                  border: `1px solid ${amountError ? `${RED}66` : 'var(--input-bdr)'}`,
                  background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.base,
                  fontFamily: INTER, outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
              <span style={{ fontSize: TEXT.xs, color: amountError ? RED : 'var(--txt3)' }}>
                {amountError ?? `Requested: ${fmtKoboExact(requestedKobo)}`}
              </span>
              {!amountError && requestedKobo > 0 && approvedKobo !== requestedKobo && (
                <button onClick={() => setAmount(String(requestedKobo / 100))}
                  style={{ border: 'none', background: 'none', padding: 0, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>
                  Approve in full
                </button>
              )}
            </div>
          </div>
        )}

        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={4}
          placeholder="Optional notes…"
          style={{ width: '100%', padding: SP[3], borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, resize: 'vertical', fontFamily: INTER, boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !!amountError}
            style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving || amountError ? 'not-allowed' : 'pointer', opacity: saving || amountError ? 0.55 : 1 }}>
            {saving ? 'Advancing…' : isApproval ? 'Approve' : 'Advance Stage'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── DeclineModal ──────────────────────────────────────────────────────────────

function DeclineModal({ app, open, onClose, onDone }: { app: RiskApp | null; open: boolean; onClose: () => void; onDone: () => void }) {
  const [reason,  setReason]  = useState('')
  const [saving,  setSaving]  = useState(false)

  useEffect(() => { if (open) setReason('') }, [open])

  async function handleSubmit() {
    if (!app || !reason.trim()) return
    setSaving(true)
    try {
      await apiPut(`/api/los/${app.id}/decline`, { reason })
      toast.success(`Application ${app.reference} declined`)
      onClose(); onDone()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to decline')
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = reason.trim().length > 0

  return (
    <Modal open={open} onClose={onClose} title={`Decline: ${app?.reference ?? ''}`} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0 }}>
          Decline <strong>{app?.applicant_name}</strong>. A decline reason is required.
        </p>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          rows={4}
          placeholder="Decline reason (required)…"
          style={{ width: '100%', padding: SP[3], borderRadius: RADIUS.md, border: `1px solid ${!canSubmit && reason !== '' ? RED : 'var(--bdr)'}`, background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, resize: 'vertical', fontFamily: INTER, boxSizing: 'border-box' }}
        />
        {!canSubmit && reason !== '' && (
          <span style={{ fontSize: TEXT.xs, color: RED }}>Reason is required</span>
        )}
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !canSubmit} style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: (saving || !canSubmit) ? 'not-allowed' : 'pointer', opacity: (saving || !canSubmit) ? 0.65 : 1 }}>
            {saving ? 'Declining…' : 'Decline'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

export default function RiskAppReview() {
  const navigate = useNavigate()

  const [rows,      setRows]      = useState<RiskApp[]>([])
  const [kpis,      setKpis]      = useState<ReviewKPIs | null>(null)
  const [total,     setTotal]     = useState(0)
  const [offset,    setOffset]    = useState(0)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [view,      setView]      = useState<'pending' | 'all'>('pending')
  const [fStages,   setFStages]   = useState(new Set<string>())
  const [fProducts, setFProducts] = useState(new Set<string>())
  const [fBands,    setFBands]    = useState(new Set<string>())
  const [search,    setSearch]    = useState('')
  const [dateFrom,  setDateFrom]  = useState(monthStart())
  const [dateTo,    setDateTo]    = useState(today())
  // The row checkboxes are gone: the selection they filled was never read by anything —
  // there is no bulk assign, approve or export on this page — so ticking twenty
  // applications did exactly nothing and implied an action that does not exist.
  const [sortKey,   setSortKey]   = useState('submitted_at')
  const [sortDir,   setSortDir]   = useState<'asc' | 'desc'>('desc')
  const [advanceApp, setAdvanceApp] = useState<RiskApp | null>(null)
  const [declineApp, setDeclineApp] = useState<RiskApp | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(off))
    // Pending view auto-filters to risk stage
    if (view === 'pending') {
      p.set('stage', 'risk_review,risk_head_review')
    } else {
      if (fStages.size) p.set('stage', [...fStages].join(','))
    }
    if (fProducts.size) p.set('product', [...fProducts].join(','))
    if (fBands.size)    p.set('band',    [...fBands].join(','))
    if (search)         p.set('search', search)
    // The date window deliberately does NOT apply to the pending queue. It defaults to
    // the start of this month, and an application submitted in August is still waiting
    // in September — filtering it out hid exactly the ageing files this page exists to
    // surface, while the KPI card above (which had no date filter) kept counting them.
    if (view !== 'pending') {
      if (dateFrom) p.set('date_from', dateFrom)
      if (dateTo)   p.set('date_to', dateTo)
    }
    p.set('sort', sortKey)
    p.set('dir', sortDir)
    return p.toString()
  }, [view, fStages, fProducts, fBands, search, dateFrom, dateTo, sortKey, sortDir])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: RiskApp[]; total: number }>(
          `/api/risk/applications?${buildQS(off)}`,
          { signal: abortRef.current.signal },
        ),
        apiFetch<{ data: ReviewKPIs }>('/api/risk/review-kpis'),
      ])
      setRows(res.data ?? [])
      setTotal(res.total ?? 0)
      setOffset(off)
      setKpis(kpiRes.data)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [buildQS])

  useEffect(() => { load(0) }, [load])

  // Exports exactly what is on screen — same view, filters and ordering. Kobo columns
  // go out as naira numerals rather than formatted text so the file is arithmetic-ready
  // in Excel; the score and DTI stay raw for the same reason.
  const exportCsv = useCallback(() => {
    downloadCsv(`risk-applications-${view}-${stamp()}.csv`, [
      { header: 'Reference',        value: r => r.reference },
      { header: 'Application',      value: r => `APP-${r.id}` },
      { header: 'Applicant',        value: r => r.applicant_name },
      { header: 'Employer',         value: r => r.employer_name ?? '' },
      { header: 'Product',          value: r => r.product_type },
      { header: 'Amount Requested', value: r => r.amount_requested_kobo / 100 },
      { header: 'Monthly Income',   value: r => r.monthly_income_kobo / 100 },
      { header: 'DTI %',            value: r => r.dti_pct ?? '' },
      { header: 'Eye Score',        value: r => r.eye_score ?? '' },
      { header: 'Risk Band',        value: r => r.risk_band ?? '' },
      { header: 'Stage',            value: r => r.stage ?? '' },
      { header: 'Days In Stage',    value: r => r.days_in_stage ?? '' },
      { header: 'Phoenix Decision', value: r => r.decision ?? '' },
      { header: 'Phoenix Sync',     value: r => r.phoenix_sync_state ?? '' },
      { header: 'Submitted At',     value: r => r.submitted_at ?? '' },
    ], rows)
  }, [rows, view])

  function resetFilters() {
    setFStages(new Set()); setFProducts(new Set()); setFBands(new Set()); setSearch('')
    setDateFrom(monthStart()); setDateTo(today())
  }

  const pages       = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const kpiLoading  = loading && !kpis

  const cols: TableCol<RiskApp>[] = [
    {
      key: 'applicant_name', label: 'Applicant',
      render: r => <NameCell name={r.applicant_name} sub={r.reference} />,
    },
    {
      key: 'eye_score', label: 'Eye Score', align: 'right', sortable: true,
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: eyeScoreColor(r.eye_score) }}>
          {r.eye_score ?? '—'}
        </span>
      ),
    },
    { key: 'risk_band', label: 'Risk Band', render: r => <BandPill band={r.risk_band} /> },
    {
      key: 'monthly_income_kobo', label: 'Monthly Income', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKoboExact(r.monthly_income_kobo)}</span>,
    },
    {
      key: 'dti_pct', label: 'DTI %', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontWeight: 600, color: r.dti_pct !== null && r.dti_pct > 40 ? RED : 'var(--txt)' }}>
          {r.dti_pct !== null ? fmtPct(r.dti_pct) : '—'}
        </span>
      ),
    },
    {
      key: 'amount_requested_kobo', label: 'Amount', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKoboExact(r.amount_requested_kobo)}</span>,
    },
    { key: 'product_type', label: 'Product', render: r => <ProductPill product={r.product_type} /> },
    {
      key: 'decision', label: 'Phoenix',
      render: r => {
        const d = (r.decision ?? '').toLowerCase()
        if (d && d !== 'pending') {
          const m = decisionMeta(d)
          return (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: m.bg, color: m.txt, whiteSpace: 'nowrap' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{m.icon}</span>{m.label}
            </span>
          )
        }
        const s = syncStateMeta(r.phoenix_sync_state, r.decision)
        return s ? <span style={{ fontSize: TEXT.xs, fontWeight: FW.medium, color: s.txt }}>{s.label}</span> : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
    {
      key: 'submitted_at', label: 'Submitted', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.submitted_at)}</span>,
    },
    {
      // Actions are gated to what THIS user may actually do at the row's stage — a risk
      // officer sees Advance on risk_review, the risk head on risk_head_review; neither
      // sees an Advance the server would 403.
      key: '_actions', label: '',
      render: r => {
        const actions: { icon: string; label: string; onClick: () => void; danger?: boolean }[] = []
        if (canAdvance(r.stage)) actions.push({ icon: 'check_circle', label: stageMeta(r.stage).action ?? 'Advance', onClick: () => setAdvanceApp(r) })
        if (canDecline(r.stage)) actions.push({ icon: 'cancel', label: 'Decline', onClick: () => setDeclineApp(r), danger: true })
        actions.push({ icon: 'visibility', label: 'View Application', onClick: () => navigate(`/operations/risk/applications/${r.id}`) })
        return <ActionRow actions={actions} />
      },
    },
  ]

  return (
    <Page
      title="Loan/Credit Card Review"
      subtitle="Risk review queue: applications pending credit decision"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            title={rows.length === 0 ? 'Nothing to export' : `Export ${rows.length} applications`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '7px 15px', background: 'var(--card)', color: 'var(--txt2)',
              border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
              fontSize: TEXT.base, fontWeight: FW.semibold, fontFamily: INTER,
              cursor: rows.length === 0 ? 'default' : 'pointer', opacity: rows.length === 0 ? .5 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>download</span>
            Export
          </button>
        </div>
      }
      loading={loading && rows.length === 0}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={() => load(0)} />

      {/* KPI strip — Pending first */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Pending" value={kpis ? fmtNum(kpis.pending)   : '—'} icon="pending"     accent={AMBER} loading={kpiLoading} />
        <KpiCard label="Reviewed" value={kpis ? fmtNum(kpis.reviewed) : '—'} icon="fact_check"  accent={NAVY}  loading={kpiLoading} />
        <KpiCard label="Approved" value={kpis ? fmtNum(kpis.approved) : '—'} icon="check_circle" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Declined" value={kpis ? fmtNum(kpis.declined) : '—'} icon="cancel"      accent={RED}   loading={kpiLoading} />
      </div>

      <SectionCard
        title="Applications"
        badge={total}
        padding={false}
        actions={
          <div style={{ display: 'flex', borderRadius: RADIUS.md, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
            {(['pending', 'all'] as const).map(v => (
              <button
                key={v}
                onClick={() => { setView(v); setOffset(0) }}
                style={{
                  padding: '5px 14px', fontSize: TEXT.sm, fontWeight: view === v ? FW.semibold : FW.medium,
                  background: view === v ? NAVY : 'var(--card)', color: view === v ? '#fff' : 'var(--txt)',
                  border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                }}
              >
                {v === 'pending' ? 'Pending' : 'All'}
              </button>
            ))}
          </div>
        }
      >
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            ...(view === 'all' ? [{
              key: 'stage',
              label: 'Stage',
              options: [
                { value: 'document_collection', label: 'Document Collection', color: '#2563EB' },
                { value: 'risk_review',          label: 'Risk Review',          color: AMBER },
                { value: 'risk_head_review',     label: 'Risk Head Review',     color: NAVY },
              ],
              selected: fStages,
              onChange: setFStages,
            } as FilterGroupDef] : []),
            {
              // Real product_type taxonomy (matches sales_applications + products.ts), so
              // the filter actually matches rows. The old list was invented product names.
              key: 'product',
              label: 'Product',
              options: [
                { value: 'salary_loan',          label: 'Salary Loan' },
                { value: 'business_loan',        label: 'Business Loan' },
                { value: 'individual_loan',      label: 'Individual Loan' },
                { value: 'credit_card',          label: 'Credit Card' },
                { value: 'card_limit_increase',  label: 'Card Limit Increase' },
              ],
              selected: fProducts,
              onChange: setFProducts,
            } as FilterGroupDef,
            {
              key: 'band',
              label: 'Band',
              options: [
                { value: 'Prime',       color: '#16A34A' },
                { value: 'Near-Prime',  color: '#2563EB' },
                { value: 'Sub-Prime',   color: '#D97706' },
                { value: 'High-Risk',   color: '#C00000' },
              ],
              selected: fBands,
              onChange: setFBands,
            } as FilterGroupDef,
          ]}
          onReset={resetFilters}
          onApply={() => load(0)}
          resultCount={total}
          totalCount={total}
        />

        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          onRowClick={r => navigate(`/operations/risk/applications/${r.id}`)}
          // Sorting is done by the server, across the whole filtered queue rather than
          // the page of it currently on screen.
          sortKey={sortKey}
          sortDir={sortDir}
          onSortChange={(k, d) => { setSortKey(k); setSortDir(d) }}
          emptyText={kpis?.origination_live === false ? 'No applications yet. Applications raised in the workspace or synced from Phoenix will appear here for review.' : view === 'pending' ? 'No pending applications' : 'No applications found'}
        />

        {pages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
              Page {currentPage} of {pages} · {total.toLocaleString()} records
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
                disabled={offset === 0}
                style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.5 : 1, fontSize: TEXT.sm }}
              >Prev</button>
              <button
                onClick={() => load(offset + PAGE_SIZE)}
                disabled={currentPage >= pages}
                style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: currentPage >= pages ? 'not-allowed' : 'pointer', opacity: currentPage >= pages ? 0.5 : 1, fontSize: TEXT.sm }}
              >Next</button>
            </div>
          </div>
        )}
      </SectionCard>

      <AdvanceModal
        app={advanceApp}
        open={!!advanceApp}
        onClose={() => setAdvanceApp(null)}
        onDone={() => load(0)}
      />
      <DeclineModal
        app={declineApp}
        open={!!declineApp}
        onClose={() => setDeclineApp(null)}
        onDone={() => load(0)}
      />
    </Page>
  )
}
