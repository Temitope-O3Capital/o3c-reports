import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Page, KpiCard, SectionCard, ErrBanner, Button, Spinner, EmptyState,
  StatusBadge, Badge, Tabs,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Activity {
  activity: string
  id: number | null
  started_at: string
  finished_at: string | null
  status: string
  detail: string
  records: number
  match_rate_pct: number | null
  exceptions: number
  actor: string
  error: string
  signed_off: boolean
}

interface ActivityResp {
  runs: Activity[]
  syncs: Activity[]
  imports: Activity[]
}

interface SyncStatus {
  configured: boolean
  last_run: {
    id?: number
    kind?: string
    status?: string
    started_at?: string
    finished_at?: string
    watermark?: string
    transactions?: number
    transfers?: number
    settlements?: number
    disputes?: number
    error?: string
  }
  snapshot: {
    transactions: number
    transfers: number
    settlements: number
    disputes: number
  }
}

// ── Chrome ────────────────────────────────────────────────────────────────────

const ACTIVITY_META: Record<string, { label: string; icon: string; color: string }> = {
  reconciliation:     { label: 'Reconciliation', icon: 'rule',        color: NAVY },
  paystack_sync:      { label: 'Paystack sync',  icon: 'sync',        color: '#2563EB' },
  interswitch_import: { label: 'EOD import',     icon: 'upload_file', color: '#7C3AED' },
}

const tdBase: React.CSSProperties = {
  padding: '10px 14px', fontSize: TEXT.base, color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
}
const thBase: React.CSSProperties = {
  padding: '10px 14px', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
  textAlign: 'left', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
}

function duration(a: string, b: string | null): string {
  if (!b) return '—'
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementRuns() {
  const [data, setData] = useState<ActivityResp | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'all' | 'reconciliation' | 'paystack_sync' | 'interswitch_import'>('all')
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [act, st] = await Promise.all([
        apiFetch<ActivityResp>('/api/recon/activity?limit=60'),
        apiFetch<SyncStatus>('/api/paystack/sync/status').catch(() => null),
      ])
      setData(act)
      setSync(st)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Paystack sync is now triggered from Admin → Sync & Workers; this page shows status only.
  const _unusedTriggerSync = async () => {
    try {
      await apiPost('/api/paystack/sync', {})
      setTimeout(load, 2500)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sync failed to start')
    }
  }

  const rows = useMemo(() => {
    if (!data) return []
    const all = [...(data.runs ?? []), ...(data.syncs ?? []), ...(data.imports ?? [])]
    const filtered = tab === 'all' ? all : all.filter(a => a.activity === tab)
    return filtered.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
  }, [data, tab])

  const lastRecon = data?.runs?.[0]
  const lastSync = data?.syncs?.[0]
  const lastImport = data?.imports?.[0]

  return (
    <Page
      title="Runs & Imports"
      subtitle="Every reconciliation, sync and file import — who ran it, when, and what it produced"
      actions={
        <Button variant="secondary" icon="refresh" onClick={load}>Refresh</Button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[6] }}>
        <KpiCard
          label="Last reconciliation"
          value={lastRecon ? `${Number(lastRecon.match_rate_pct ?? 0).toFixed(1)}%` : '—'}
          sub={lastRecon ? `${fmtNum(lastRecon.exceptions)} exceptions · ${fmtDatetime(lastRecon.started_at)}` : 'Never run'}
          icon="rule" accent={NAVY} loading={loading && !data}
        />
        <KpiCard
          label="Last Paystack sync"
          value={lastSync ? lastSync.status : '—'}
          sub={lastSync ? `${fmtNum(lastSync.records)} records · ${fmtDatetime(lastSync.started_at)}` : 'Never run'}
          icon="sync" accent={lastSync?.status === 'ok' ? GREEN : AMBER} loading={loading && !data}
        />
        <KpiCard
          label="Mirrored records"
          value={fmtNum(
            Number(sync?.snapshot?.transactions ?? 0) + Number(sync?.snapshot?.transfers ?? 0) +
            Number(sync?.snapshot?.settlements ?? 0) + Number(sync?.snapshot?.disputes ?? 0)
          )}
          sub={sync ? `${fmtNum(sync.snapshot.transfers)} transfers · ${fmtNum(sync.snapshot.transactions)} fundings` : '—'}
          icon="database" accent={NAVY} loading={loading && !sync}
        />
        <KpiCard
          label="Last EOD import"
          value={lastImport ? fmtNum(lastImport.records) : '—'}
          sub={lastImport ? fmtDatetime(lastImport.started_at) : 'No imports'}
          icon="upload_file" accent={NAVY} loading={loading && !data}
        />
      </div>

      {sync && !sync.configured && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[4],
          padding: '10px 12px', borderRadius: RADIUS.md,
          background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.18)',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: AMBER }}>key_off</span>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>
            Paystack is not configured — set <code>PAYSTACK_SECRET_KEY</code>. The mirror will not refresh.
          </span>
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'all',                label: 'All activity' },
          { key: 'reconciliation',     label: 'Reconciliations' },
          { key: 'paystack_sync',      label: 'Paystack syncs' },
          { key: 'interswitch_import', label: 'EOD imports' },
        ]}
        active={tab}
        onChange={k => setTab(k as typeof tab)}
      />

      <SectionCard title="Activity" subtitle="Newest first" padding={false} style={{ marginTop: SP[4] }}>
        {loading && !data ? (
          <div style={{ padding: SP[5] }}><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon="history" title="Nothing here yet"
            description="Reconciliations, syncs and imports will appear as they run." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  <th style={thBase}>Activity</th>
                  <th style={thBase}>Detail</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Records</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Matched</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Exceptions</th>
                  <th style={thBase}>Status</th>
                  <th style={thBase}>By</th>
                  <th style={thBase}>Started</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Took</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a, i) => {
                  const meta = ACTIVITY_META[a.activity] ?? { label: a.activity, icon: 'circle', color: NAVY }
                  return (
                    <tr key={`${a.activity}-${a.id ?? i}-${a.started_at}`} style={{ background: 'var(--card)' }}>
                      <td style={tdBase}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <span className="material-symbols-rounded"
                            style={{ fontSize: TEXT.md, color: meta.color }}>{meta.icon}</span>
                          <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium }}>{meta.label}</span>
                          {a.id != null && (
                            <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>#{a.id}</span>
                          )}
                        </span>
                      </td>
                      <td style={tdBase}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.detail}</span></td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(a.records)}</td>
                      <td style={{ ...tdBase, textAlign: 'right' }}>
                        {a.match_rate_pct == null
                          ? <span style={{ color: 'var(--txt3)' }}>—</span>
                          : <span style={{ ...NUM, fontWeight: FW.semibold }}>{Number(a.match_rate_pct).toFixed(1)}%</span>}
                      </td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>
                        {a.activity === 'reconciliation' ? fmtNum(a.exceptions) : '—'}
                      </td>
                      <td style={tdBase}>
                        <StatusBadge status={a.status} size="sm" />
                        {a.signed_off && <Badge variant="success" style={{ marginLeft: 6 }}>signed</Badge>}
                        {a.error && (
                          <div style={{ fontSize: TEXT.xs, color: RED, marginTop: 2, maxWidth: 260 }}>{a.error}</div>
                        )}
                      </td>
                      <td style={tdBase}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.actor}</span></td>
                      <td style={tdBase}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(a.started_at)}</span></td>
                      <td style={{ ...tdBase, textAlign: 'right' }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                          {duration(a.started_at, a.finished_at)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
