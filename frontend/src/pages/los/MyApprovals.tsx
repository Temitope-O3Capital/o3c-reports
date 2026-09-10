import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, StatusBadge, NameCell } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { useLiveData } from '../../hooks/useRealtime'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate, fmtPct } from '../../lib/fmt'
import { TEXT, FW, RADIUS, NAVY, GREEN, AMBER, RED, NUM } from '../../lib/design'
import { stageMeta, decisionMeta, syncStateMeta, inboxRoleLabel, prettyStage } from '../../lib/losFlow'

interface InboxApp {
  id: number
  reference: string
  applicant_name: string
  applicant_cif: string | null
  product_type: string
  amount_requested_kobo: number
  amount_approved_kobo: number
  status: string
  stage: string
  eye_score: number | null
  risk_band: string | null
  dti_pct: number | null
  decision: string | null
  phoenix_sync_state: string | null
  source_system: string | null
  monthly_income_kobo: number
  submitted_at: string | null
  updated_at: string | null
  days_in_stage: number | null
}

function eyeColor(s: number | null): string {
  if (s === null) return 'var(--txt3)'
  if (s >= 700) return GREEN
  if (s >= 500) return AMBER
  return RED
}

function StagePill({ stage }: { stage: string }) {
  const m = stageMeta(stage)
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: m.bg, color: m.txt, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  )
}

function DecisionChip({ decision, sync }: { decision: string | null; sync: string | null }) {
  const d = (decision ?? '').toLowerCase()
  if (!d || d === 'pending') {
    const s = syncStateMeta(sync)
    if (s) return <span style={{ fontSize: TEXT.xs, fontWeight: FW.medium, color: s.txt }}>{s.label}</span>
    return <span style={{ color: 'var(--txt3)' }}>—</span>
  }
  const m = decisionMeta(d)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full, background: m.bg, color: m.txt, whiteSpace: 'nowrap' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{m.icon}</span>
      {m.label}
    </span>
  )
}

export default function MyApprovals() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<InboxApp[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    try {
      const res = await apiFetch<{ data: InboxApp[]; total: number }>('/api/los/inbox?limit=300')
      setRows(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['loans'] })

  const roleLabel = useMemo(() => inboxRoleLabel(), [])

  const waiting = rows.length
  const oldest = rows.reduce((mx, r) => Math.max(mx, r.days_in_stage ?? 0), 0)
  const recApprove = rows.filter(r => (r.decision ?? '').toLowerCase() === 'approve').length
  const flagged = rows.filter(r => ['decline', 'refer'].includes((r.decision ?? '').toLowerCase())).length

  const cols: TableCol<InboxApp>[] = [
    { key: 'applicant_name', label: 'Applicant', render: r => <NameCell name={r.applicant_name} sub={r.reference} /> },
    { key: 'product_type', label: 'Product', render: r => <span style={{ fontSize: TEXT.sm }}>{prettyStage(r.product_type)}</span> },
    {
      key: 'amount_requested_kobo', label: 'Amount', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_approved_kobo || r.amount_requested_kobo)}</span>,
    },
    { key: 'stage', label: 'Stage', render: r => <StagePill stage={r.stage} /> },
    {
      key: 'eye_score', label: 'Eye Score', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: eyeColor(r.eye_score) }}>{r.eye_score ?? '—'}</span>,
    },
    {
      key: 'dti_pct', label: 'DTI', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600, color: r.dti_pct !== null && r.dti_pct > 40 ? RED : 'var(--txt2)' }}>{r.dti_pct !== null ? fmtPct(r.dti_pct) : '—'}</span>,
    },
    { key: 'decision', label: 'Phoenix', render: r => <DecisionChip decision={r.decision} sync={r.phoenix_sync_state} /> },
    {
      key: 'days_in_stage', label: 'Waiting', align: 'right', sortable: true,
      render: r => {
        const d = r.days_in_stage ?? 0
        return <span style={{ ...NUM, fontWeight: 600, color: d > 3 ? RED : d > 1 ? AMBER : 'var(--txt2)' }}>{d}d</span>
      },
    },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} size="sm" /> },
    {
      key: '_open', label: '', sortable: false,
      render: r => (
        <button
          onClick={e => { e.stopPropagation(); navigate(`/applications/${r.id}`) }}
          style={{ padding: '5px 12px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >Review</button>
      ),
    },
  ]

  return (
    <Page
      title="My Approvals"
      subtitle={`${roleLabel} — applications awaiting your action`}
      loading={loading && rows.length === 0}
      skeletonKpis={4}
    >
      <ErrBanner error={err} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Waiting on you"      value={waiting}    icon="inbox"        accent={NAVY}  loading={loading} />
        <KpiCard label="Oldest (days)"       value={oldest}     icon="schedule"     accent={oldest > 3 ? RED : AMBER} loading={loading} />
        <KpiCard label="Recommend approve"   value={recApprove} icon="thumb_up"     accent={GREEN} loading={loading} />
        <KpiCard label="Flagged by Phoenix"  value={flagged}    icon="flag"         accent={RED}   loading={loading} />
      </div>

      <SectionCard title="Awaiting your decision" badge={rows.length} padding={false}>
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          onRowClick={r => navigate(`/applications/${r.id}`)}
          emptyText="Nothing is waiting on you right now. Applications arrive here when they reach a stage you own."
        />
      </SectionCard>
    </Page>
  )
}
