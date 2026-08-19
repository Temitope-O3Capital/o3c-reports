import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, ExpandableFilterBar } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LogPaymentModal } from '../../components/LogPaymentModal'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, NAVY, GREEN, BLUE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, PresenceControl, StatusPill, HeroButton, myUserId } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Case {
  id: number; case_ref: string; debtor_name: string
  outstanding_kobo: number; dpd: number; next_action: string
  next_action_date: string; status: string
}

interface Visit {
  id: number; case_ref: string; debtor_name: string
  outcome: string; visited_at: string; amount_promised_kobo: number
}

interface RecoveryAgentDash {
  assigned_cases: number; cases_closed_mtd: number
  calls_made_mtd: number; amount_collected_mtd_kobo: number
  cases: Case[]
  recent_visits: Visit[]
  monthly_trend: { month: string; collected: number; calls: number }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function DpdCell({ dpd }: { dpd: number }) {
  const color = dpd > 90 ? RED : dpd > 30 ? AMBER : 'var(--txt)'
  return <span style={{ color, fontWeight: dpd > 30 ? FW.semibold : FW.normal, ...NUM }}>{dpd}d</span>
}

function outcomeColor(o: string) {
  const l = o.toLowerCase()
  if (l.includes('paid') || l.includes('promise')) return GREEN
  if (l.includes('refus') || l.includes('absent')) return RED
  return AMBER
}

// Money tooltip on white cards.
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm }}>
      <p style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color, marginBottom: 2 }}>{p.name}: {fmtKobo(p.value)}</p>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RecoveryAgentDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<RecoveryAgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchCases, setSearchCases] = useState('')
  const [searchVisits, setSearchVisits] = useState('')
  const [payCase, setPayCase] = useState<Case | null>(null)
  const [status, setStatus] = useState('available')

  const load = useCallback(async (silent = false) => {
    setError(null)
    try {
      const r = await apiFetch<{ data: RecoveryAgentDash }>('/api/recovery-ops/agent-dashboard')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['recovery'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  const changeStatus = useCallback(async (s: string) => {
    setStatus(s)
    const uid = myUserId()
    if (!uid) return
    try { await apiFetch(`/api/helpdesk/agents/${uid}/status`, { method: 'PUT', body: JSON.stringify({ status: s }) }) }
    catch (e: any) { toast.error(e?.message || 'Could not update status') }
  }, [])

  const displayedCases = useMemo(() => {
    const rows = data?.cases ?? []
    if (!searchCases.trim()) return rows
    const q = searchCases.toLowerCase()
    return rows.filter(r =>
      [r.case_ref, r.debtor_name, r.status, r.next_action].some(v => v != null && String(v).toLowerCase().includes(q))
    )
  }, [data?.cases, searchCases])

  const displayedVisits = useMemo(() => {
    const rows = data?.recent_visits ?? []
    if (!searchVisits.trim()) return rows
    const q = searchVisits.toLowerCase()
    return rows.filter(r =>
      [r.debtor_name, r.outcome, r.case_ref].some(v => v != null && String(v).toLowerCase().includes(q))
    )
  }, [data?.recent_visits, searchVisits])

  if (loading && !data) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !data) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!data) return null

  const now = Date.now()
  const actionsDue = data.cases.filter(c => c.next_action_date && new Date(c.next_action_date).getTime() <= now).length
  const severe = data.cases.filter(c => c.dpd > 90).length
  const clearMax = Math.max(1, data.assigned_cases + data.cases_closed_mtd)

  const caseCols: TableCol<Case>[] = [
    { key: 'case_ref', label: 'Case Ref', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs }}>{r.case_ref}</span> },
    { key: 'debtor_name', label: 'Debtor' },
    { key: 'outstanding_kobo', label: 'Outstanding', render: r => <span style={NUM}>{fmtKobo(r.outstanding_kobo)}</span> },
    { key: 'dpd', label: 'DPD', render: r => <DpdCell dpd={r.dpd} /> },
    { key: 'next_action', label: 'Next Action', render: r => (
      <div>
        <div style={{ fontSize: TEXT.xs }}>{r.next_action}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{fmtDate(r.next_action_date)}</div>
      </div>
    )},
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={NAVY} /> },
    {
      key: 'id', label: '',
      render: r => (
        <button
          onClick={e => { e.stopPropagation(); setPayCase(r) }}
          style={{
            padding: '4px 11px', borderRadius: '6px',
            border: `1.5px solid ${GREEN}40`, background: `${GREEN}0A`,
            color: GREEN, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Log Payment
        </button>
      ),
    },
  ]

  const visitCols: TableCol<Visit>[] = [
    { key: 'debtor_name', label: 'Debtor', render: r => (
      <div>
        <div>{r.debtor_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{r.case_ref}</div>
      </div>
    )},
    { key: 'outcome', label: 'Outcome', render: r => <StatusPill label={r.outcome} color={outcomeColor(r.outcome)} /> },
    { key: 'visited_at', label: 'Date', render: r => fmtDate(r.visited_at) },
    { key: 'amount_promised_kobo', label: 'Promised', render: r => <span style={NUM}>{fmtKobo(r.amount_promised_kobo)}</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your recovery station: cases, visits and collections">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        presence={<PresenceControl status={status} onChange={changeStatus} />}
        subline={<>You've collected <strong style={{ color: '#fff' }}>{fmtKobo(data.amount_collected_mtd_kobo)}</strong> this month · {fmtNum(data.cases_closed_mtd)} case{data.cases_closed_mtd === 1 ? '' : 's'} closed{severe > 0 ? <> · <strong style={{ color: '#FCA5A5' }}>{severe}</strong> at 90+ DPD</> : ''}</>}
        ring={{ value: data.cases_closed_mtd, max: clearMax, unit: 'cases' }}
        stats={[
          { label: 'Assigned Cases', value: fmtNum(data.assigned_cases) },
          { label: 'Closed MTD', value: fmtNum(data.cases_closed_mtd), color: '#4ADE80' },
          { label: 'Calls MTD', value: fmtNum(data.calls_made_mtd) },
          { label: 'Collected MTD', value: fmtKobo(data.amount_collected_mtd_kobo), color: '#4ADE80' },
        ]}
        actions={<>
          <HeroButton icon="folder_open" label="My Cases" primary onClick={() => navigate('/recovery/cases')} />
          <HeroButton icon="gavel" label="Legal Tracker" onClick={() => navigate('/recovery/legal')} />
          <HeroButton icon="sell" label="Debt Sales" onClick={() => navigate('/recovery/debt-sales')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="cases to work today">
        <MyDayTile icon="event_available" count={fmtNum(actionsDue)} label="Actions due"
          sub={actionsDue > 0 ? 'follow-ups scheduled by now' : 'nothing due'}
          color={AMBER} urgent={actionsDue > 0} onClick={() => navigate('/recovery/cases')} />
        <MyDayTile icon="priority_high" count={fmtNum(severe)} label="Severe (90+ DPD)"
          sub={severe > 0 ? 'escalate or push hard' : 'none at 90+ DPD'}
          color={severe > 0 ? RED : GREEN} urgent={severe > 0} onClick={() => navigate('/recovery/cases')} />
        <MyDayTile icon="directions_walk" count={fmtNum(data.recent_visits.length)} label="Recent visits"
          sub="field visits logged" color={BLUE} />
        <MyDayTile icon="payments" count={fmtKobo(data.amount_collected_mtd_kobo)} label="Collected MTD"
          sub="recovered this month" color={GREEN} />
      </MyDaySection>

      {/* Cases table */}
      <SectionCard title="My Cases" badge={data.cases.length} padding={false} style={{ marginBottom: SP[4] }}>
        <ExpandableFilterBar
          search={searchCases}
          onSearch={setSearchCases}
          groups={[]}
          onReset={() => setSearchCases('')}
          resultCount={displayedCases.length}
          totalCount={data.cases.length}
          placeholder="Search cases…"
        />
        <DataTable
          cols={caseCols}
          rows={displayedCases}
          keyFn={r => r.id}
          onRowClick={() => navigate('/recovery/cases')}
          pageSize={10}
          emptyText="No cases assigned"
        />
      </SectionCard>

      {/* Trend chart + recent visits */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        <SectionCard title="Monthly Collection Trend">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.monthly_trend} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="rcGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={RED} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={RED} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} width={70} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="collected" name="Collected" stroke={RED} fill="url(#rcGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Recent Field Visits" padding={false}>
          <ExpandableFilterBar
            search={searchVisits}
            onSearch={setSearchVisits}
            groups={[]}
            onReset={() => setSearchVisits('')}
            resultCount={displayedVisits.length}
            totalCount={data.recent_visits.length}
            placeholder="Search visits…"
          />
          <DataTable
            cols={visitCols}
            rows={displayedVisits}
            keyFn={r => r.id}
            emptyText="No visits recorded"
          />
        </SectionCard>
      </div>
      <LogPaymentModal
        open={!!payCase}
        onClose={() => setPayCase(null)}
        title={`Log Payment: ${payCase?.debtor_name ?? ''}`}
        endpoint={payCase ? `/api/recovery-ops/cases/${payCase.id}/payment` : ''}
        onSuccess={() => { setPayCase(null); load() }}
      />
    </Page>
  )
}
