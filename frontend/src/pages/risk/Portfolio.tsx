import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, Spinner, Modal } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, BLUE, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoanRow {
  id: number
  reference: string
  applicant_name: string
  applicant_cif: string
  employer: string
  product_type: string
  amount_kobo: number
  outstanding_kobo: number
  dpd: number
  risk_band: string | null
  eye_score: number | null
  status: string
  booked_at: string | null
  maturity_date: string | null
}

interface CreditFileData {
  eye_score: number | null; eye_rating: string | null; bureau_summary: string | null
  dti_pct: number | null; monthly_income_kobo: number; monthly_obligation_kobo: number | null
  amount_requested_kobo: number; amount_approved_kobo: number; tenor_months: number
  interest_rate_bps: number; outstanding_kobo: number; dpd: number
  employer: string; applicant_name: string; applicant_cif: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dpdColor(dpd: number): string {
  if (dpd < 30)  return GREEN
  if (dpd < 60)  return AMBER
  if (dpd < 90)  return '#D97706'
  return RED
}

function dpdLabel(dpd: number): string {
  if (dpd < 30)  return 'Current'
  if (dpd < 60)  return 'PAR30'
  if (dpd < 90)  return 'PAR60'
  if (dpd < 180) return 'PAR90'
  return 'NPL'
}

const BAND_COLORS: Record<string, { bg: string; txt: string }> = {
  'Prime':      { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  'Near-Prime': { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  'Sub-Prime':  { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  'High-Risk':  { bg: 'rgba(192,0,0,.10)',    txt: '#C00000' },
}

function BandPill({ band }: { band: string | null }) {
  if (!band) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>—</span>
  const s = BAND_COLORS[band] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  return (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: s.bg, color: s.txt, whiteSpace: 'nowrap' }}>
      {band}
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

  const scoreColor = (s: number | null) => {
    if (!s) return 'var(--txt3)'; if (s >= 700) return GREEN; if (s >= 500) return AMBER; return RED
  }

  return (
    <Modal open={open} onClose={onClose} title={`Credit File — ${cif}`} width={540}>
      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
      {error && <div style={{ color: RED, fontSize: TEXT.sm, padding: SP[3] }}>{error}</div>}
      {data && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {/* Eye Score */}
          <div style={{ display: 'flex', gap: SP[4], alignItems: 'center', padding: SP[3], borderRadius: RADIUS.md, background: 'var(--th-bg)', border: '1px solid var(--bdr)' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ ...NUM, fontSize: 48, fontWeight: FW.extrabold, color: scoreColor(data.eye_score), lineHeight: 1 }}>
                {data.eye_score ?? '—'}
              </div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>Eye Score</div>
            </div>
            <div style={{ flex: 1 }}>
              {data.eye_rating && (
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 6 }}>
                  Rating: {data.eye_rating}
                </div>
              )}
              {data.bureau_summary && (
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>{data.bureau_summary}</div>
              )}
              {!data.eye_score && !data.bureau_summary && (
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No score on file</div>
              )}
            </div>
          </div>

          {/* Income & DTI */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            {[
              { label: 'Monthly Income',      value: fmtKobo(data.monthly_income_kobo) },
              { label: 'Monthly Obligations', value: data.monthly_obligation_kobo ? fmtKobo(data.monthly_obligation_kobo) : '—' },
              { label: 'DTI Ratio',           value: data.dti_pct !== null ? `${Number(data.dti_pct).toFixed(1)}%` : '—' },
              { label: 'Employer',            value: data.employer || '—' },
              { label: 'Amount Disbursed',    value: fmtKobo(data.amount_approved_kobo || data.amount_requested_kobo) },
              { label: 'Outstanding',         value: fmtKobo(data.outstanding_kobo) },
              { label: 'Tenor',               value: data.tenor_months ? `${data.tenor_months} months` : '—' },
              { label: 'DPD',                 value: String(data.dpd ?? 0) + ' days' },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{row.label}</span>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

export default function RiskPortfolio() {
  const navigate = useNavigate()
  const [rows,    setRows]    = useState<LoanRow[]>([])
  const [total,   setTotal]   = useState(0)
  const [offset,  setOffset]  = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')
  const [fDpd,    setFDpd]    = useState(new Set<string>())
  const [fBand,   setFBand]   = useState(new Set<string>())
  const [cifFile, setCifFile] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) })
    if (fDpd.size === 1) p.set('dpd', [...fDpd][0])
    if (fBand.size === 1) p.set('band', [...fBand][0])
    if (search) p.set('q', search)
    return p.toString()
  }, [fDpd, fBand, search])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort(); abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: LoanRow[]; total: number }>(
        `/api/risk/loan-book?${buildQS(off)}`,
        { signal: abortRef.current.signal },
      )
      setRows(res.data ?? []); setTotal(res.total ?? 0); setOffset(off)
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
      options: [
        { value: 'current', label: 'Current',  color: GREEN },
        { value: 'par30',   label: 'PAR30',    color: AMBER },
        { value: 'par60',   label: 'PAR60',    color: '#D97706' },
        { value: 'par90',   label: 'PAR90',    color: RED },
        { value: 'npl',     label: 'NPL',      color: '#9B1C1C' },
      ],
      selected: fDpd,
      onChange: setFDpd,
    },
    {
      key: 'band', label: 'RISK BAND',
      options: [
        { value: 'Prime',       color: '#16A34A' },
        { value: 'Near-Prime',  color: '#2563EB' },
        { value: 'Sub-Prime',   color: '#D97706' },
        { value: 'High-Risk',   color: RED },
      ],
      selected: fBand,
      onChange: setFBand,
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
    { key: 'employer', label: 'Employer', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.employer || '—'}</span> },
    { key: 'product_type', label: 'Product', render: r => <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>{r.product_type || '—'}</span> },
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKobo(r.outstanding_kobo)}</span> },
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
      key: 'eye_score', label: 'Eye', align: 'right', sortable: true,
      render: r => {
        const c = r.eye_score === null ? 'var(--txt3)' : r.eye_score >= 700 ? GREEN : r.eye_score >= 500 ? AMBER : RED
        return <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: c }}>{r.eye_score ?? '—'}</span>
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
    <Page title="Portfolio" subtitle={`Active loan book — ${fmtNum(total)} accounts`}>
      <ErrBanner error={error} onRetry={() => load(0)} />

      <SectionCard title="Active Loan Book" badge={total} padding={false}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={groups}
          onReset={() => { setFDpd(new Set()); setFBand(new Set()); setSearch('') }}
          onApply={() => load(0)}
          resultCount={rows.length} totalCount={total}
          placeholder="Search name, CIF, employer…"
        />
        <DataTable
          cols={cols} rows={rows}
          keyFn={r => r.id}
          loading={loading} skeletonRows={12}
          onRowClick={r => navigate(`/sales/applications/${r.id}`)}
          emptyText="No active loans found"
          pageSize={PAGE_SIZE}
        />
        {pages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Page {currentPage} of {pages} · {fmtNum(total)} loans</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => load(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.5 : 1, fontSize: TEXT.sm }}>← Prev</button>
              <button onClick={() => load(offset + PAGE_SIZE)} disabled={currentPage >= pages} style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: currentPage >= pages ? 'not-allowed' : 'pointer', opacity: currentPage >= pages ? 0.5 : 1, fontSize: TEXT.sm }}>Next →</button>
            </div>
          </div>
        )}
      </SectionCard>

      <CreditFileDrawer cif={cifFile ?? ''} open={!!cifFile} onClose={() => setCifFile(null)} />
    </Page>
  )
}
