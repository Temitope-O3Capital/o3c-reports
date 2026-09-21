import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, DataTable, ErrBanner, EmptyState, type TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtCount } from '../../lib/fmt'
import { isCallCentreSupervisor } from '../../lib/roles'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, INTER, NUM, FW, RADIUS, TEXT, SP } from '../../lib/design'

// Track leads the call centre forwarded to Sales, all the way to their outcome.
// An agent sees their own forwards; a supervisor/head sees the whole floor and can
// switch to just their own. The outcome is read live from the sales pipeline.

interface Forward {
  id: number
  lead_id: number | null
  forwarded_by: number | null
  forwarded_by_name: string | null
  lead_agent_name: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_cif: string | null
  product_interest: string | null
  notes: string | null
  forwarded_at: string
  resolved_at: string | null
  outcome: string | null
  status: string
  crm_stage: string | null
  converted_cif: string | null
  disqualify_reason: string | null
  sales_owner_name: string | null
  campaign_name: string | null
  marketing_campaign_name: string | null
}

const STATUS: Record<string, { label: string; color: string }> = {
  forwarded:  { label: 'Forwarded',  color: BLUE },
  with_sales: { label: 'With Sales', color: AMBER },
  assigned:   { label: 'Assigned',   color: PURPLE },
  converted:  { label: 'Converted',  color: GREEN },
  rejected:   { label: 'Rejected',   color: RED },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status.replace(/_/g, ' '), color: '#6B7280' }
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: s.color, background: `${s.color}16`,
      padding: '3px 10px', borderRadius: RADIUS['2xl'], whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
      {s.label}
    </span>
  )
}

// Ageing on the hand-off. A forwarded lead could sit unclaimed indefinitely with nothing
// on this page showing it. Anything not yet converted or rejected is still waiting.
const RESOLVED = new Set(['converted', 'rejected'])

function waitingHours(r: Forward): number | null {
  if (RESOLVED.has(r.status)) return null
  const t = new Date(r.forwarded_at).getTime()
  if (!isFinite(t)) return null
  return Math.max(0, (Date.now() - t) / 36e5)
}

// A day is fine, three days is slipping, a week is a lead nobody picked up.
function ageColor(h: number): string {
  if (h >= 168) return RED
  if (h >= 72)  return AMBER
  return 'var(--txt2)'
}

function fmtAge(h: number): string {
  if (h < 1)  return '< 1h'
  if (h < 24) return `${Math.floor(h)}h`
  return `${Math.floor(h / 24)}d`
}

