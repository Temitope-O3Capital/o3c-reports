import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, ExpandableFilterBar } from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, RED, PURPLE, NUM, TEXT, FW } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'

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

const CARD_TYPE_COLOR: Record<string, string> = { credit: NAVY, debit: BLUE, prepaid: AMBER, virtual: PURPLE }
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
  const navigate = useNavigate()
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
    setError(null)
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
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

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

  if (loading && !data) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !data) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!data) return null

  const issuance = data.summary?.issuance_count ?? 0
  const disputes = data.summary?.disputes_count ?? 0
  const reviews = data.summary?.credit_reviews_count ?? 0
  const totalPending = issuance + disputes + reviews

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
    <Page title="My Workspace" subtitle="Your card-ops station — issuance, disputes and reviews">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={totalPending > 0
          ? <>You have <strong style={{ color: '#fff' }}>{fmtNum(totalPending)}</strong> item{totalPending === 1 ? '' : 's'} in your queue{disputes > 0 ? <> · <strong style={{ color: '#FCA5A5' }}>{fmtNum(disputes)}</strong> dispute{disputes === 1 ? '' : 's'} to work</> : ''}</>
          : 'Queue is clear — nothing pending assigned to you.'}
        stats={[
          { label: 'Issuance', value: fmtNum(issuance) },
          { label: 'Open Disputes', value: fmtNum(disputes), color: disputes > 0 ? '#FCA5A5' : '#fff' },
          { label: 'Credit Reviews', value: fmtNum(reviews) },
          { label: 'Total Pending', value: fmtNum(totalPending), color: '#4ADE80' },
        ]}
        actions={<>
          <HeroButton icon="badge" label="Issuance Queue" primary onClick={() => navigate('/cards/issuance')} />
          <HeroButton icon="gavel" label="Disputes" onClick={() => navigate('/cards/disputes')} />
          <HeroButton icon="fact_check" label="Credit Limit Review" onClick={() => navigate('/cards/credit-limit')} />
          <HeroButton icon="warning" label="At-Risk Cards" onClick={() => navigate('/cards/at-risk')} />
          <HeroButton icon="manage_accounts" label="Cardholder Mgmt" onClick={() => navigate('/cards/management')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="cards work waiting on you">
        <MyDayTile icon="badge" count={fmtNum(issuance)} label="Issuance pending"
          sub={issuance > 0 ? 'cards to issue' : 'nothing to issue'}
          color={BLUE} urgent={issuance > 0} onClick={() => navigate('/cards/issuance')} />
        <MyDayTile icon="gavel" count={fmtNum(disputes)} label="Open disputes"
          sub={disputes > 0 ? 'investigate & resolve' : 'no open disputes'}
          color={disputes > 0 ? RED : GREEN} urgent={disputes > 0} onClick={() => navigate('/cards/disputes')} />
        <MyDayTile icon="fact_check" count={fmtNum(reviews)} label="Credit reviews"
          sub="limit decisions due" color={AMBER} urgent={reviews > 0} onClick={() => navigate('/cards/credit-limit')} />
        <MyDayTile icon="assignment" count={fmtNum(totalPending)} label="Total pending"
          sub="across all your queues" color={NAVY} />
      </MyDaySection>

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
