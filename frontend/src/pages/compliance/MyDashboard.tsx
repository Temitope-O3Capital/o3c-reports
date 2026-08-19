import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, TEXT, FW } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Finding {
  finding_ref: string; description: string; severity: string; status: string; due_date: string | null
}
interface Deadline {
  report_name: string; regulatory_body: string; due_date: string | null; status: string
}
interface ComplianceDash {
  my_open_findings?: number; my_findings_overdue?: number
  my_findings_by_severity?: { severity: string; count: number }[]
  my_findings?: Finding[]
  my_checklists_due?: number; my_checklists_overdue?: number
  my_reg_open?: number; my_reg_overdue?: number
  my_deadlines?: Deadline[]
  kyc_expiring_30d?: number; active_watch_list?: number; pending_sars?: number
}

const SEVERITY_COLOR: Record<string, string> = { critical: RED, high: RED, medium: AMBER, low: BLUE }
function severityColor(s: string) { return SEVERITY_COLOR[s?.toLowerCase()] ?? NAVY }

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ComplianceMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<ComplianceDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    setError(null)
    try {
      const r = await apiFetch<any>('/api/compliance/my-dashboard')
      setD((r?.data ?? r ?? {}) as ComplianceDash)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['compliance'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !d) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !d) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!d) return null

  const openFindings = d.my_open_findings ?? 0
  const findingsOverdue = d.my_findings_overdue ?? 0
  const checklistsDue = d.my_checklists_due ?? 0
  const checklistsOverdue = d.my_checklists_overdue ?? 0
  const regOpen = d.my_reg_open ?? 0
  const regOverdue = d.my_reg_overdue ?? 0
  const kycExpiring = d.kyc_expiring_30d ?? 0
  const watchlist = d.active_watch_list ?? 0

  const openTotal = openFindings + checklistsDue + regOpen
  const overdueTotal = findingsOverdue + checklistsOverdue + regOverdue
  const onTime = Math.max(0, openTotal - overdueTotal)

  const findingCols: TableCol<Finding>[] = [
    { key: 'finding_ref', label: 'Ref', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs }}>{r.finding_ref}</span> },
    { key: 'description', label: 'Finding', render: r => <span style={{ fontWeight: FW.medium }}>{r.description || '—'}</span> },
    { key: 'severity', label: 'Severity', render: r => <StatusPill label={r.severity} color={severityColor(r.severity)} /> },
    { key: 'due_date', label: 'Due', render: r => r.due_date
      ? <span style={{ color: new Date(r.due_date).getTime() < Date.now() ? RED : 'var(--txt2)', fontWeight: FW.semibold, fontSize: TEXT.xs }}>{fmtDate(r.due_date)}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  const deadlineCols: TableCol<Deadline>[] = [
    { key: 'report_name', label: 'Report', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.report_name || '—'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{r.regulatory_body || ''}</div>
      </div>
    )},
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status || 'draft'} color={NAVY} /> },
    { key: 'due_date', label: 'Due', render: r => r.due_date
      ? <span style={{ color: new Date(r.due_date).getTime() < Date.now() ? RED : 'var(--txt2)', fontWeight: FW.semibold, fontSize: TEXT.xs }}>{fmtDate(r.due_date)}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  return (
    <Page title="My Workspace" subtitle="Your compliance station: findings, checklists and deadlines">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={overdueTotal > 0
          ? <><strong style={{ color: '#FCA5A5' }}>{fmtNum(overdueTotal)}</strong> item{overdueTotal === 1 ? '' : 's'} past deadline, clear {overdueTotal === 1 ? 'it' : 'them'} first</>
          : openTotal > 0
            ? <>Everything's within deadline, <strong style={{ color: '#fff' }}>{fmtNum(openTotal)}</strong> open item{openTotal === 1 ? '' : 's'} on track</>
            : 'Nothing outstanding. Your compliance queue is clear.'}
        ring={{ value: onTime, max: Math.max(1, openTotal), unit: 'on time' }}
        stats={[
          { label: 'Open Findings', value: fmtNum(openFindings), color: findingsOverdue > 0 ? '#FCA5A5' : '#fff' },
          { label: 'Checklists Due', value: fmtNum(checklistsDue) },
          { label: 'Reg Deadlines', value: fmtNum(regOpen) },
          { label: 'Overdue', value: fmtNum(overdueTotal), color: overdueTotal > 0 ? '#FCA5A5' : '#4ADE80' },
          { label: 'KYC Expiring', value: fmtNum(kycExpiring) },
          { label: 'Watchlist', value: fmtNum(watchlist) },
        ]}
        actions={<>
          <HeroButton icon="policy" label="Findings" primary onClick={() => navigate('/compliance/findings')} />
          <HeroButton icon="checklist" label="Checklists" onClick={() => navigate('/compliance/checklists')} />
          <HeroButton icon="event" label="Regulatory Calendar" onClick={() => navigate('/compliance/regulatory')} />
          <HeroButton icon="badge" label="KYC Expiry" onClick={() => navigate('/compliance/kyc-expiry')} />
          <HeroButton icon="gpp_maybe" label="AML Watchlist" onClick={() => navigate('/compliance/watchlist')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="compliance work that can't slip">
        <MyDayTile icon="error" count={fmtNum(findingsOverdue)} label="Overdue findings"
          sub={findingsOverdue > 0 ? 'past remediation date' : 'no findings overdue'}
          color={findingsOverdue > 0 ? RED : GREEN} urgent={findingsOverdue > 0} onClick={() => navigate('/compliance/findings')} />
        <MyDayTile icon="checklist" count={fmtNum(checklistsDue)} label="Checklists due"
          sub={checklistsOverdue > 0 ? `${fmtNum(checklistsOverdue)} overdue` : 'assigned to you'}
          color={AMBER} urgent={checklistsOverdue > 0} onClick={() => navigate('/compliance/checklists')} />
        <MyDayTile icon="gavel" count={fmtNum(regOpen)} label="Regulatory deadlines"
          sub={regOverdue > 0 ? `${fmtNum(regOverdue)} overdue` : 'reports you own'}
          color={PURPLE} urgent={regOverdue > 0} onClick={() => navigate('/compliance/regulatory')} />
        <MyDayTile icon="badge" count={fmtNum(kycExpiring)} label="KYC expiring (30d)"
          sub="customers to re-verify" color={BLUE} onClick={() => navigate('/compliance/kyc-expiry')} />
      </MyDaySection>

      {/* My findings */}
      <SectionCard title="My Open Findings" badge={d.my_findings?.length ?? 0} style={{ marginBottom: 14 }}>
        <DataTable
          cols={findingCols}
          rows={d.my_findings ?? []}
          keyFn={r => r.finding_ref}
          onRowClick={() => navigate('/compliance/findings')}
          pageSize={8}
          emptyText="No findings assigned to you"
        />
      </SectionCard>

      {/* Upcoming deadlines */}
      <SectionCard title="Upcoming Regulatory Deadlines" badge={d.my_deadlines?.length ?? 0}>
        <DataTable
          cols={deadlineCols}
          rows={d.my_deadlines ?? []}
          keyFn={r => `${r.report_name}-${r.due_date ?? ''}`}
          onRowClick={() => navigate('/compliance/regulatory')}
          pageSize={8}
          emptyText="No regulatory reports assigned to you"
        />
      </SectionCard>
    </Page>
  )
}
