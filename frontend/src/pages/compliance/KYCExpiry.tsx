import { useLiveData } from "../../hooks/useRealtime"
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
  cif_number: string
  customer_name: string
  kyc_expiry_date: string
  days_until_expiry: number
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

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
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
  useLiveData(() => load(true), { topics: ['compliance'] })

  async function handleKYCAction(cif: string, action: string) {
    try {
      await apiPost(`/api/compliance/kyc-expiry/${encodeURIComponent(cif)}/action`, { action })
      toast.success(action === 'remind' ? 'Reminder sent' : 'KYC marked as renewed')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Action failed')
    }
  }

  const filtered = useMemo(() => items.filter(r => {
    if (fHorizon.size) {
      const d = r.days_until_expiry
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
      if (![r.customer_name, r.cif_number].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [items, fHorizon, search])

  const cols: TableCol<KYCExpiry>[] = [
    {
      key: 'customer_name', label: 'Customer',
      render: r => <NameCell name={r.customer_name} sub={r.cif_number} />,
    },
    {
      key: 'kyc_expiry_date', label: 'Expiry Date',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{fmtDate(r.kyc_expiry_date)}</span>,
    },
    {
      key: 'days_until_expiry', label: 'Days Left',
      render: r => <DaysLeft days={r.days_until_expiry} status={r.status} />,
    },
    {
      key: 'status', label: 'Status',
      render: r => <KYCStatusBadge status={r.status} />,
    },
    {
      key: '_actions', label: '', sortable: false, width: 64,
      render: r => (
        <ActionRow actions={[
          { icon: 'notifications', label: 'Send Reminder', onClick: () => handleKYCAction(r.cif_number, 'remind') },
          { icon: 'verified', label: 'Mark Renewed', onClick: () => handleKYCAction(r.cif_number, 'renew') },
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
                { value: 'expired', label: 'Expired',  color: RED,   count: items.filter(r => r.days_until_expiry < 0).length },
                { value: '30',      label: '≤ 30 days', color: AMBER, count: items.filter(r => r.days_until_expiry >= 0 && r.days_until_expiry <= 30).length },
                { value: '60',      label: '≤ 60 days', color: AMBER, count: items.filter(r => r.days_until_expiry >= 0 && r.days_until_expiry <= 60).length },
                { value: '90',      label: '≤ 90 days', color: GREEN, count: items.filter(r => r.days_until_expiry >= 0 && r.days_until_expiry <= 90).length },
              ],
              selected: fHorizon, onChange: (next: Set<string>) => setFHorizon(next),
            },
          ]}
          onReset={() => { setSearch(''); setFHorizon(new Set()) }}
          resultCount={filtered.length} totalCount={items.length}
          placeholder="Search by name or KYC type…"
        />
        <DataTable<KYCExpiry>
          cols={cols}
          rows={filtered}
          keyFn={r => r.cif_number}
          emptyText="No KYC documents expiring within this horizon"
          skeletonRows={loading ? 5 : 0}
          pageSize={20}
        />
      </SectionCard>
    </Page>
  )
}
