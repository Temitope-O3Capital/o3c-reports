import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, KpiCard, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, DateFilter, NameCell, ActionRow, Modal } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPut, apiExport } from '../../lib/api'
import { fmtKobo, fmtDate, fmtPct, fmtNum, today, monthStart } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, GREEN, AMBER, RED, INTER, NUM } from '../../lib/design'

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
}

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
  const [saving,  setSaving]  = useState(false)

  useEffect(() => { if (open) setNotes('') }, [open])

  const nextStage = app?.stage ? NEXT_STAGE[app.stage] : undefined

  async function handleSubmit() {
    if (!app) return
    setSaving(true)
    try {
      // to_stage is required by the API. This used to send only { notes }, so every
      // click returned 422 and the button had never worked.
      await apiPut(`/api/los/${app.id}/advance`, {
        notes,
        ...(nextStage ? { to_stage: nextStage } : {}),
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
    <Modal open={open} onClose={onClose} title={`Advance — ${app?.reference ?? ''}`} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0 }}>
          Move <strong>{app?.applicant_name}</strong> from{' '}
          <strong>{prettyStage(app?.stage)}</strong> to{' '}
          <strong>{prettyStage(nextStage)}</strong>. Add optional review notes below.
        </p>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={4}
          placeholder="Optional notes…"
          style={{ width: '100%', padding: SP[3], borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, resize: 'vertical', fontFamily: INTER, boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving} style={{ padding: '7px 16px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Advancing…' : 'Advance Stage'}
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
    <Modal open={open} onClose={onClose} title={`Decline — ${app?.reference ?? ''}`} width={480}>
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
  const [selected,  setSelected]  = useState<Set<string | number>>(new Set())
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
    if (dateFrom)       p.set('date_from', dateFrom)
    if (dateTo)         p.set('date_to', dateTo)
    return p.toString()
  }, [view, fStages, fProducts, fBands, search, dateFrom, dateTo])

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
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.monthly_income_kobo)}</span>,
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
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_requested_kobo)}</span>,
    },
    { key: 'product_type', label: 'Product', render: r => <ProductPill product={r.product_type} /> },
    {
      key: 'submitted_at', label: 'Submitted', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.submitted_at)}</span>,
    },
    {
      key: '_actions', label: '',
      render: r => (
        <ActionRow actions={[
          {
            icon: 'check_circle',
            label: 'Advance Stage',
            onClick: () => setAdvanceApp(r),
          },
          {
            icon: 'cancel',
            label: 'Decline',
            onClick: () => setDeclineApp(r),
            danger: true,
          },
          {
            icon: 'visibility',
            label: 'View Application',
            onClick: () => navigate(`/operations/risk/applications/${r.id}`),
          },
        ]} />
      ),
    },
  ]

  const bulkBar = selected.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{selected.size} selected</span>
      <button
        onClick={() => apiExport(`/api/risk/applications/export?${buildQS(0)}`, 'risk-applications.csv')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV
      </button>
    </div>
  ) : null

  return (
    <Page
      title="App Review"
      subtitle="Risk review queue — applications pending credit decision"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => apiExport(`/api/risk/applications/export?${buildQS(0)}`, 'risk-applications.csv')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>Export CSV
          </button>
        </div>
      }
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
                { value: 'risk_review',       label: 'Risk Review',       color: AMBER },
                { value: 'risk_head_review',  label: 'Risk Head Review',  color: '#2563EB' },
                { value: 'pending_committee', label: 'Pending Committee', color: NAVY },
              ],
              selected: fStages,
              onChange: setFStages,
            } as FilterGroupDef] : []),
            {
              key: 'product',
              label: 'Product',
              options: [
                { value: 'Payday Loan' },
                { value: 'Salary Advance' },
                { value: 'Business Loan' },
                { value: 'Education Loan' },
                { value: 'Auto Loan' },
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
          selectable
          selectedIds={selected}
          onSelect={setSelected}
          bulkBar={bulkBar}
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
              >← Prev</button>
              <button
                onClick={() => load(offset + PAGE_SIZE)}
                disabled={currentPage >= pages}
                style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: currentPage >= pages ? 'not-allowed' : 'pointer', opacity: currentPage >= pages ? 0.5 : 1, fontSize: TEXT.sm }}
              >Next →</button>
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