export default function CallCenterForwards() {
  // One shared definition of "supervisor" for the whole module (lib/roles.ts). This file
  // used to carry its own role list while Queue and Leads carried a different one — which
  // is why the COO got the whole floor here and an agent's view there.
  const sup = isCallCentreSupervisor()
  const [scope, setScope]     = useState<'all' | 'mine'>(sup ? 'all' : 'mine')
  const [rows, setRows]       = useState<Forward[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const q = sup && scope === 'mine' ? '?scope=mine' : ''
    try {
      // Both endpoints reply through respond(), which wraps the payload as
      // { data, data_source, data_as_of } — so read .data, not the envelope.
      const [list, sum] = await Promise.all([
        apiFetch<{ data: Forward[] } | Forward[]>(`/api/call-center/forwards${q}`),
        apiFetch<{ data: Record<string, number> } | Record<string, number>>(`/api/call-center/forwards/summary${q}`),
      ])
      const listAny: any = list
      const sumAny: any = sum
      const rowsArr = Array.isArray(listAny) ? listAny : (listAny?.data ?? [])
      const sumObj: Record<string, number> = (sumAny && !Array.isArray(sumAny) && sumAny.data) ? sumAny.data : (sumAny ?? {})
      setRows(Array.isArray(rowsArr) ? rowsArr : [])
      setSummary(sumObj ?? {})
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [sup, scope])

  useEffect(() => { load() }, [load])

  // The five buckets are mutually exclusive and add up to the backend's `total`. The
  // first card used to show `total` itself: with 10 forwarded / 4 with sales / 3
  // converted / 2 rejected it read 19 beside four cards summing to 9, and the 10 leads
  // actually waiting to be picked up appeared nowhere on the page.
  const cards: { key: string; label: string; color: string }[] = [
    { key: 'forwarded',  label: 'Awaiting Pickup', color: BLUE },
    { key: 'with_sales', label: 'With Sales',      color: AMBER },
    { key: 'assigned',   label: 'Assigned',        color: PURPLE },
    { key: 'converted',  label: 'Converted',       color: GREEN },
    { key: 'rejected',   label: 'Rejected',        color: RED },
  ]
  const bucketTotal = cards.reduce((n, c) => n + (summary[c.key] ?? 0), 0)

  // Each row carries its waiting age so the column sorts on a real number. -1 keeps
  // resolved rows (nothing left to wait for) below everything still outstanding.
  type Row = Forward & { _waiting_hours: number }
  const tableRows: Row[] = useMemo(
    () => rows.map(r => ({ ...r, _waiting_hours: waitingHours(r) ?? -1 })),
    [rows],
  )

  const cols: TableCol<Row>[] = [
    { key: 'customer_name', label: 'Customer', render: r => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.customer_name || '—'}</div>
        <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.customer_phone || (r.customer_cif ? `CIF ${r.customer_cif}` : '')}</div>
      </div>
    ) },
    { key: 'product_interest', label: 'Product', render: r => r.product_interest || <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'sales_owner_name', label: 'Sales Owner', render: r => r.sales_owner_name || <span style={{ color: 'var(--txt3)' }}>Unassigned</span> },
    ...(sup && scope === 'all' ? [{ key: 'lead_agent_name', label: 'Agent', render: (r: Forward) => r.lead_agent_name || <span style={{ color: 'var(--txt3)' }}>—</span> } as TableCol<Row>] : []),
    { key: 'campaign_name', label: 'Campaign', render: r => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.marketing_campaign_name || r.campaign_name || '—'}</span>
    ) },
    { key: 'forwarded_at', label: 'Forwarded', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDatetime(r.forwarded_at)}</span> },
    { key: '_waiting_hours', label: 'Waiting', render: r => {
      if (r._waiting_hours < 0) return <span style={{ color: 'var(--txt3)', fontSize: TEXT.xs }}>—</span>
      const col = ageColor(r._waiting_hours)
      const stale = r._waiting_hours >= 72
      return (
        <span
          title={`Forwarded ${fmtDatetime(r.forwarded_at)} — still waiting to be picked up`}
          style={{ ...NUM, fontSize: TEXT.xs, fontWeight: stale ? FW.bold : FW.medium, color: col,
            ...(stale ? { background: `${col}16`, padding: '2px 8px', borderRadius: RADIUS['2xl'] } : {}) }}
        >{fmtAge(r._waiting_hours)}</span>
      )
    } },
    { key: 'outcome', label: 'Outcome', render: r =>
      r.status === 'converted' ? <span style={{ fontSize: TEXT.xs, color: GREEN }}>{r.converted_cif ? `CIF ${r.converted_cif}` : 'Converted'}</span>
      : r.status === 'rejected' ? <span style={{ fontSize: TEXT.xs, color: RED }}>{r.disqualify_reason || r.outcome || 'Rejected'}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  const title = sup && scope === 'all' ? 'Forwarded to Sales · Team' : 'My Forwarded Leads'

  const scopeToggle = sup ? (
    <div style={{ display: 'flex', gap: 2, background: 'var(--chip-bg)', borderRadius: RADIUS.md, padding: 3, border: '1px solid var(--bdr)' }}>
      {(['all', 'mine'] as const).map(s => (
        <button key={s} onClick={() => setScope(s)} style={{
          padding: '5px 14px', borderRadius: 7, border: 'none', fontSize: TEXT.sm, fontFamily: INTER, cursor: 'pointer',
          fontWeight: scope === s ? FW.bold : FW.medium,
          background: scope === s ? 'var(--card)' : 'transparent',
          color: scope === s ? 'var(--txt)' : 'var(--txt2)',
          boxShadow: scope === s ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
        }}>{s === 'all' ? 'Whole Floor' : 'My Forwards'}</button>
      ))}
    </div>
  ) : null

  return (
    <Page title="Forwarded to Sales"
      subtitle={sup ? 'Leads the floor forwarded to Sales — tracked to their outcome' : 'Interested customers you worked that were forwarded to Sales'}
      loading={loading && rows.length === 0}
      skeletonKpis={5}
      actions={scopeToggle}>
      {error && <ErrBanner error={error} onRetry={load} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: SP[3], marginBottom: 10 }}>
        {cards.map(c => (
          <div key={c.key} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>{c.label}</div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: c.color, lineHeight: 1 }}>{fmtCount(summary[c.key] ?? 0)}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 16, fontFamily: INTER }}>
        <b style={{ ...NUM, color: NAVY }}>{fmtCount(bucketTotal)}</b> forwarded in total — the five figures above are exclusive and add up to it.
      </div>

      {/* Refreshed in place. Swapping the whole table out for a spinner on every refresh
          threw away the in-table search, the filter chips and the page position. */}
      <DataTable
        cols={cols} rows={tableRows} keyFn={r => r.id}
        loading={loading && rows.length === 0}
        searchKeys={['customer_name', 'customer_phone', 'product_interest', 'sales_owner_name', 'lead_agent_name']}
        searchPlaceholder="Search customer, product, owner…"
        filters={[{ key: 'status', label: 'Status' }]}
        pageSize={25}
        emptyText={
          <EmptyState
            icon="forward_to_inbox"
            title={sup && scope === 'all' ? 'No Leads Forwarded Yet' : 'No Forwarded Leads Yet'}
            description={sup && scope === 'all'
              ? 'Leads the floor hands to Sales show up here, tracked to their outcome.'
              : 'Forward an interested customer from Leads and you can follow it to its outcome here.'}
          />
        }
      />

      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 12, fontFamily: INTER }}>
        {title} · outcomes update automatically as Sales works each lead.
      </div>
    </Page>
  )
}
