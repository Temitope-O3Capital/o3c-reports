import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, Spinner, Modal } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtDate, fmtNum } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, NUM } from '../../lib/design'
import { bandColor, bandLabel, bandShort, scoreColor, fmtScore, RISK_BANDS, BAND_COLOR, BAND_LABEL, dpdColor, dpdLabel, DPD_BUCKETS } from '../../lib/riskScale'
import { subsForLine } from '../../lib/products'
import { TierBadge, PctBar, tierFromPct } from '../../components/TierBadge'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoanSummary {
  total_loans:            number
  total_outstanding_kobo: number
  current_count:          number
  dpd_1_30:               number
  dpd_31_60:              number
  dpd_61_90:              number
  dpd_90plus:             number
  npl_outstanding_kobo:   number
}

interface LoanRow {
  id: string
  reference: string
  applicant_name: string
  applicant_cif: string
  sector: string
  product_type: string
  amount_kobo: number
  outstanding_kobo: number
  principal_paid_kobo: number
  min_repayment_kobo: number | null
  dpd: number
  arrears_kobo: number
  risk_band: string | null
  eye_score: number | null
  status: string
  booked_at: string | null
  maturity_date: string | null
}

/** Mirrors what GET /api/risk/credit-file/{cif} actually returns.
 *  The previous shape here (eye_rating, bureau_summary, monthly_income_kobo,
 *  employer, tenor_months, interest_rate_bps…) was never sent by the API, so the
 *  drawer rendered em-dashes for almost every field even when it loaded. */
interface CreditFileLoan {
  id: string; ref: string; product: string
  principal_kobo: number; outstanding_kobo: number; arrears_kobo: number
  dpd: number; risk_band: string | null; eye_score: number | null
  status: string; disbursed_at: string; source: string
}
interface CreditFileData {
  cif: string; customer_name: string; phone: string
  eye_score: number | null; eye_band: string | null; score_basis: string
  total_loan_count: number; active_loan_count: number
  total_outstanding_kobo: number; total_arrears_kobo: number
  worst_dpd: number; dti_pct: number | null; kyc_status: string; bvn: string
  loans: CreditFileLoan[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// dpdColor / dpdLabel now come from lib/riskScale (shared with the Overview, the
// dashboards and Vintage). They used to be declared here with current = DPD < 30 and
// NPL = DPD < 180, which disagreed with the KPI cards and the filter chips.

// Bands come from lib/riskScale. This page used to declare a Prime/Near-Prime map
// against an API that emits A-E, so every pill fell through to the grey default.
function BandPill({ band }: { band: string | null }) {
  if (!band) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>—</span>
  const c = bandColor(band)
  return (
    <span
      title={bandLabel(band)}
      style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: `${c}1F`, color: c, whiteSpace: 'nowrap' }}
    >
      {bandShort(band)}
    </span>
  )
}

// ── Credit File Drawer ────────────────────────────────────────────────────────

