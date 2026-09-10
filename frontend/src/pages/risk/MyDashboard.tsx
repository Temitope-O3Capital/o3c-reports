import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, NUM, TEXT, FW, SP, RADIUS, INTER } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'
import { DpdBar } from '../../components/DpdBar'
import { bandColor, bandShort, dpdColor } from '../../lib/riskScale'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingApp {
  reference: string; applicant_name: string; product_type: string
  amount_requested_kobo: number; eye_score: number | null; risk_band: string | null; submitted_at: string
}
interface BandRow { band: string; count: number }
interface DpdBucketRow { bucket: string; count: number; kobo: number }
interface WatchRow {
  cif: string; name: string; product: string
  outstanding_kobo: number; arrears_kobo: number; dpd: number; band: string | null; score: number | null
}
interface RiskDash {
  origination_live?: boolean
  // review pipeline (only when origination live)
  pending?: number; reviewed_today?: number; approved_mtd?: number; declined_mtd?: number
  oldest_pending_days?: number; pending_by_band?: BandRow[]; pending_list?: PendingApp[]
  // live credit book + delinquency (always)
  book_loans?: number; book_outstanding_kobo?: number; arrears_kobo?: number
  current_loans?: number; par30_loans?: number; npl_loans?: number; npl_kobo?: number; worst_dpd?: number
  dpd_buckets?: DpdBucketRow[]
  watchlist?: WatchRow[]
}

