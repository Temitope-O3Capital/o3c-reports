import { useState } from 'react'
import { fmtDate } from '../lib/fmt'
import { Page, SectionCard, DataTable, ColDef, KpiCard, StatusBadge, NAVY, RED, AMBER } from '../components/UI'

interface WatchEntry {
  id: number
  cif: string
  name: string
  flag_reason: string
  flagged_by: string
  flagged_at: string
  status: 'active' | 'resolved' | 'escalated'
  risk_level: 'low' | 'medium' | 'high'
  notes: string
}

const MOCK_ENTRIES: WatchEntry[] = [
  { id: 1, cif: 'CIF-00842', name: 'Adebayo Okafor',  flag_reason: 'Unusual spending pattern',   flagged_by: 'Risk System', flagged_at: '2026-06-10', status: 'active',   risk_level: 'high',   notes: 'Multiple large transactions in 24h' },
  { id: 2, cif: 'CIF-01204', name: 'Chioma Eze',      flag_reason: 'Delinquency > 90 days',      flagged_by: 'Collections', flagged_at: '2026-06-08', status: 'active',   risk_level: 'high',   notes: 'Referred to legal' },
  { id: 3, cif: 'CIF-00391', name: 'Emeka Nwosu',     flag_reason: 'BVN mismatch',               flagged_by: 'KYC Team',    flagged_at: '2026-06-05', status: 'escalated', risk_level: 'medium', notes: 'Awaiting NIN verification' },
  { id: 4, cif: 'CIF-02841', name: 'Fatima Aliyu',    flag_reason: 'Suspicious top-up activity', flagged_by: 'Fraud Unit',  flagged_at: '2026-06-01', status: 'active',   risk_level: 'medium', notes: '5 top-ups from different accounts' },
  { id: 5, cif: 'CIF-00124', name: 'David Mensah',    flag_reason: 'Chargebacks filed',          flagged_by: 'Operations',  flagged_at: '2026-05-28', status: 'resolved', risk_level: 'low',   notes: 'Resolved after merchant dispute' },
]

const RISK_STYLE: Record<string, { bg: string; color: string }> = {
  high:   { bg: 'rgba(220,38,38,0.08)',   color: '#DC2626' },
  medium: { bg: 'rgba(245,158,11,0.1)',   color: '#D97706' },
  low:    { bg: 'rgba(5,150,105,0.08)',   color: '#059669' },
}

export default function Watch() {
  const [entries] = useState<WatchEntry[]>(MOCK_ENTRIES)
  const [statusFilter, setStatusFilter] = useState('all')
  const [riskFilter, setRiskFilter] = useState('all')
  const [search, setSearch] = useState('')

  const filtered = entries.filter(e => {
    if (statusFilter !== 'all' && e.status !== statusFilter) return false
    if (riskFilter !== 'all' && e.risk_level !== riskFilter) return false
    if (search && !e.name.toLowerCase().includes(search.toLowerCase()) && !e.cif.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const high     = entries.filter(e => e.risk_level === 'high' && e.status !== 'resolved').length
  const medium   = entries.filter(e => e.risk_level === 'medium' && e.status !== 'resolved').length
  const active   = entries.filter(e => e.status === 'active').length
  const resolved = entries.filter(e => e.status === 'resolved').length

  const cols: ColDef<WatchEntry>[] = [
    { key: 'cif',         label: 'CIF',        sortable: false },
    { key: 'name',        label: 'Customer' },
    { key: 'risk_level',  label: 'Risk',       render: r => {
        const s = RISK_STYLE[r.risk_level] ?? RISK_STYLE.low
        return (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded uppercase"
            style={{ background: s.bg, color: s.color }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
            {r.risk_level}
          </span>
        )
      }},
    { key: 'flag_reason', label: 'Reason' },
    { key: 'status',      label: 'Status',     render: r => <StatusBadge status={r.status} /> },
    { key: 'flagged_by',  label: 'Flagged By' },
    { key: 'flagged_at',  label: 'Flagged',    render: r => fmtDate(r.flagged_at) },
    { key: 'notes',       label: 'Notes',      render: r => (
        <span className="text-[12px] text-slate-500 max-w-[200px] truncate block" title={r.notes}>{r.notes}</span>
      )},
  ]

  return (
    <Page title="Watch List" subtitle="Flagged accounts requiring monitoring"
      actions={
        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="material-symbols-rounded absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-slate-400">search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search CIF or name…"
              className="pl-8 pr-3 py-1.5 rounded-lg border text-[12px] outline-none w-44"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
          </div>
          <select value={riskFilter} onChange={e => setRiskFilter(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            <option value="all">All Risk</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="escalated">Escalated</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      }>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard label="High Risk"  value={String(high)}     icon="emergency"     accent={RED}   />
        <KpiCard label="Medium Risk" value={String(medium)}  icon="warning"       accent={AMBER} />
        <KpiCard label="Active"     value={String(active)}   icon="flag"          accent={NAVY}  />
        <KpiCard label="Resolved"   value={String(resolved)} icon="check_circle"  accent="#059669" />
      </div>

      <SectionCard title="Flagged Accounts" badge={filtered.length}>
        <DataTable cols={cols} rows={filtered} emptyMsg="No entries match your filters" emptyIcon="flag_circle" />
      </SectionCard>
    </Page>
  )
}
