import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  ErrBanner,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, RED, GREEN, AMBER } from '../../lib/design'

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

function StatusBadge({ status }: { status: string }) {
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
  const [filtered, setFiltered] = useState<KYCExpiry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [horizon, setHorizon] = useState('30')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const qs = horizon === 'expired' ? 'horizon_days=0' : `horizon_days=${horizon}`
      const data = await apiFetch<KYCExpiry[]>(`/api/compliance/kyc-expiry?${qs}`)
      setItems(Array.isArray(data) ? data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [horizon])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const q = search.trim().toLowerCase()
    if (!q) { setFiltered(items); return }
    setFiltered(items.filter(r =>
      r.customer_name.toLowerCase().includes(q) ||
      r.cif.toLowerCase().includes(q)
    ))
  }, [items, search])

  const cols: TableCol<KYCExpiry>[] = [
    {
      key: 'customer_name', label: 'Customer Name',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.customer_name}</span>,
    },
    {
      key: 'cif', label: 'CIF',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'monospace' }}>{r.cif}</span>,
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
      render: r => <StatusBadge status={r.status} />,
    },
  ]

  return (
    <Page
      title="KYC Expiry Monitor"
      subtitle="Customers with KYC documents expiring within the selected horizon"
      actions={
        <button
          onClick={() => window.open('/api/compliance/kyc-expiry/export?horizon_days=' + (horizon === 'expired' ? '0' : horizon))}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
          Export CSV
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setHorizon('30'); setSearch('') }}>
        <select value={horizon} onChange={e => setHorizon(e.target.value)} style={filterInputStyle}>
          <option value="30">30 days</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
          <option value="expired">Expired</option>
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or CIF…"
          style={filterInputStyle}
        />
      </FilterBar>

      <SectionCard title="KYC Documents" badge={filtered.length} padding={false}>
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
