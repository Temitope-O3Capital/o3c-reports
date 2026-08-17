import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExceptionRow { source: string; source_ref: string; reason: string; amount_kobo: number; txn_date: string; status: string; created_at: string }
interface RunRow { kind: string; source: string; counterparty: string; status: string; unmatched_n: number; matched_n: number; started_at: string }
interface LastRun { status: string; kind: string; source: string; counterparty: string; unmatched_n: number; matched_n: number; finished_at: string | null; started_at: string }
interface SettlementDash {
  my_exceptions?: number; my_exceptions_value_kobo?: number; my_exceptions_aging?: number
  team_exceptions_open?: number
  failed_txns?: number; failed_txns_value_kobo?: number
  postings_pending?: number; my_postings_pending?: number
  last_run?: LastRun
  position_net_kobo?: number; position_pending_kobo?: number
  my_exception_list?: ExceptionRow[]
  recent_runs?: RunRow[]
}

function runStatusColor(s: string) {
  const l = (s || '').toLowerCase()
  if (l === 'ok') return GREEN
  if (l === 'error') return RED
  if (l === 'running') return BLUE
  return AMBER
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<SettlementDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/settlements/my-dashboard')
      setD((r?.data ?? r ?? {}) as SettlementDash)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['settlements'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !d) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !d) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!d) return null

  const myExc = d.my_exceptions ?? 0
  const myExcValue = d.my_exceptions_value_kobo ?? 0
  const aging = d.my_exceptions_aging ?? 0
  const teamOpen = d.team_exceptions_open ?? 0
  const failed = d.failed_txns ?? 0
  const postingsPending = d.postings_pending ?? 0
  const positionNet = d.position_net_kobo ?? 0
  const lr = d.last_run
  const matched = Number(lr?.matched_n ?? 0)
  const unmatched = Number(lr?.unmatched_n ?? 0)
  const runTotal = matched + unmatched
  const showRing = !!lr && runTotal > 0

  const excCols: TableCol<ExceptionRow>[] = [
    { key: 'source', label: 'Source', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.source || '—'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{r.source_ref || ''}</div>
      </div>
    )},
    { key: 'reason', label: 'Reason', render: r => <StatusPill label={(r.reason || '').replace(/_/g, ' ')} color={AMBER} /> },
    { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => <span style={NUM}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'created_at', label: 'Age', render: r => {
      const days = r.created_at ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / 864e5) : 0
      return <span style={{ color: days >= 3 ? RED : 'var(--txt2)', fontWeight: days >= 3 ? FW.semibold : FW.normal, fontSize: TEXT.xs }}>{days}d</span>
    }},
  ]

  const runCols: TableCol<RunRow>[] = [
    { key: 'source', label: 'Run', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.source || '—'}{r.counterparty ? ` ↔ ${r.counterparty}` : ''}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{r.kind}</div>
      </div>
    )},
    { key: 'matched_n', label: 'Matched', align: 'right', render: r => <span style={{ ...NUM, color: GREEN }}>{fmtNum(r.matched_n ?? 0)}</span> },
    { key: 'unmatched_n', label: 'Unmatched', align: 'right', render: r => <span style={{ ...NUM, color: (r.unmatched_n ?? 0) > 0 ? RED : 'var(--txt3)' }}>{fmtNum(r.unmatched_n ?? 0)}</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={runStatusColor(r.status)} /> },
    { key: 'started_at', label: 'Started', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDate(r.started_at)}</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your settlement desk — exceptions, runs and position">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={aging > 0
          ? <><strong style={{ color: '#FCA5A5' }}>{fmtNum(aging)}</strong> of your exceptions {aging === 1 ? 'is' : 'are'} aging past 3 days — clear the oldest first</>
          : myExc > 0
            ? <><strong style={{ color: '#fff' }}>{fmtNum(myExc)}</strong> exception{myExc === 1 ? '' : 's'} assigned to you · {fmtKobo(myExcValue)}</>
            : 'No exceptions on your desk — the book is matched.'}
        ring={showRing ? { value: matched, max: runTotal, unit: 'matched' } : undefined}
        stats={[
          { label: 'My Exceptions', value: fmtNum(myExc), color: aging > 0 ? '#FCA5A5' : '#fff' },
          { label: 'Exception Value', value: fmtKobo(myExcValue) },
          { label: 'Failed Txns', value: fmtNum(failed), color: failed > 0 ? '#FCA5A5' : '#fff' },
          { label: 'Postings Pending', value: fmtNum(postingsPending) },
          { label: 'Position Net', value: fmtKobo(positionNet), color: positionNet >= 0 ? '#4ADE80' : '#FCA5A5' },
          { label: 'Team Open', value: fmtNum(teamOpen) },
        ]}
        actions={<>
          <HeroButton icon="rule" label="Recon Workbench" primary onClick={() => navigate('/settlements/workbench')} />
          <HeroButton icon="report" label="Exceptions" onClick={() => navigate('/settlements/exceptions')} />
          <HeroButton icon="account_balance" label="Position" onClick={() => navigate('/settlements/position')} />
          <HeroButton icon="history" label="Runs & Imports" onClick={() => navigate('/settlements/runs')} />
          <HeroButton icon="edit_note" label="Manual Postings" onClick={() => navigate('/settlements/manual-postings')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="items to reconcile today">
        <MyDayTile icon="hourglass_bottom" count={fmtNum(aging)} label="Aging exceptions"
          sub={aging > 0 ? 'open past 3 days' : 'nothing aging'}
          color={aging > 0 ? RED : GREEN} urgent={aging > 0} onClick={() => navigate('/settlements/exceptions')} />
        <MyDayTile icon="error" count={fmtNum(failed)} label="Failed transactions"
          sub={failed > 0 ? 'retry or resolve' : 'none failed'}
          color={AMBER} urgent={failed > 0} onClick={() => navigate('/settlements/exceptions')} />
        <MyDayTile icon="approval" count={fmtNum(postingsPending)} label="Postings pending"
          sub={(d.my_postings_pending ?? 0) > 0 ? `${fmtNum(d.my_postings_pending ?? 0)} raised by you` : 'awaiting approval'}
          color={PURPLE} urgent={postingsPending > 0} onClick={() => navigate('/settlements/manual-postings')} />
        <MyDayTile icon="published_with_changes" count={fmtNum(unmatched)} label="Unmatched (last run)"
          sub={lr ? `${lr.source ?? 'recon'} · ${lr.status}` : 'no runs yet'}
          color={BLUE} onClick={() => navigate('/settlements/runs')} />
      </MyDaySection>

      {/* My exceptions */}
      <SectionCard title="My Exceptions" badge={d.my_exception_list?.length ?? 0} style={{ marginBottom: 14 }}>
        <DataTable
          cols={excCols}
          rows={d.my_exception_list ?? []}
          keyFn={(r) => `${r.source}-${r.source_ref}-${r.created_at}`}
          onRowClick={() => navigate('/settlements/exceptions')}
          pageSize={8}
          emptyText="No exceptions assigned to you 🎉"
        />
      </SectionCard>

      {/* Recent runs */}
      <SectionCard title="Recent Recon Runs" badge={d.recent_runs?.length ?? 0}>
        <DataTable
          cols={runCols}
          rows={d.recent_runs ?? []}
          keyFn={(r) => `${r.source}-${r.started_at}`}
          onRowClick={() => navigate('/settlements/runs')}
          pageSize={8}
          emptyText="No recon runs yet"
        />
      </SectionCard>
    </Page>
  )
}
