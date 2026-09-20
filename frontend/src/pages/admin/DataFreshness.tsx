import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, BLUE, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// Data Freshness — "is each source actually still sending us anything?"
//
// This page exists because the Sync & Workers hub answers a different question.
// A worker reports ok when its last RUN succeeded, and a run over an empty folder
// succeeds — so when the CCS export died on 2026-09-08 at 08:38, every signal
// stayed green for six days: feed_runs ok with rows_inserted=0, the task exit code
// 0 every 15 minutes, and ~5,700 consecutive "0 new files" log lines nobody read.
//
// Backed by app.v_pipeline_freshness (migration 238), which compares the age of
// the DATA — and its volume — against a per-source expectation.

interface Source {
  source_key: string
  label: string
  category: string
  owner: string | null
  enabled: boolean
  notes: string | null
  state: string
  run_state: string
  last_data_at: string | null
  last_ok_at: string | null
  data_age_sec: number | null
  // The age the verdict tested. Differs from data_age_sec only where whole
  // weekend days were removed (migration 259), so an "ok" verdict next to a
  // two-day raw age explains itself instead of looking like a bug.
  effective_data_age_sec: number | null
  business_days_only: boolean | null
  run_age_sec: number | null
  warn_after_sec: number | null
  stale_after_sec: number | null
  rows_recent: number | null
  rows_baseline: number | null
  volume_ratio: number | null
  // Roles alerted when this source breaks (migration 256). Admins are always
  // copied, so an empty list means "admins only", never "nobody".
  notify_roles: string | null
  // How many active people those roles actually resolve to. A role nobody holds
  // notifies nobody — the silence this whole page exists to prevent.
  recipient_count: number | null
}

interface Alert {
  source_key: string
  label: string | null
  level: string
  first_seen_at: string
  last_seen_at: string
  last_notified_at: string | null
  notify_count: number
  resolved_at: string | null
  detail: string | null
}

const STATE: Record<string, { c: string; label: string; hint: string }> = {
  stale:    { c: RED,       label: 'No Data',   hint: 'Past its stale threshold — treat as an outage' },
  never:    { c: RED,       label: 'Never',     hint: 'This source has never delivered anything' },
  taper:    { c: '#EA580C', label: 'Collapsed', hint: 'Still arriving, but volume has fallen off a cliff' },
  warn:     { c: AMBER,     label: 'Delayed',   hint: 'Later than expected, not yet an outage' },
  ok:       { c: GREEN,     label: 'Fresh',     hint: 'Delivering as expected' },
  disabled: { c: '#94A3B8', label: 'Not Watched', hint: 'Deliberately excluded — see the note' },
}
const sInfo = (s: string) => STATE[s] ?? STATE.disabled

const RUN_STATE: Record<string, string> = {
  running: 'Job Running', run_dead: 'Job Stopped', never_ok: 'Job Never Succeeded',
  unknown: 'No Job (Manual)', 'n/a': 'No Schedule',
}

// Seconds → how an operator reads it. Mirrors pipelineAgeWords in the Go monitor
// so the page and the alert email never describe the same gap differently.
function ageWords(sec: number | null): string {
  if (sec == null) return '—'
  if (sec <= 0) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 48 * 3600) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}
function durWords(sec: number | null): string {
  if (sec == null) return '—'
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 48 * 3600) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

const CATEGORY_LABEL: Record<string, string> = {
  file_feed: 'File Drop', api_poll: 'Polled API', manual_upload: 'Manual Upload',
  webhook: 'Webhook', mail: 'Mail',
}

function StateChip({ state }: { state: string }) {
  const i = sInfo(state)
  return (
    <span title={i.hint} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px',
      borderRadius: RADIUS['2xl'], background: `${i.c}14`, border: `1px solid ${i.c}33`,
      fontSize: TEXT.xs, fontWeight: FW.bold, color: i.c, fontFamily: INTER, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: i.c }} />
      {i.label}
    </span>
  )
}

