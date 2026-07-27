import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, DateFilter, NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, RED, GREEN, AMBER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KYCExpiry {
  id: number
  customer_name: string
  cif: string
  phone: string
  kyc_type: string
  expiry_date: string
  days_to_expiry: number
  status: string  // "expiring_soon" | "expired"
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function DaysLeft({ days, status }: { days: number; status: string }) {
  if (status === 'expired' || days < 0) {
    return <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: RED }}>Expired</span>
  }
  if (days <= 7) {
    return <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: RED }}>{days}d left</span>
  }
  if (days <= 30) {
    return <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER }}>{days}d left</span>
  }
  return <span style={{ fontSize: TEXT.sm, color: GREEN }}>{days}d left</span>
}

function KYCStatusBadge({ status }: { status: string }) {
  const expired = status === 'expired'
  const bg = expired ? `${RED}18` : `${AMBER}22`
  const color = expired ? RED : AMBER
  const label = expired ? 'Expired' : 'Expiring Soon'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.full, background: bg, color }}>
      {label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function KYCExpiry() {
  const [items, setItems] = useState<KYCExpiry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())

  const [search, setSearch]     = useState('')
  const [fHorizon, setFHorizon] = useState(new Set<string>())
  const [fDocType, setFDocType] = useState(new Set<string>())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      p.set('horizon_days', '999')
      if (dateFrom) p.set('from', dateFrom)
      if (dateTo)   p.set('to', dateTo)
      const data = await apiFetch<KYCExpiry[]>(`/api/compliance/kyc-expiry?${p}`)
      setItems(Array.isArray(data) ? data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function handleKYCAction(cif: string, action: string) {
    try {
      await apiPost(`/api/compliance/kyc-expiry/${encodeURIComponent(cif)}/action`, { action })
      toast.success(action === 'remind' ? 'Reminder sent' : 'KYC marked as renewed')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Action failed')
    }
  }

  const uniqueDocTypes = useMemo(() => [...new Set(items.map(i => i.kyc_type).filter(Boolean))] as string[], [items])

  const filtered = useMemo(() => items.filter(r => {
    if (fDocType.size && !fDocType.has(r.kyc_type)) return false
    if (fHorizon.size) {
      const d = r.days_to_expiry
      const matches = [...fHorizon].some(h => {
        if (h === 'expired') return d < 0
        if (h === '30') return d >= 0 && d <= 30
        if (h === '60') return d >= 0 && d <= 60
        if (h === '90') return d >= 0 && d <= 90
        return false
      })
      if (!matches) return false
    }
    if (search) {
      const q = search.toLowerCase()
      if (![r.customer_name, r.kyc_type, r.cif].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [items, fHorizon, fDocType, search])

  const cols: TableCol<KYCExpiry>[] = [
    {
      key: 'customer_name', label: 'Customer',
      render: r => <NameCell name={r.customer_name} sub={r.cif} />,
    },
    {
      key: 'phone', label: 'Phone',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.phone}</span>,
    },
    {
      key: 'kyc_type', label: 'KYC Type',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.kyc_type}</span>,
    },
    {
      key: 'expiry_date', label: 'Expiry Date',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDate(r.expiry_date)}</span>,
    },
    {
      key: 'days_to_expiry', label: 'Days Left',
      render: r => <DaysLeft days={r.days_to_expiry} status={r.status} />,
    },
    {
      key: 'status', label: 'Status',
      render: r => <KYCStatusBadge status={r.status} />,
    },
    {
      key: '_actions', label: '', sortable: false, width: 64,
      render: r => (
        <ActionRow actions={[
          { icon: 'notifications', label: 'Send Reminder', onClick: () => handleKYCAction(r.cif, 'remind') },
          { icon: 'verified', label: 'Mark Renewed', onClick: () => handleKYCAction(r.cif, 'renew') },
        ]} />
      ),
    },
  ]

  return (
    <Page
      title="KYC Expiry Monitor"
      subtitle="Customers with KYC documents expiring within the selected horizon"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => { const h = [...fHorizon][0]; window.open('/api/compliance/kyc-expiry/export?horizon_days=' + (!h ? '999' : h === 'expired' ? '0' : h)) }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
            Export CSV
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="KYC Documents" badge={items.length} padding={false}>
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={[
            {
              key: 'horizon', label: 'Horizon',
              options: [
                { value: 'expired', label: 'Expired',  color: RED,   count: items.filter(r => r.days_to_expiry < 0).length },
                { value: '30',      label: '≤ 30 days', color: AMBER, count: items.filter(r => r.days_to_expiry >= 0 && r.days_to_expiry <= 30).length },
                { value: '60',      label: '≤ 60 days', color: AMBER, count: items.filter(r => r.days_to_expiry >= 0 && r.days_to_expiry <= 60).length },
                { value: '90',      label: '≤ 90 days', color: GREEN, count: items.filter(r => r.days_to_expiry >= 0 && r.days_to_expiry <= 90).length },
              ],
              selected: fHorizon, onChange: (next: Set<string>) => setFHorizon(next),
            },
            {
              key: 'doc_type', label: 'KYC Type',
              options: uniqueDocTypes.map(t => ({ value: t, count: items.filter(r => r.kyc_type === t).length })),
              selected: fDocType, onChange: (next: Set<string>) => setFDocType(next),
            },
          ]}
          onReset={() => { setSearch(''); setFHorizon(new Set()); setFDocType(new Set()) }}
          resultCount={filtered.length} totalCount={items.length}
          placeholder="Search by name or KYC type…"
        />
        <DataTable<KYCExpiry>
          cols={cols}
          rows={filtered}
          keyFn={r => r.id}
          emptyText="No KYC documents expiring within this horizon"
          skeletonRows={loading ? 5 : 0}
          pageSize={20}
        />
      </SectionCard>
    </Page>
  )
}
