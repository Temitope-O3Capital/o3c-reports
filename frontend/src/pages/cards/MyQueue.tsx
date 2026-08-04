import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner, Spinner, ExpandableFilterBar } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, RED, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface IssuanceItem {
  id: number; cif_number: string; customer_name: string
  card_type: string; created_at: string; status: string
}

interface DisputeItem {
  id: number; cif_number: string; customer_name: string; card_type?: string
  amount_kobo: number; dispute_type: string; filed_at: string; status: string
}

interface CardsSummary { issuance_count: number; disputes_count: number; credit_reviews_count: number }

interface CardsAgentDash {
  summary?: CardsSummary
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

const CARD_TYPE_COLOR: Record<string, string> = { credit: NAVY, debit: BLUE, prepaid: AMBER, virtual: '#7C3AED' }

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

  // Issuance filters
  const [iSearch,     setISearch]     = useState('')
  const [iStatuses,   setIStatuses]   = useState(new Set<string>())

  // Dispute filters
  const [dSearch,  setDSearch]  = useState('')
  const [dStatuses, setDStatuses] = useState(new Set<string>())

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<any>('/api/cards/my-queue')
      const d = r?.data ?? r ?? {}
      // Backend returns disputes under open_disputes; normalize + default arrays.
      setData({ ...d, issuance_queue: d.issuance_queue ?? [], disputes_queue: d.disputes_queue ?? d.open_disputes ?? [] })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['cards'] })

  const issuanceQueue = useMemo(() => (data?.issuance_queue ?? []).filter(r => {
    if (iStatuses.size && !iStatuses.has(r.status?.toLowerCase())) return false
    if (iSearch) {
      const q = iSearch.toLowerCase()
      return (r.customer_name ?? '').toLowerCase().includes(q) || (r.cif_number ?? '').toLowerCase().includes(q) || (r.card_type ?? '').toLowerCase().includes(q)
    }
    return true
  }), [data, iStatuses, iSearch])

  const disputesQueue = useMemo(() => (data?.disputes_queue ?? []).filter(r => {
    if (dStatuses.size && !dStatuses.has(r.status?.toLowerCase())) return false
    if (dSearch) {
      const q = dSearch.toLowerCase()
      return (r.customer_name ?? '').toLowerCase().includes(q) || (r.cif_number ?? '').toLowerCase().includes(q) || (r.dispute_type ?? '').toLowerCase().includes(q)
    }
    return true
  }), [data, dStatuses, dSearch])

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
    { key: 'customer_name', label: 'Customer', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.customer_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{r.cif_number}</div>
      </div>
    )},
    { key: 'card_type', label: 'Card Type', render: r => <StatusPill label={r.card_type} color={cardTypeColor(r.card_type)} /> },
    { key: 'created_at', label: 'Requested', render: r => fmtDate(r.created_at) },
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={statusColor(r.status)} /> },
  ]

  const disputeCols: TableCol<DisputeItem>[] = [
    { key: 'customer_name', label: 'Customer', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.customer_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{r.cif_number}</div>
      </div>
    )},
    { key: 'amount_kobo', label: 'Amount', render: r => <span style={NUM}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'dispute_type', label: 'Type', render: r => <StatusPill label={r.dispute_type} color={NAVY} /> },
    { key: 'filed_at', label: 'Raised', render: r => fmtDate(r.filed_at) },
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={statusColor(r.status)} /> },
  ]

  return (
    <Page title="My Card Queue" subtitle="Issuance requests and disputes assigned to you" back={{ label: 'Card Operations', to: '/cards' }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Issuance Queue" value={fmtNum(data.summary?.issuance_count ?? 0)} icon="credit_card" />
        <KpiCard label="Open Disputes" value={fmtNum(data.summary?.disputes_count ?? 0)} icon="gavel" accent={RED} />
        <KpiCard label="Credit Reviews" value={fmtNum(data.summary?.credit_reviews_count ?? 0)} icon="fact_check" accent={AMBER} />
        <KpiCard label="Total Pending" value={fmtNum((data.summary?.issuance_count ?? 0) + (data.summary?.disputes_count ?? 0) + (data.summary?.credit_reviews_count ?? 0))} icon="assignment" accent={NAVY} />
      </div>

      {/* Issuance queue */}
      <SectionCard title="Issuance Queue" badge={issuanceQueue.length} style={{ marginBottom: 14 }} padding={false}>
        <ExpandableFilterBar
          search={iSearch}
          onSearch={setISearch}
          groups={[
            {
              key: 'status',
              label: 'Status',
              options: ['pending', 'doc_review', 'credit_check', 'risk_review'].map(v => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) })),
              selected: iStatuses,
              onChange: setIStatuses,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setISearch(''); setIStatuses(new Set()) }}
          resultCount={issuanceQueue.length}
          totalCount={data.issuance_queue.length}
          placeholder="Search issuance requests…"
        />
        <DataTable
          cols={issuanceCols}
          rows={issuanceQueue}
          keyFn={r => r.id}
          pageSize={10}
          emptyText="No issuance requests assigned"
        />
      </SectionCard>

      {/* Disputes queue */}
      <SectionCard title="Disputes Queue" badge={disputesQueue.length} padding={false}>
        <ExpandableFilterBar
          search={dSearch}
          onSearch={setDSearch}
          groups={[
            {
              key: 'status',
              label: 'Status',
              options: ['filed', 'investigating', 'provisional_credit', 'resolved', 'declined'].map(v => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) })),
              selected: dStatuses,
              onChange: setDStatuses,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setDSearch(''); setDStatuses(new Set()) }}
          resultCount={disputesQueue.length}
          totalCount={data.disputes_queue.length}
          placeholder="Search disputes…"
        />
        <DataTable
          cols={disputeCols}
          rows={disputesQueue}
          keyFn={r => r.id}
          pageSize={10}
          emptyText="No disputes assigned"
        />
      </SectionCard>
    </Page>
  )
}