export default function DataFreshness() {
  const [sources, setSources] = useState<Source[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [h, a] = await Promise.all([
        apiFetch<any>('/api/admin/pipeline'),
        apiFetch<any>('/api/admin/pipeline/alerts').catch(() => null),
      ])
      const d = h?.data ?? h ?? {}
      setSources(d.sources ?? [])
      setAlerts((a?.data ?? a ?? []) as Alert[])
    } catch (e: any) {
      setError(e?.message ?? 'Could not load pipeline freshness')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const watched = sources.filter(s => s.enabled)
  const broken = watched.filter(s => ['stale', 'never', 'taper'].includes(s.state))
  const delayed = watched.filter(s => s.state === 'warn')
  const fresh = watched.filter(s => s.state === 'ok')
  const jobsDead = watched.filter(s => ['run_dead', 'never_ok'].includes(s.run_state))
  const open = alerts.filter(a => !a.resolved_at)

  const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
    <th style={{
      padding: '9px 12px', textAlign: right ? 'right' : 'left', fontSize: TEXT.xs,
      fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER,
      textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap',
    }}>{children}</th>
  )

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Data Freshness"
      subtitle="Is each source still sending data? Run status answers a different question — a job over an empty folder succeeds."
      loading={loading && sources.length === 0}
      skeletonKpis={4}
      actions={
        <button onClick={load} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md,
          border: '1px solid var(--card-bdr)', background: 'var(--card)', color: NAVY,
          fontSize: TEXT.sm, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>refresh</span>Refresh
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {loading && sources.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : (
        <>
          {broken.length > 0 && (
            <div style={{
              padding: `${SP[3]} ${SP[4]}`, marginBottom: SP[4], borderRadius: RADIUS.lg,
              background: `${RED}0F`, border: `1px solid ${RED}33`, fontSize: TEXT.sm,
              color: 'var(--txt)', fontFamily: INTER, lineHeight: 1.55,
            }}>
              <strong>{broken.length} source{broken.length === 1 ? '' : 's'} not delivering.</strong>{' '}
              {broken.map(s => `${s.label} (${ageWords(s.data_age_sec)})`).join(' · ')}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: SP[3], marginBottom: SP[5] }}>
            <KpiCard label="Not Delivering" value={fmtNum(broken.length)} sub="stale, collapsed or never" icon="error" accent={RED} />
            <KpiCard label="Delayed" value={fmtNum(delayed.length)} sub="later than expected" icon="schedule" accent={AMBER} />
            <KpiCard label="Fresh" value={fmtNum(fresh.length)} sub={`of ${watched.length} watched`} icon="check_circle" accent={GREEN} />
            <KpiCard label="Jobs Stopped" value={fmtNum(jobsDead.length)} sub="ingest not running" icon="motion_photos_off" accent={BLUE} />
          </div>

          <SectionCard title="Sources" subtitle="Data age is measured from ingest timestamps — never from dates the source supplies, which run into the future">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    <Th>Source</Th><Th>Type</Th><Th>State</Th><Th right>Newest Data</Th>
                    <Th right>Alert After</Th><Th>Job</Th><Th right>Volume vs Normal</Th><Th>Owner</Th><Th>Alerts</Th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map(s => (
                    <tr key={s.source_key} style={{ borderBottom: '1px solid var(--bdr)', opacity: s.enabled ? 1 : 0.55 }}>
                      <td style={{ padding: '11px 12px', fontSize: TEXT.sm, fontFamily: INTER }}>
                        <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{s.label}</div>
                        {s.notes && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2, maxWidth: 460, lineHeight: 1.45 }}>{s.notes}</div>}
                      </td>
                      <td style={{ padding: '11px 12px', fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, whiteSpace: 'nowrap' }}>
                        {CATEGORY_LABEL[s.category] ?? s.category}
                      </td>
                      <td style={{ padding: '11px 12px' }}><StateChip state={s.state} /></td>
                      <td style={{ padding: '11px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'nowrap' }}
                        title={s.last_data_at ? fmtDatetime(s.last_data_at) : 'never'}>
                        {ageWords(s.data_age_sec)}
                        {s.business_days_only && s.effective_data_age_sec != null
                          && s.data_age_sec != null && s.effective_data_age_sec < s.data_age_sec && (
                          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}
                            title="This source only produces data on working days, so whole weekend days are not counted against it.">
                            {ageWords(s.effective_data_age_sec)} excl. weekend
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '11px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
                        {durWords(s.stale_after_sec)}
                      </td>
                      <td style={{ padding: '11px 12px', fontSize: TEXT.xs, fontFamily: INTER, whiteSpace: 'nowrap',
                        color: ['run_dead', 'never_ok'].includes(s.run_state) ? RED : 'var(--txt2)',
                        fontWeight: ['run_dead', 'never_ok'].includes(s.run_state) ? FW.bold : FW.normal }}>
                        {RUN_STATE[s.run_state] ?? s.run_state}
                      </td>
                      <td style={{ padding: '11px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, whiteSpace: 'nowrap',
                        color: s.volume_ratio != null && s.volume_ratio < 0.25 ? RED : 'var(--txt)' }}
                        title={s.rows_baseline != null ? `${fmtNum(s.rows_recent ?? 0)} rows in 24h vs median ${fmtNum(s.rows_baseline)}` : 'no volume baseline for this source'}>
                        {s.volume_ratio != null ? `${Math.round(s.volume_ratio * 100)}%` : '—'}
                      </td>
                      <td style={{ padding: '11px 12px', fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{s.owner ?? '—'}</td>
                      <td style={{ padding: '11px 12px', fontSize: TEXT.xs, fontFamily: INTER, color: 'var(--txt2)' }}
                        title="Roles notified when this source breaks. Admins are always copied, so this can never be nobody.">
                        <div>{s.notify_roles ? s.notify_roles.split(',').map(r => r.replace(/_/g, ' ')).join(', ') : 'admins only'}</div>
                        <div style={{ marginTop: 2, color: (s.recipient_count ?? 0) > 0 ? 'var(--txt3)' : RED, fontWeight: (s.recipient_count ?? 0) > 0 ? FW.normal : FW.bold }}>
                          {(s.recipient_count ?? 0) > 0
                            ? `${s.recipient_count} ${s.recipient_count === 1 ? 'person' : 'people'}`
                            : 'reaches nobody'}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <SectionCard title="Alert History" subtitle="Open alerts first. Each one notifies the source's own team once (see Alerts), then re-notifies daily while it stays broken"
            style={{ marginTop: SP[4] }}>
            {alerts.length === 0 ? (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, padding: `${SP[2]} 0` }}>
                No alerts recorded yet. The monitor runs every 15 minutes.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                {alerts.slice(0, 40).map(a => {
                  const isOpen = !a.resolved_at
                  const c = isOpen ? (a.level === 'warn' ? AMBER : RED) : GREEN
                  return (
                    <div key={`${a.source_key}-${a.level}`} style={{
                      display: 'flex', gap: SP[3], alignItems: 'flex-start', padding: `${SP[2]} ${SP[3]}`,
                      borderRadius: RADIUS.md, background: isOpen ? `${c}0A` : 'var(--th-bg)',
                      border: `1px solid ${isOpen ? `${c}26` : 'var(--bdr)'}`,
                    }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, marginTop: 6, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>
                          {a.label ?? a.source_key} · {a.level}
                          {!isOpen && <span style={{ color: GREEN, fontWeight: FW.normal }}> — recovered</span>}
                        </div>
                        {a.detail && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2, lineHeight: 1.5 }}>{a.detail}</div>}
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3, fontFamily: INTER }}>
                          first seen {fmtDatetime(a.first_seen_at)} · notified {a.notify_count}×
                          {a.resolved_at ? ` · resolved ${fmtDatetime(a.resolved_at)}` : ''}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </Page>
  )
}
