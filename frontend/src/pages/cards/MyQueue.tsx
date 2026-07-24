import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, RED, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface IssuanceItem {
  id: number; request_ref: string; customer_name: string; cif: string
  card_type: string; requested_at: string; status: string; priority: string
}

interface DisputeItem {
  id: number; dispute_ref: string; customer_name: string; cif: string
  amount_kobo: number; dispute_type: string; raised_at: string; status: string
}

interface CardsAgentDash {
  issuance_assigned: number; disputes_assigned: number
  processed_today: number; avg_processing_time_hrs: number
  issuance_queue: IssuanceItem[]
  disputes_queue: DisputeItem[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'], background: `${color}18`, color, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
      {label}
    </span>
  )
}

const PRIORITY_COLOR: Record<string, string> = { high: RED, medium: AMBER, low: BLUE, urgent: RED }
const CARD_TYPE_COLOR: Record<string, string> = { credit: NAVY, debit: BLUE, prepaid: AMBER, virtual: '#7C3AED' }

function priorityColor(p: string) { return PRIORITY_COLOR[p?.toLowerCase()] ?? NAVY }
function cardTypeColor(c: string) { return CARD_TYPE_COLOR[c?.toLowerCase()] ?? NAVY }

function statusColor(s: string) {
  const l = s.toLowerCase()
  if (l.includes('complet') || l.includes('resolv') || l.includes('approv')) return GREEN
  if (l.includes('pending') || l.includes('review')) return AMBER
  if (l.includes('reject') || l.includes('fail') || l.includes('denied')) return RED
  return NAVY
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CardsMyQueue() {
  const [data, setData] = useState<CardsAgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: CardsAgentDash }>('/api/cards/my-queue')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return (
    <Page title="My Card Queue" back={{ label: 'Card Operations', to: '/cards' }}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title="My Card Queue" back={{ label: 'Card Operations', to: '/cards' }}>
      <ErrBanner error={error} onRetry={load} />
    </Page>
  )
  if (!data) return null

  const issuanceCols: TableCol<IssuanceItem>[] = [
    { key: 'request_ref', label: 'Ref', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs }}>{r.request_ref}</span> },
    { key: 'customer_name', label: 'Customer', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.customer_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{r.cif}</div>
      </div>
    )},
    { key: 'card_type', label: 'Card Type', render: r => <StatusPill label={r.card_type} color={cardTypeColor(r.card_type)} /> },
    { key: 'requested_at', label: 'Requested', render: r => fmtDate(r.requested_at) },
    { key: 'priority', label: 'Priority', render: r => <StatusPill label={r.priority} color={priorityColor(r.priority)} /> },
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={statusColor(r.status)} /> },
  ]

  const disputeCols: TableCol<DisputeItem>[] = [
    { key: 'dispute_ref', label: 'Ref', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs }}>{r.dispute_ref}</span> },
    { key: 'customer_name', label: 'Customer', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.customer_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{r.cif}</div>
      </div>
    )},
    { key: 'amount_kobo', label: 'Amount', render: r => <span style={NUM}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'dispute_type', label: 'Type', render: r => <StatusPill label={r.dispute_type} color={NAVY} /> },
    { key: 'raised_at', label: 'Raised', render: r => fmtDate(r.raised_at) },
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={statusColor(r.status)} /> },
  ]

  return (
    <Page title="My Card Queue" subtitle="Issuance requests and disputes assigned to you" back={{ label: 'Card Operations', to: '/cards' }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Issuance Assigned" value={fmtNum(data.issuance_assigned)} icon="credit_card" />
        <KpiCard label="Disputes Assigned" value={fmtNum(data.disputes_assigned)} icon="gavel" accent={RED} />
        <KpiCard label="Processed Today" value={fmtNum(data.processed_today)} icon="check_circle" accent={GREEN} />
        <KpiCard label="Avg Processing Time" value={`${data.avg_processing_time_hrs}h`} icon="schedule" accent={AMBER} />
      </div>

      {/* Issuance queue */}
      <SectionCard title="Issuance Queue" badge={data.issuance_queue.length} style={{ marginBottom: 14 }}>
        <DataTable
          cols={issuanceCols}
          rows={data.issuance_queue}
          keyFn={r => r.id}
          searchKeys={['request_ref', 'customer_name', 'cif', 'card_type', 'status', 'priority']}
          searchPlaceholder="Search issuance requests…"
          pageSize={10}
          emptyText="No issuance requests assigned"
        />
      </SectionCard>

      {/* Disputes queue */}
      <SectionCard title="Disputes Queue" badge={data.disputes_queue.length}>
        <DataTable
          cols={disputeCols}
          rows={data.disputes_queue}
          keyFn={r => r.id}
          searchKeys={['dispute_ref', 'customer_name', 'cif', 'dispute_type', 'status']}
          searchPlaceholder="Search disputes…"
          pageSize={10}
          emptyText="No disputes assigned"
        />
      </SectionCard>
    </Page>
  )
}
