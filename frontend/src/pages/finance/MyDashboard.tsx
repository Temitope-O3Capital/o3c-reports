import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, NUM, TEXT, FW } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, HeroButton } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Maturity { customer_name: string; principal_kobo: number; maturity_date: string; interest_rate: number }
interface Upload { txn_date: string; filename: string; txn_count: number; uploaded_at: string }
interface FinanceDash {
  cash_position_kobo?: number
  eod_last_date?: string; eod_last_count?: number; eod_today_loaded?: boolean
  recent_uploads?: Upload[]
  income_mtd_kobo?: number
  fd_active?: number; fd_principal_kobo?: number; fd_matured_this_month?: number
  fd_maturing_7d?: number; fd_maturing_7d_kobo?: number
  upcoming_maturities?: Maturity[]
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinanceMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<FinanceDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/finance/my-dashboard')
      setD((r?.data ?? r ?? {}) as FinanceDash)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['finance'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !d) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !d) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!d) return null

  const cash = d.cash_position_kobo ?? 0
  const income = d.income_mtd_kobo ?? 0
  const fdActive = d.fd_active ?? 0
  const fdBook = d.fd_principal_kobo ?? 0
  const maturing7 = d.fd_maturing_7d ?? 0
  const maturing7Kobo = d.fd_maturing_7d_kobo ?? 0
  const maturedMonth = d.fd_matured_this_month ?? 0
  const eodLoaded = !!d.eod_today_loaded

  const maturityCols: TableCol<Maturity>[] = [
    { key: 'customer_name', label: 'Customer', render: r => <span style={{ fontWeight: FW.semibold }}>{r.customer_name || 'Unknown'}</span> },
    { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => <span style={NUM}>{fmtKobo(r.principal_kobo)}</span> },
    { key: 'interest_rate', label: 'Rate', align: 'right', render: r => <span style={NUM}>{r.interest_rate != null ? `${r.interest_rate}%` : '—'}</span> },
    { key: 'maturity_date', label: 'Matures', render: r => {
      const soon = r.maturity_date && new Date(r.maturity_date).getTime() <= Date.now() + 7 * 864e5
      return <span style={{ color: soon ? AMBER : 'var(--txt2)', fontWeight: soon ? FW.semibold : FW.normal, fontSize: TEXT.xs }}>{fmtDate(r.maturity_date)}</span>
    }},
  ]

  const uploadCols: TableCol<Upload>[] = [
    { key: 'txn_date', label: 'Value Date', render: r => <span style={{ fontWeight: FW.semibold }}>{fmtDate(r.txn_date)}</span> },
    { key: 'filename', label: 'File', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.filename || '—'}</span> },
    { key: 'txn_count', label: 'Rows', align: 'right', render: r => <span style={NUM}>{fmtNum(r.txn_count ?? 0)}</span> },
    { key: 'uploaded_at', label: 'Loaded', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDate(r.uploaded_at)}</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your finance desk — cash, income, EOD and deposits">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={eodLoaded
          ? <>Today's EOD is loaded — the books are current{maturing7 > 0 ? <> · <strong style={{ color: '#fff' }}>{fmtNum(maturing7)}</strong> FD{maturing7 === 1 ? '' : 's'} maturing this week</> : ''}</>
          : <>Today's EOD isn't loaded yet{d.eod_last_date ? <> — last file was <strong style={{ color: '#FCA5A5' }}>{fmtDate(d.eod_last_date)}</strong></> : ''}</>}
        stats={[
          { label: 'Cash Position', value: fmtKobo(cash), color: cash >= 0 ? '#4ADE80' : '#FCA5A5' },
          { label: 'Income MTD', value: fmtKobo(income), color: '#4ADE80' },
          { label: 'FD Book', value: fmtKobo(fdBook) },
          { label: 'Active FDs', value: fmtNum(fdActive) },
          { label: 'Maturing 7d', value: fmtKobo(maturing7Kobo), color: maturing7 > 0 ? '#FCD34D' : '#fff' },
          { label: 'EOD Today', value: eodLoaded ? 'Loaded' : 'Pending', color: eodLoaded ? '#4ADE80' : '#FCA5A5' },
        ]}
        actions={<>
          <HeroButton icon="receipt_long" label="Transactions" primary onClick={() => navigate('/finance/transactions')} />
          <HeroButton icon="payments" label="Income" onClick={() => navigate('/finance/income')} />
          <HeroButton icon="savings" label="Fixed Deposits" onClick={() => navigate('/deposits')} />
          <HeroButton icon="event_available" label="EOD / EOB" onClick={() => navigate('/finance/eod')} />
          <HeroButton icon="currency_exchange" label="FX Rates" onClick={() => navigate('/finance/fx-rates')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="what the desk needs today">
        <MyDayTile icon="event_available" count={eodLoaded ? 'In' : 'Due'} label="Today's EOD"
          sub={eodLoaded ? 'file loaded — books current' : 'load today’s EOD file'}
          color={eodLoaded ? GREEN : RED} urgent={!eodLoaded} onClick={() => navigate('/finance/eod')} />
        <MyDayTile icon="schedule" count={fmtNum(maturing7)} label="FDs maturing (7d)"
          sub={maturing7 > 0 ? `${fmtKobo(maturing7Kobo)} to settle` : 'none this week'}
          color={AMBER} urgent={maturing7 > 0} onClick={() => navigate('/deposits')} />
        <MyDayTile icon="task_alt" count={fmtNum(maturedMonth)} label="Matured this month"
          sub="FDs reached maturity" color={BLUE} onClick={() => navigate('/deposits')} />
        <MyDayTile icon="trending_up" count={fmtKobo(income)} label="Income MTD"
          sub="earned this month" color={GREEN} onClick={() => navigate('/finance/income')} />
      </MyDaySection>

      {/* FD maturities */}
      <SectionCard title="FD Maturities Coming Up" badge={d.upcoming_maturities?.length ?? 0} style={{ marginBottom: 14 }}>
        <DataTable
          cols={maturityCols}
          rows={d.upcoming_maturities ?? []}
          keyFn={(r) => `${r.customer_name}-${r.maturity_date}`}
          onRowClick={() => navigate('/deposits')}
          pageSize={8}
          emptyText="No upcoming maturities"
        />
      </SectionCard>

      {/* Recent EOD uploads */}
      <SectionCard title="Recent EOD Uploads" badge={d.recent_uploads?.length ?? 0}>
        <DataTable
          cols={uploadCols}
          rows={d.recent_uploads ?? []}
          keyFn={(r) => `${r.txn_date}-${r.filename}`}
          onRowClick={() => navigate('/finance/eod')}
          pageSize={8}
          emptyText="No EOD uploads yet"
        />
      </SectionCard>
    </Page>
  )
}
