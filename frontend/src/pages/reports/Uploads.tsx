import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, StatusBadge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrapList } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { BLUE, PURPLE, GREEN, RED, AMBER, TEXT, FW, SP, RADIUS } from '../../lib/design'

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

// One manual-upload source and how overdue it is, from app.v_pipeline_freshness
// (the same thresholds the alerts use, so this page and the alert can never
// disagree). Nothing showed this before: all three sources sat 45-47 days stale
// while this page looked perfectly normal, because it only listed what HAD been
// uploaded.
interface Overdue {
  source_key: string
  label: string
  owner: string | null
  state: string
  data_age_sec: number | null
  stale_after_sec: number | null
  last_upload_at: string | null
  last_upload_by: string | null
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
    description: 'Daily Interswitch CCS Report 620 files. Card transactions for reconciliation.',
    to: '/reports/uploads/interswitch', target: 'interswitch_txns', icon: 'sync_alt', accent: BLUE },
  { key: 'settlement', title: 'Interswitch Settlement',
    description: "Interswitch settlement reports into the reconciliation ledger (drop a whole day's folder).",
    to: '/reports/uploads/settlement', target: 'interswitch_transactions', icon: 'account_balance', accent: GREEN },
]

// Which importer fixes which source.
const SOURCE_TO_INGEST: Record<string, string> = {
  card_cycle: '/reports/uploads/card-cycle',
  ccs_eodtxn: '/reports/uploads/interswitch',
  interswitch_settlement: '/reports/uploads/settlement',
}

const OVERDUE_STATE: Record<string, { c: string; label: string }> = {
  stale: { c: RED, label: 'Overdue' },
  never: { c: RED, label: 'Never uploaded' },
  warn: { c: AMBER, label: 'Due' },
  ok: { c: GREEN, label: 'Up to date' },
}

function ageWords(sec: number | null): string {
  if (sec == null) return 'never'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 48 * 3600) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)} days ago`
}

function OverduePanel({ rows, onOpen }: { rows: Overdue[]; onOpen: (to: string) => void }) {
  if (rows.length === 0) return null
  const late = rows.filter(r => r.state === 'stale' || r.state === 'never' || r.state === 'warn')
  return (
    <SectionCard
      title="Upload Status"
      subtitle={late.length > 0
        ? `${late.length} of ${rows.length} datasets are overdue. The people who upload them are alerted by role`
        : 'Every manual dataset is within its expected window'}
      style={{ marginBottom: SP[5] }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        {rows.map(r => {
          const s = OVERDUE_STATE[r.state] ?? { c: 'var(--txt3)', label: r.state }
          const to = SOURCE_TO_INGEST[r.source_key]
          return (
            <div key={r.source_key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SP[3],
              flexWrap: 'wrap', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md,
              background: r.state === 'ok' ? 'var(--th-bg)' : `${s.c}0A`,
              border: `1px solid ${r.state === 'ok' ? 'var(--bdr)' : `${s.c}26`}`,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.c, flexShrink: 0 }} />
                  <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold }}>{r.label}</span>
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: s.c }}>{s.label}</span>
                </div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3 }}>
                  Newest data {ageWords(r.data_age_sec)}
                  {r.last_upload_at ? ` · last uploaded ${fmtDatetime(r.last_upload_at)}${r.last_upload_by ? ` by ${r.last_upload_by}` : ''}` : ' · no upload recorded yet'}
                  {r.owner ? ` · ${r.owner}` : ''}
                </div>
              </div>
              {to && (
                <button onClick={() => onOpen(to)} style={{
                  padding: '6px 12px', borderRadius: RADIUS.md, border: `1px solid ${s.c}44`,
                  background: 'transparent', color: s.c, fontSize: TEXT.sm, fontWeight: FW.semibold,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}>Upload now</button>
              )}
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

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
          Open Importer <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_forward</span>
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
  const [overdue, setOverdue] = useState<Overdue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      // The status panel must not take the page down with it.
      const [r, p] = await Promise.all([
        apiFetch('/api/uploads/audit?limit=200'),
        apiFetch('/api/uploads/pending').catch(() => null),
      ])
      setLedger(unwrapList<AuditRow>(r))
      setOverdue(unwrapList<Overdue>(p))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Page title="Data Management" subtitle="Central data ingestion & upload history" loading={loading && ledger.length === 0}>
      <ErrBanner error={error} onRetry={load} />

      <OverduePanel rows={overdue} onOpen={navigate} />

      <SectionCard title="Upload a Dataset" subtitle="Every workspace data ingest lives here. Pick a dataset to import">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: SP[4] }}>
          {INGESTS.map(ing => <IngestCard key={ing.key} ingest={ing} onOpen={navigate} />)}
        </div>
        <p style={{ margin: '14px 0 0', fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
          Merchant names arrive truncated and are merged back together —{' '}
          <a href="/reports/merchant-names" style={{ color: BLUE, fontWeight: FW.semibold }}>review those merges</a>.
          <br />
          End-of-Day is no longer uploaded. It is derived automatically from live data. Credit-card statement
          generation and document/email attachments are handled within their own modules and are not dataset uploads.
        </p>
      </SectionCard>

      <div style={{ height: SP[5] }} />

      <SectionCard title="Upload History" subtitle="Every ingest across modules" badge={ledger.length || undefined} padding={false}>
        <DataTable cols={LEDGER_COLS} rows={ledger} keyFn={(r, i) => r.id ?? i} loading={loading} emptyText="No uploads recorded yet" pageSize={25} />
      </SectionCard>
    </Page>
  )
}
