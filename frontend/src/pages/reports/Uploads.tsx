import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, StatusBadge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrapList } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { BLUE, PURPLE, GREEN, TEXT, FW, SP, RADIUS } from '../../lib/design'

// Central data-ingestion hub — the single home for every dataset upload in the
// workspace. Each ingest keeps its own dedicated importer (with tailored preview
// and result panels); this page launches them and shows the unified
// upload_audit_log ledger across all modules.
//
// Deliberately NOT here: End of Day (now a derived report, no upload) and
// credit-card statement generation (a Statements-module workflow that also
// builds from the DB with no file — it is not a dataset ingest).

interface AuditRow {
  id: number
  report_type: string
  file_names: any
  cycle_label: string
  row_counts: any
  status: string
  error_msg: string
  uploaded_at: string
  uploaded_by_name: string
}

interface Ingest {
  key: string
  title: string
  description: string
  to: string
  target: string
  icon: string
  accent: string
}

const INGESTS: Ingest[] = [
  { key: 'card_cycle', title: 'Card Cycle Data',
    description: 'Monthly Udara card billing-cycle reports (balances, charges, interest, locations).',
    to: '/reports/uploads/card-cycle', target: 'card_cycle_data', icon: 'credit_card', accent: PURPLE },
  { key: 'interswitch', title: 'Interswitch EODTXN',
    description: 'Daily Interswitch CCS Report 620 files — card transactions for reconciliation.',
    to: '/reports/uploads/interswitch', target: 'interswitch_txns', icon: 'sync_alt', accent: BLUE },
  { key: 'settlement', title: 'Interswitch Settlement',
    description: "Interswitch settlement reports into the reconciliation ledger (drop a whole day's folder).",
    to: '/reports/uploads/settlement', target: 'interswitch_transactions', icon: 'account_balance', accent: GREEN },
]

function IngestCard({ ingest, onOpen }: { ingest: Ingest; onOpen: (to: string) => void }) {
  return (
    <button onClick={() => onOpen(ingest.to)} style={{
      textAlign: 'left', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: 16,
      background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: 10, cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 22, color: ingest.accent }}>{ingest.icon}</span>
        <span style={{ fontSize: TEXT.md, fontWeight: FW.bold }}>{ingest.title}</span>
      </div>
      <p style={{ margin: 0, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5, flex: 1 }}>{ingest.description}</p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>→ {ingest.target}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.sm, fontWeight: FW.semibold, color: ingest.accent }}>
          Open importer <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_forward</span>
        </span>
      </div>
    </button>
  )
}

function renderCell(v: any): string {
  if (v == null) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const LEDGER_COLS: TableCol<AuditRow>[] = [
  { key: 'uploaded_at', label: 'When', width: 150, render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.uploaded_at)}</span> },
  { key: 'report_type', label: 'Dataset', render: r => <span style={{ fontWeight: FW.medium }}>{r.report_type || '—'}</span> },
  { key: 'file_names', label: 'File(s)', render: r => <span style={{ fontSize: TEXT.sm, maxWidth: 280, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{renderCell(r.file_names)}</span> },
  { key: 'cycle_label', label: 'Cycle', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.cycle_label || '—'}</span> },
  { key: 'row_counts', label: 'Rows', align: 'right', render: r => <span style={{ fontSize: TEXT.sm }}>{renderCell(r.row_counts)}</span> },
  { key: 'uploaded_by_name', label: 'By', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.uploaded_by_name || '—'}</span> },
  { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status || 'unknown'} /> },
]

export default function ReportsUploads() {
  const navigate = useNavigate()
  const [ledger, setLedger] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch('/api/uploads/audit?limit=200')
      setLedger(unwrapList<AuditRow>(r))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Page title="Data Management" subtitle="Central data ingestion & upload history" loading={loading && ledger.length === 0}>
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Upload a dataset" subtitle="Every workspace data ingest lives here — pick a dataset to import">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: SP[4] }}>
          {INGESTS.map(ing => <IngestCard key={ing.key} ingest={ing} onOpen={navigate} />)}
        </div>
        <p style={{ margin: '14px 0 0', fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
          End-of-Day is no longer uploaded — it is derived automatically from live data. Credit-card statement
          generation and document/email attachments are handled within their own modules and are not dataset uploads.
        </p>
      </SectionCard>

      <div style={{ height: SP[5] }} />

      <SectionCard title="Upload history" subtitle="Every ingest across modules" badge={ledger.length || undefined} padding={false}>
        <DataTable cols={LEDGER_COLS} rows={ledger} keyFn={(r, i) => r.id ?? i} loading={loading} emptyText="No uploads recorded yet" pageSize={25} />
      </SectionCard>
    </Page>
  )
}
