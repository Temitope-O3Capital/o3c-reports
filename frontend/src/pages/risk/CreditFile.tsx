import { useState } from 'react'
import {
  Page, SectionCard, DataTable, ErrBanner, Spinner,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, SORA, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoanRow {
  id: number
  ref: string
  product: string
  principal_kobo: number
  outstanding_kobo: number
  dpd: number
  status: string
  disbursed_at: string
}

interface CreditFile {
  cif: string
  customer_name: string
  phone: string
  eye_score: number | null
  eye_band: string | null
  bureau_score: number | null
  total_loan_count: number
  active_loan_count: number
  total_outstanding_kobo: number
  worst_dpd: number
  dti_pct: number | null
  kyc_status: string
  bvn: string
  loans: LoanRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEAL = '#0891B2'

function bandColor(band: string | null): string {
  if (!band) return NAVY
  const b = band.toLowerCase()
  if (b === 'excellent') return GREEN
  if (b === 'good') return TEAL
  if (b === 'fair') return AMBER
  if (b === 'poor') return RED
  return NAVY
}

function kycBadge(status: string) {
  const cfg: Record<string, { bg: string; txt: string }> = {
    verified: { bg: `${GREEN}18`, txt: GREEN },
    pending:  { bg: `${AMBER}18`, txt: AMBER },
    expired:  { bg: `${RED}18`,   txt: RED },
  }
  const s = cfg[status.toLowerCase()] ?? { bg: `${NAVY}12`, txt: NAVY }
  return (
    <span style={{
      ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 9px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status.replace(/\b\w/g, c => c.toUpperCase())}
    </span>
  )
}

function maskBvn(bvn: string): string {
  if (!bvn || bvn.length < 4) return bvn
  return bvn.slice(0, 4) + '****'
}

// ── Score tile ────────────────────────────────────────────────────────────────

function ScoreTile({ label, value, sub, color }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string
}) {
  return (
    <div style={{
      flex: 1, minWidth: 130, padding: '14px 16px',
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
        {label}
      </div>
      <div style={{ ...NUM, fontSize: 26, fontWeight: 700, color: color ?? 'var(--txt)', letterSpacing: '-0.5px' }}>
        {value}
      </div>
      {sub && <div style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ── Loan table columns ────────────────────────────────────────────────────────

const LOAN_COLS: TableCol<LoanRow>[] = [
  { key: 'ref',             label: 'Ref',         render: r => r.ref },
  { key: 'product',        label: 'Product',     render: r => r.product },
  { key: 'principal_kobo', label: 'Principal',   render: r => <span style={NUM}>{fmtKobo(r.principal_kobo)}</span> },
  {
    key: 'outstanding_kobo', label: 'Outstanding',
    render: r => <span style={{ ...NUM, color: r.outstanding_kobo > 0 ? RED : 'var(--txt)' }}>{fmtKobo(r.outstanding_kobo)}</span>,
  },
  {
    key: 'dpd', label: 'DPD',
    render: r => (
      <span style={{ ...NUM, fontWeight: 600, color: r.dpd > 0 ? (r.dpd > 30 ? RED : AMBER) : GREEN }}>
        {r.dpd}
      </span>
    ),
  },
  {
    key: 'status', label: 'Status',
    render: r => {
      const s = r.status.toLowerCase()
      const cfg = s === 'active' ? { bg: `${GREEN}18`, txt: GREEN }
        : s === 'defaulted' ? { bg: `${RED}18`, txt: RED }
        : { bg: `${NAVY}12`, txt: NAVY }
      return (
        <span style={{
          ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
          borderRadius: 20, background: cfg.bg, color: cfg.txt,
        }}>
          {r.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
        </span>
      )
    },
  },
  { key: 'disbursed_at', label: 'Disbursed', render: r => fmtDate(r.disbursed_at) },
]

// ── Main component ────────────────────────────────────────────────────────────

export default function CreditFile() {
  const [query,   setQuery]   = useState('')
  const [loading, setLoading] = useState(false)
  const [err,     setErr]     = useState<string | null>(null)
  const [file,    setFile]    = useState<CreditFile | null>(null)
  const [notFound, setNotFound] = useState<string | null>(null)

  async function lookup() {
    const cif = query.trim()
    if (!cif) return
    setLoading(true); setErr(null); setFile(null); setNotFound(null)
    try {
      const res = await apiFetch<CreditFile>(`/api/risk/credit-file/${encodeURIComponent(cif)}`)
      setFile(res)
    } catch (e: any) {
      if (e.status === 404 || (e.message ?? '').toLowerCase().includes('not found')) {
        setNotFound(cif)
      } else {
        setErr(e.message ?? 'Failed to fetch credit file')
      }
    } finally { setLoading(false) }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') lookup()
  }

  return (
    <Page title="Credit File" subtitle="Unified credit assessment for any customer">
      {/* Search bar */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 24,
        maxWidth: 520,
      }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Enter CIF or customer name…"
          style={{
            flex: 1, padding: '9px 12px',
            border: '1px solid var(--input-bdr)', borderRadius: 8,
            fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
            fontFamily: SORA, outline: 'none',
          }}
        />
        <button
          onClick={lookup}
          disabled={loading || !query.trim()}
          style={{
            padding: '9px 20px', borderRadius: 8, border: 'none',
            background: NAVY, color: '#fff', fontSize: 13.5, fontWeight: 600,
            cursor: loading || !query.trim() ? 'not-allowed' : 'pointer',
            opacity: loading || !query.trim() ? 0.6 : 1,
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          {loading && <Spinner size={13} color="#fff" />}
          Look Up
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10, color: 'var(--txt2)', fontSize: 14 }}>
          <Spinner size={18} color={NAVY} /> Fetching credit file…
        </div>
      )}

      {/* Errors */}
      {err && <ErrBanner error={err} />}
      {notFound && (
        <ErrBanner error={`No credit file found for CIF "${notFound}"`} />
      )}

      {/* Results */}
      {file && !loading && (
        <>
          {/* Header card */}
          <SectionCard style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)', marginBottom: 4 }}>
                  {file.customer_name}
                </div>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: 'var(--txt2)' }}>
                    CIF: <strong style={{ color: 'var(--txt)' }}>{file.cif}</strong>
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--txt2)' }}>
                    Phone: <strong style={{ color: 'var(--txt)' }}>{file.phone}</strong>
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--txt2)' }}>
                    BVN: <strong style={{ ...NUM, color: 'var(--txt)' }}>{maskBvn(file.bvn)}</strong>
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--txt2)' }}>KYC:</span>
                {kycBadge(file.kyc_status)}
              </div>
            </div>
          </SectionCard>

          {/* Score strip */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <ScoreTile
              label="Eye Score"
              value={file.eye_score ?? '—'}
              color={file.eye_band ? bandColor(file.eye_band) : undefined}
              sub={file.eye_band && (
                <span style={{
                  ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
                  borderRadius: 20, background: `${bandColor(file.eye_band)}18`,
                  color: bandColor(file.eye_band),
                }}>
                  {file.eye_band}
                </span>
              )}
            />
            <ScoreTile
              label="Bureau Score"
              value={file.bureau_score ?? '—'}
            />
            <ScoreTile
              label="DTI %"
              value={file.dti_pct != null ? `${file.dti_pct.toFixed(1)}%` : '—'}
              color={file.dti_pct != null && file.dti_pct > 50 ? RED : undefined}
            />
            <ScoreTile
              label="Worst DPD"
              value={file.worst_dpd}
              color={file.worst_dpd > 30 ? RED : file.worst_dpd > 0 ? AMBER : GREEN}
            />
          </div>

          {/* Loans table */}
          <SectionCard
            title="Loan History"
            badge={file.loans.length}
          >
            {file.loans.length === 0 ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>
                No loan history on file.
              </div>
            ) : (
              <DataTable<LoanRow>
                cols={LOAN_COLS}
                rows={file.loans}
                keyFn={r => r.id}
              />
            )}
          </SectionCard>
        </>
      )}

      {/* Empty state */}
      {!loading && !file && !err && !notFound && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: '80px 0', gap: 12, color: 'var(--txt2)',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 52, color: 'var(--txt3)' }}>manage_search</span>
          <span style={{ fontSize: 14 }}>Enter a CIF or customer name to look up a credit file</span>
        </div>
      )}
    </Page>
  )
}
