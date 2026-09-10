import { useEffect, useState, useCallback } from 'react'
import { Page, DataTable, ErrBanner, Spinner, type TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { currentUser } from '../../hooks/useAuth'
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

function isSupervisor(): boolean {
  const role = currentUser()?.role ?? ''
  return role === 'call_center_head' || ['admin', 'md', 'coo', 'cfo', 'cmo'].includes(role)
}

export default function CallCenterForwards() {
  const sup = isSupervisor()
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

  const cards: { key: string; label: string; color: string }[] = [
    { key: 'total',      label: 'Forwarded',  color: NAVY },
    { key: 'with_sales', label: 'With Sales', color: AMBER },
    { key: 'assigned',   label: 'Assigned',   color: PURPLE },
    { key: 'converted',  label: 'Converted',  color: GREEN },
    { key: 'rejected',   label: 'Rejected',   color: RED },
  ]

  const cols: TableCol<Forward>[] = [
    { key: 'customer_name', label: 'Customer', render: r => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.customer_name || '—'}</div>
        <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.customer_phone || (r.customer_cif ? `CIF ${r.customer_cif}` : '')}</div>
      </div>
    ) },
    { key: 'product_interest', label: 'Product', render: r => r.product_interest || <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'sales_owner_name', label: 'Sales Owner', render: r => r.sales_owner_name || <span style={{ color: 'var(--txt3)' }}>Unassigned</span> },
    ...(sup && scope === 'all' ? [{ key: 'lead_agent_name', label: 'Agent', render: (r: Forward) => r.lead_agent_name || <span style={{ color: 'var(--txt3)' }}>—</span> } as TableCol<Forward>] : []),
    { key: 'campaign_name', label: 'Campaign', render: r => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.marketing_campaign_name || r.campaign_name || '—'}</span>
    ) },
    { key: 'forwarded_at', label: 'Forwarded', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDatetime(r.forwarded_at)}</span> },
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
        }}>{s === 'all' ? 'Whole floor' : 'My forwards'}</button>
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: SP[3], marginBottom: 16 }}>
        {cards.map(c => (
          <div key={c.key} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>{c.label}</div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: c.color, lineHeight: 1 }}>{fmtNum(summary[c.key] ?? 0)}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}><Spinner size={28} /></div>
      ) : (
        <DataTable
          cols={cols} rows={rows} keyFn={r => r.id}
          searchKeys={['customer_name', 'customer_phone', 'product_interest', 'sales_owner_name', 'lead_agent_name']}
          searchPlaceholder="Search customer, product, owner…"
          filters={[{ key: 'status', label: 'Status' }]}
          pageSize={25} emptyText={sup && scope === 'all' ? 'No leads forwarded to Sales yet.' : "You haven't forwarded any leads to Sales yet."}
        />
      )}

      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 12, fontFamily: INTER }}>
        {title} · outcomes update automatically as Sales works each lead.
      </div>
    </Page>
  )
}