function CreditFileDrawer({ cif, open, onClose }: { cif: string; open: boolean; onClose: () => void }) {
  const [data,    setData]    = useState<CreditFileData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!open || !cif) return
    setLoading(true); setError(null)
    apiFetch<{ data: CreditFileData }>(`/api/risk/credit-file/${cif}`)
      .then(r => setData((r as any).data ?? r ?? null))
      .catch(e => setError(e.message ?? 'Failed'))
      .finally(() => setLoading(false))
  }, [cif, open])

  return (
    <Modal open={open} onClose={onClose} title={`Credit File: ${data?.customer_name || cif}`} width={620}>
      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
      {error && <div style={{ color: RED, fontSize: TEXT.sm, padding: SP[3] }}>{error}</div>}
      {data && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {/* Score */}
          <div style={{ display: 'flex', gap: SP[4], alignItems: 'center', padding: SP[3], borderRadius: RADIUS.md, background: 'var(--th-bg)', border: '1px solid var(--bdr)' }}>
            <div style={{ textAlign: 'center', minWidth: 96 }}>
              <div style={{ ...NUM, fontSize: 44, fontWeight: FW.extrabold, color: scoreColor(data.eye_score), lineHeight: 1 }}>
                {data.eye_score ?? '—'}
              </div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
                {data.score_basis === 'eye_score' ? 'Eye Score' : 'Risk Score · 0-100'}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              {data.eye_band && (
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: bandColor(data.eye_band), marginBottom: 6 }}>
                  {bandLabel(data.eye_band)}
                </div>
              )}
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
                {data.score_basis === 'eye_score'
                  ? 'Scored at origination.'
                  : data.score_basis === 'cbs_derived'
                    ? 'Derived from repayment behaviour on the live book. No origination score on file.'
                    : 'No score on file.'}
              </div>
              {data.phone && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>{data.phone}</div>}
            </div>
          </div>

          {/* Exposure summary — every field below is one the API actually returns */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SP[3] }}>
            {[
              { label: 'Total Outstanding', value: fmtKoboExact(data.total_outstanding_kobo) },
              { label: 'Arrears',           value: fmtKoboExact(data.total_arrears_kobo), warn: data.total_arrears_kobo > 0 },
              { label: 'Worst DPD',         value: `${data.worst_dpd ?? 0} days`, warn: (data.worst_dpd ?? 0) > 30 },
              { label: 'Loans',             value: `${data.active_loan_count} open / ${data.total_loan_count} total` },
              { label: 'DTI Ratio',         value: data.dti_pct !== null && data.dti_pct !== undefined ? `${Number(data.dti_pct).toFixed(1)}%` : '—' },
              { label: 'BVN',               value: data.bvn || '—' },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{row.label}</span>
                <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: row.warn ? AMBER : 'var(--txt)' }}>{row.value}</span>
              </div>
            ))}
          </div>

          {/* Facilities */}
          {data.loans?.length > 0 && (
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: SP[2] }}>
                Facilities ({data.loans.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.loans.map(l => (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: SP[3], padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.sm, border: '1px solid var(--bdr)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.product}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{l.ref} · {fmtDate(l.disbursed_at)}</div>
                    </div>
                    <BandPill band={l.risk_band} />
                    <div style={{ textAlign: 'right', minWidth: 96 }}>
                      <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKoboExact(l.outstanding_kobo)}</div>
                      <div style={{ ...NUM, fontSize: TEXT.xs, color: dpdColor(l.dpd) }}>{l.dpd} dpd</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

export default function RiskPortfolio() {
  const navigate = useNavigate()
  // Deep-linkable filters: My Dashboard / Overview link in with ?dpd=npl etc, so the
  // page opens already filtered to the bucket the user clicked.
  const [searchParams] = useSearchParams()
  const [rows,    setRows]    = useState<LoanRow[]>([])
  const [total,   setTotal]   = useState(0)
  const [offset,  setOffset]  = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')
  const [fDpd,    setFDpd]    = useState<Set<string>>(() => { const v = searchParams.get('dpd'); return new Set(v ? v.split(',') : []) })
  const [fBand,   setFBand]   = useState<Set<string>>(() => { const v = searchParams.get('band'); return new Set(v ? v.split(',') : []) })
  const [fProduct, setFProduct] = useState<Set<string>>(() => { const v = searchParams.get('product'); return new Set(v ? v.split(',') : []) })
  const [cifFile, setCifFile] = useState<string | null>(null)
  const [summary, setSummary] = useState<LoanSummary | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    apiFetch<{ summary: LoanSummary }>('/api/active-loans/stats')
      .then(r => setSummary(r?.summary ?? null))
      .catch(() => {})
  }, [])

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) })
    // Send every ticked bucket/band, comma-separated — the backend ORs them. This
    // used to fire only when exactly one chip was selected, so ticking two silently
    // returned the whole book.
    if (fDpd.size) p.set('dpd', [...fDpd].join(','))
    if (fBand.size) p.set('band', [...fBand].join(','))
    if (fProduct.size) p.set('product', [...fProduct].join(','))
    if (search) p.set('q', search)
    return p.toString()
  }, [fDpd, fBand, fProduct, search])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort(); abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      // The endpoint now uses respondPaginated, so the envelope is a flat
      // { data, total } instead of the double-wrapped { data: { data, total } }
      // this had to unpick.
      const res = await apiFetch<{ data: LoanRow[]; total: number }>(
        `/api/risk/loan-book?${buildQS(off)}`,
        { signal: abortRef.current.signal },
      )
      setRows(Array.isArray(res?.data) ? res.data : [])
      setTotal(res?.total ?? 0)
      setOffset(off)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message ?? 'Failed')
    } finally { setLoading(false) }
  }, [buildQS])

  useEffect(() => { load(0) }, [load])

  const pages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  const groups: FilterGroupDef[] = [
    {
      key: 'dpd', label: 'DPD BUCKET',
      // Buckets + colours from the shared scale, so the chips match the KPI cards,
      // the DPD column and the Overview distribution bar exactly.
      options: DPD_BUCKETS.map(b => ({ value: b.key, label: b.short, color: b.color })),
      selected: fDpd,
      onChange: setFDpd,
    },
    {
      // Values must be the letters the API emits — the old Prime/Near-Prime chips
      // could never match a row, and the backend discarded the filter anyway.
      key: 'band', label: 'RISK BAND',
      options: RISK_BANDS.map(b => ({ value: b, label: `${b} — ${BAND_LABEL[b]}`, color: BAND_COLOR[b] })),
      selected: fBand,
      onChange: setFBand,
    },
    {
      // The loan book is loans-only, so the product cut is over the loan sub-products
      // (Salary / Business). Values are the canonical sub-codes; the backend maps them
      // to ILIKE patterns against the CBS free-text product name.
      key: 'product', label: 'PRODUCT',
      options: subsForLine('loans').map(s => ({ value: s.code, label: s.label })),
      selected: fProduct,
      onChange: setFProduct,
    },
  ]

  const cols: TableCol<LoanRow>[] = [
    {
      key: 'applicant_name', label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.applicant_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.applicant_cif}</div>
        </div>
      ),
    },
    // CBS carries no employer; this column has always been economic sector, now
    // resolved to a name server-side instead of showing a raw CBN code.
    { key: 'sector', label: 'Sector', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.sector || '—'}</span> },
    { key: 'product_type', label: 'Product', render: r => <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>{r.product_type || '—'}</span> },
    {
      key: 'amount_kobo', label: 'Principal', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtKoboExact(r.amount_kobo)}</span>,
    },
    {
      // Next scheduled installment (principal+interest+fee of the earliest unpaid row),
      // derived server-side; the CBS book has no explicit minimum-repayment field.
      key: 'min_repayment_kobo', label: 'Min Repayment', align: 'right',
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.min_repayment_kobo != null ? fmtKoboExact(r.min_repayment_kobo) : '—'}</span>,
    },
    {
      key: 'principal_paid_kobo', label: 'Amount Paid', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: r.principal_paid_kobo > 0 ? GREEN : 'var(--txt3)' }}>{fmtKoboExact(r.principal_paid_kobo)}</span>,
    },
    {
      key: '_pct', label: '% Paid', align: 'right',
      render: r => {
        const pct = r.amount_kobo > 0 ? Math.round((r.principal_paid_kobo / r.amount_kobo) * 100) : 0
        return <PctBar pct={pct} tier={tierFromPct(pct)} />
      },
    },
    {
      key: '_tier', label: 'Tier',
      render: r => <TierBadge tier={tierFromPct(r.amount_kobo > 0 ? (r.principal_paid_kobo / r.amount_kobo) * 100 : 0)} />,
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right', sortable: true,
      render: r => (
        <div style={{ textAlign: 'right' }}>
          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKoboExact(r.outstanding_kobo)}</span>
          {r.arrears_kobo > 0 && (
            <div style={{ ...NUM, fontSize: TEXT.xs, color: AMBER }}>{fmtKoboExact(r.arrears_kobo)} behind</div>
          )}
        </div>
      ),
    },
    {
      key: 'dpd', label: 'DPD', align: 'right', sortable: true,
      render: r => (
        <div style={{ textAlign: 'right' }}>
          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: dpdColor(r.dpd) }}>{r.dpd}</span>
          <div style={{ fontSize: TEXT.xs, color: dpdColor(r.dpd), fontWeight: FW.semibold }}>{dpdLabel(r.dpd)}</div>
        </div>
      ),
    },
    { key: 'risk_band', label: 'Band', render: r => <BandPill band={r.risk_band} /> },
    {
      key: 'eye_score', label: 'Score', align: 'right', sortable: true,
      render: r => {
        return <span title={fmtScore(r.eye_score)} style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(r.eye_score) }}>{r.eye_score ?? '—'}</span>
      },
    },
    { key: 'maturity_date', label: 'Maturity', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{r.maturity_date ? fmtDate(r.maturity_date) : '—'}</span> },
    {
      key: '_file', label: '',
      render: r => (
        <button
          onClick={e => { e.stopPropagation(); setCifFile(r.applicant_cif) }}
          style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, cursor: 'pointer' }}
        >
          Credit File
        </button>
      ),
    },
  ]

  return (
    <Page title="Loan/Credit Card Portfolio" subtitle={`Active loan book: ${fmtNum(total)} accounts`} loading={loading && rows.length === 0} skeletonKpis={5}>
      <ErrBanner error={error} onRetry={() => load(0)} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Total Loans"       value={fmtNum(summary?.total_loans ?? 0)}           loading={!summary} />
        <KpiCard label="Outstanding"       value={fmtKoboExact(summary?.total_outstanding_kobo ?? 0)} loading={!summary} />
        <KpiCard label="Current"           value={fmtNum(summary?.current_count ?? 0)}          loading={!summary} sub="no overdue" />
        <KpiCard label="PAR 1–90"          value={fmtNum((summary?.dpd_1_30 ?? 0) + (summary?.dpd_31_60 ?? 0) + (summary?.dpd_61_90 ?? 0))} loading={!summary} sub="DPD 1–90 accounts" />
        <KpiCard label="NPL (90+)"         value={fmtNum(summary?.dpd_90plus ?? 0)}             loading={!summary} sub={summary ? fmtKoboExact(summary.npl_outstanding_kobo) : undefined} accent={RED} />
      </div>

      <SectionCard title="Active Loan Book" badge={total} padding={false}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={groups}
          onReset={() => { setFDpd(new Set()); setFBand(new Set()); setFProduct(new Set()); setSearch('') }}
          onApply={() => load(0)}
          resultCount={rows.length} totalCount={total}
          placeholder="Search name or CIF…"
        />
        <DataTable
          cols={cols} rows={rows}
          keyFn={r => r.id}
          loading={loading} skeletonRows={12}
          onRowClick={r => navigate(`/operations/risk/applications/cif/${encodeURIComponent(r.applicant_cif)}`)}
          emptyText="No active loans found"
          pageSize={PAGE_SIZE}
        />
        {pages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Page {currentPage} of {pages} · {fmtNum(total)} loans</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => load(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.5 : 1, fontSize: TEXT.sm }}>Prev</button>
              <button onClick={() => load(offset + PAGE_SIZE)} disabled={currentPage >= pages} style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: currentPage >= pages ? 'not-allowed' : 'pointer', opacity: currentPage >= pages ? 0.5 : 1, fontSize: TEXT.sm }}>Next</button>
            </div>
          </div>
        )}
      </SectionCard>

      <CreditFileDrawer cif={cifFile ?? ''} open={!!cifFile} onClose={() => setCifFile(null)} />
    </Page>
  )
}