const N = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RiskMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<RiskDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/risk/my-dashboard')
      setD((r?.data ?? r ?? {}) as RiskDash)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(), { topics: ['loans'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !d) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !d) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!d) return null

  const live = d.origination_live !== false
  const pending = N(d.pending)
  const reviewedToday = N(d.reviewed_today)
  const approved = N(d.approved_mtd)
  const declined = N(d.declined_mtd)
  const oldest = N(d.oldest_pending_days)

  const bookLoans = N(d.book_loans)
  const outstanding = N(d.book_outstanding_kobo)
  const arrears = N(d.arrears_kobo)
  const par30 = N(d.par30_loans)
  const npl = N(d.npl_loans)
  const worstDpd = N(d.worst_dpd)
  const watchlist = d.watchlist ?? []
  const pastDue = bookLoans - N(d.current_loans)
  const buckets = d.dpd_buckets ?? []

  const toPortfolio = () => navigate('/operations/risk/portfolio')
  const toPortfolioFiltered = (dpd: string) => navigate(`/operations/risk/portfolio?dpd=${dpd}`)
  const toAppReview = () => navigate('/operations/risk/applications')
  const OVERDUE = 'par30,par60,par90,npl'

  const watchCols: TableCol<WatchRow>[] = [
    { key: 'name', label: 'Borrower', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.name || 'Unknown'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{r.cif}</div>
      </div>
    )},
    { key: 'product', label: 'Product', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.product || '—'}</span> },
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', render: r => <span style={NUM}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    { key: 'arrears_kobo', label: 'Arrears', align: 'right', render: r => <span style={{ ...NUM, color: N(r.arrears_kobo) > 0 ? RED : 'var(--txt3)' }}>{N(r.arrears_kobo) > 0 ? fmtKoboExact(r.arrears_kobo) : '—'}</span> },
    { key: 'dpd', label: 'DPD', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: dpdColor(r.dpd) }}>{fmtNum(r.dpd)}</span> },
    { key: 'band', label: 'Band', render: r => r.band ? <StatusPill label={bandShort(r.band)} color={bandColor(r.band)} /> : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  const bandCols: TableCol<BandRow>[] = [
    { key: 'band', label: 'Risk Band', render: r => <StatusPill label={r.band} color={bandColor(r.band)} /> },
    { key: 'count', label: 'Pending', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.count)}</span> },
  ]

  const appCols: TableCol<PendingApp>[] = [
    { key: 'applicant_name', label: 'Applicant', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.applicant_name || 'Unknown'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{r.reference}</div>
      </div>
    )},
    { key: 'product_type', label: 'Product', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.product_type || '—'}</span> },
    { key: 'amount_requested_kobo', label: 'Amount', align: 'right', render: r => <span style={NUM}>{fmtKoboExact(r.amount_requested_kobo)}</span> },
    { key: 'risk_band', label: 'Band', render: r => r.risk_band ? <StatusPill label={r.risk_band} color={bandColor(r.risk_band)} /> : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'submitted_at', label: 'Waiting', render: r => {
      const days = r.submitted_at ? Math.floor((Date.now() - new Date(r.submitted_at).getTime()) / 864e5) : 0
      return <span style={{ color: days >= 3 ? RED : 'var(--txt2)', fontWeight: days >= 3 ? FW.semibold : FW.normal, fontSize: TEXT.xs }}>{days}d</span>
    }},
  ]

  return (
    <Page title="My Workspace" subtitle="Your risk station: the credit book you own and what's going bad">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={live && pending > 0
          ? <><strong style={{ color: '#fff' }}>{fmtNum(pending)}</strong> application{pending === 1 ? '' : 's'} awaiting review{oldest > 0 ? <> · oldest <strong style={{ color: oldest >= 3 ? '#FCA5A5' : '#fff' }}>{fmtNum(oldest)}d</strong></> : ''} · <strong style={{ color: '#FCA5A5' }}>{fmtNum(pastDue)}</strong> loans past due</>
          : pastDue > 0
            ? <><strong style={{ color: '#FCA5A5' }}>{fmtNum(pastDue)}</strong> of {fmtNum(bookLoans)} loans past due · <strong style={{ color: '#fff' }}>{fmtKoboExact(arrears)}</strong> in arrears · worst <strong style={{ color: worstDpd > 90 ? '#FCA5A5' : '#fff' }}>{fmtNum(worstDpd)}d</strong></>
            : 'Your book is current. Nothing past due.'}
        ring={{ value: Math.max(0, bookLoans - pastDue), max: Math.max(1, bookLoans), unit: 'current' }}
        stats={[
          { label: 'Credit Book', value: fmtKoboExact(outstanding) },
          { label: 'In Arrears', value: fmtKoboExact(arrears), color: arrears > 0 ? '#FCA5A5' : '#fff' },
          { label: 'PAR30 Loans', value: fmtNum(par30), color: par30 > 0 ? '#FCD34D' : '#fff' },
          { label: 'NPL Loans', value: fmtNum(npl), color: npl > 0 ? '#FCA5A5' : '#4ADE80' },
        ]}
        actions={<>
          <HeroButton icon="fact_check" label="Review Applications" primary onClick={toAppReview} />
          <HeroButton icon="account_balance_wallet" label="My Loan Book" onClick={toPortfolio} />
          <HeroButton icon="error_outline" label="NPL Loans" onClick={() => toPortfolioFiltered('npl')} />
        </>}
      />

      {/* ── My Day — the action list, each tile wired to where the work is ── */}
      <MyDaySection hint="the accounts that need action today">
        <MyDayTile icon="warning_amber" count={fmtNum(pastDue)} label="Loans past due"
          sub={pastDue > 0 ? 'open the overdue book' : 'book is current'}
          color={AMBER} urgent={pastDue > 0} onClick={() => toPortfolioFiltered(OVERDUE)} />
        <MyDayTile icon="error_outline" count={fmtNum(npl)} label="NPL loans"
          sub={npl > 0 ? `${fmtKoboExact(N(d.npl_kobo))} at risk` : 'none over 90 DPD'}
          color={npl > 0 ? RED : GREEN} urgent={npl > 0} onClick={() => toPortfolioFiltered('npl')} />
        <MyDayTile icon="hourglass_bottom" count={worstDpd > 0 ? `${fmtNum(worstDpd)}d` : '0'} label="Worst DPD"
          sub={worstDpd > 90 ? 'in NPL territory' : worstDpd > 30 ? 'past 30 days' : 'within 30 days'}
          color={worstDpd > 90 ? RED : worstDpd > 30 ? AMBER : GREEN} urgent={worstDpd > 90} onClick={toPortfolio} />
        <MyDayTile icon="pending_actions" count={live ? fmtNum(pending) : '—'} label="Applications to review"
          sub={live ? (pending > 0 ? 'decisions on your desk' : 'queue clear') : 'none raised yet'}
          color={BLUE} urgent={live && pending > 0} onClick={toAppReview} />
      </MyDaySection>

      {/* ── DPD distribution ── */}
      <SectionCard title="Delinquency Distribution" subtitle="Your book by days past due (schedule-derived)" style={{ marginBottom: 14 }}>
        {bookLoans === 0
          ? <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No active loans on your book</div>
          : <DpdBar buckets={buckets} />}
      </SectionCard>

      {/* ── Watchlist: the action list ── */}
      <SectionCard title="Watchlist" subtitle="Delinquent loans, worst first — the accounts to chase" badge={watchlist.length} style={{ marginBottom: 14 }}>
        <DataTable
          cols={watchCols}
          rows={watchlist}
          keyFn={r => r.cif + r.product}
          onRowClick={r => navigate(`/customers/${encodeURIComponent(r.cif)}`)}
          pageSize={10}
          emptyText="Nothing past due — your book is current"
        />
      </SectionCard>

      {/* ── Applications to review — always shown so the queue is one click away,
             even before origination goes live (it simply reads empty then). ── */}
      {live ? (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
          <SectionCard title="Applications Awaiting Review" badge={d.pending_list?.length ?? 0}>
            <DataTable
              cols={appCols}
              rows={d.pending_list ?? []}
              keyFn={r => r.reference}
              onRowClick={toAppReview}
              pageSize={8}
              emptyText="Nothing awaiting your review"
            />
          </SectionCard>
          <SectionCard title="Pending by Band" badge={d.pending_by_band?.length ?? 0}>
            <DataTable cols={bandCols} rows={d.pending_by_band ?? []} keyFn={r => r.band} pageSize={8} emptyText="Nothing pending" />
          </SectionCard>
        </div>
      ) : (
        <SectionCard title="Applications to Review">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 4px' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 34, color: 'var(--txt3)' }}>fact_check</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>No applications in the review pipeline yet</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>
                New applications raised here or synced from Phoenix will land in Loan/Credit Card Review. Open it to see the queue and take decisions.
              </div>
            </div>
            <button onClick={toAppReview} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: RADIUS.md,
              background: NAVY, color: '#fff', border: 'none', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              Open Loan/Credit Card Review
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_forward</span>
            </button>
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
