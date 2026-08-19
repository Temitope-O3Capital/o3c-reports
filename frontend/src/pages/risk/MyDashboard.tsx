import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, NUM, TEXT, FW } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingApp {
  reference: string; applicant_name: string; product_type: string
  amount_requested_kobo: number; eye_score: number | null; risk_band: string | null; submitted_at: string
}
interface BandRow { band: string; count: number }
interface RiskDash {
  origination_live?: boolean
  pending?: number; reviewed_today?: number; reviewed_week?: number
  approved_mtd?: number; declined_mtd?: number; oldest_pending_days?: number
  pending_by_band?: BandRow[]
  pending_list?: PendingApp[]
  book_loans?: number; book_outstanding_kobo?: number
}

// Risk-band colour: reddens for higher-risk labels regardless of the vocabulary used.
function bandColor(b: string | null): string {
  const l = (b || '').toLowerCase()
  if (/high|poor|^[de]$|very/.test(l)) return RED
  if (/medium|fair|^c$|watch/.test(l)) return AMBER
  if (/low|good|strong|^[ab]$|prime/.test(l)) return GREEN
  return NAVY
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RiskMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<RiskDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/risk/my-dashboard')
      setD((r?.data ?? r ?? {}) as RiskDash)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['loans'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !d) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !d) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!d) return null

  const pending = d.pending ?? 0
  const reviewedToday = d.reviewed_today ?? 0
  const approved = d.approved_mtd ?? 0
  const declined = d.declined_mtd ?? 0
  const oldest = d.oldest_pending_days ?? 0
  const decisionsMtd = approved + declined
  const clearMax = Math.max(1, reviewedToday + pending)
  const live = d.origination_live !== false

  const appCols: TableCol<PendingApp>[] = [
    { key: 'applicant_name', label: 'Applicant', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.applicant_name || 'Unknown'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{r.reference}</div>
      </div>
    )},
    { key: 'product_type', label: 'Product', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.product_type || '—'}</span> },
    { key: 'amount_requested_kobo', label: 'Amount', align: 'right', render: r => <span style={NUM}>{fmtKobo(r.amount_requested_kobo)}</span> },
    { key: 'risk_band', label: 'Band', render: r => r.risk_band ? <StatusPill label={r.risk_band} color={bandColor(r.risk_band)} /> : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'submitted_at', label: 'Waiting', render: r => {
      const days = r.submitted_at ? Math.floor((Date.now() - new Date(r.submitted_at).getTime()) / 864e5) : 0
      return <span style={{ color: days >= 3 ? RED : 'var(--txt2)', fontWeight: days >= 3 ? FW.semibold : FW.normal, fontSize: TEXT.xs }}>{days}d</span>
    }},
  ]

  const bandCols: TableCol<BandRow>[] = [
    { key: 'band', label: 'Risk Band', render: r => <StatusPill label={r.band} color={bandColor(r.band)} /> },
    { key: 'count', label: 'Pending', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.count)}</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your risk station: review pipeline and portfolio">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={!live
          ? 'Origination review isn’t live on this deployment yet. Showing the credit book.'
          : pending > 0
            ? <><strong style={{ color: '#fff' }}>{fmtNum(pending)}</strong> application{pending === 1 ? '' : 's'} awaiting your review{oldest > 0 ? <> · oldest <strong style={{ color: oldest >= 3 ? '#FCA5A5' : '#fff' }}>{fmtNum(oldest)}d</strong></> : ''}</>
            : 'Review queue is clear. Nothing waiting on you.'}
        ring={live ? { value: reviewedToday, max: clearMax, unit: 'reviewed' } : undefined}
        stats={[
          { label: 'Pending Review', value: fmtNum(pending), color: oldest >= 3 ? '#FCA5A5' : '#fff' },
          { label: 'Reviewed Today', value: fmtNum(reviewedToday), color: '#4ADE80' },
          { label: 'Approved MTD', value: fmtNum(approved), color: '#4ADE80' },
          { label: 'Declined MTD', value: fmtNum(declined) },
          { label: 'Oldest Pending', value: oldest > 0 ? `${fmtNum(oldest)}d` : '—', color: oldest >= 3 ? '#FCA5A5' : '#fff' },
          { label: 'Credit Book', value: fmtKobo(d.book_outstanding_kobo ?? 0) },
        ]}
        actions={<>
          <HeroButton icon="fact_check" label="App Review" primary onClick={() => navigate('/operations/risk/applications')} />
          <HeroButton icon="pie_chart" label="Portfolio" onClick={() => navigate('/operations/risk/portfolio')} />
          <HeroButton icon="stacked_line_chart" label="Vintage" onClick={() => navigate('/operations/risk/vintage')} />
          <HeroButton icon="shield" label="Risk Overview" onClick={() => navigate('/operations/risk')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="applications to decide today">
        <MyDayTile icon="pending_actions" count={fmtNum(pending)} label="Awaiting review"
          sub={pending > 0 ? 'decisions on your desk' : 'queue clear'}
          color={AMBER} urgent={pending > 0} onClick={() => navigate('/operations/risk/applications')} />
        <MyDayTile icon="hourglass_bottom" count={oldest > 0 ? `${fmtNum(oldest)}d` : '0'} label="Oldest waiting"
          sub={oldest >= 3 ? 'breaching turnaround' : 'within turnaround'}
          color={oldest >= 3 ? RED : GREEN} urgent={oldest >= 3} onClick={() => navigate('/operations/risk/applications')} />
        <MyDayTile icon="task_alt" count={fmtNum(reviewedToday)} label="Reviewed today"
          sub="decisions made today" color={GREEN} />
        <MyDayTile icon="balance" count={fmtNum(decisionsMtd)} label="Decisions MTD"
          sub={`${fmtNum(approved)} approved · ${fmtNum(declined)} declined`} color={BLUE} onClick={() => navigate('/operations/risk/applications')} />
      </MyDaySection>

      {/* Applications awaiting review */}
      <SectionCard title="Applications Awaiting Review" badge={d.pending_list?.length ?? 0} style={{ marginBottom: 14 }}>
        <DataTable
          cols={appCols}
          rows={d.pending_list ?? []}
          keyFn={r => r.reference}
          onRowClick={() => navigate('/operations/risk/applications')}
          pageSize={8}
          emptyText={live ? 'Nothing awaiting your review' : 'Origination review pipeline is not live here'}
        />
      </SectionCard>

      {/* Pending by band */}
      <SectionCard title="Pending by Risk Band" badge={d.pending_by_band?.length ?? 0}>
        <DataTable
          cols={bandCols}
          rows={d.pending_by_band ?? []}
          keyFn={r => r.band}
          pageSize={8}
          emptyText="Nothing pending"
        />
      </SectionCard>
    </Page>
  )
}
