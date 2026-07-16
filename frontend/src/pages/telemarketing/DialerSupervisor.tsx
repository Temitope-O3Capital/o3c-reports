import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, RED, GREEN, AMBER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LiveCampaign {
  id: number
  name: string
  status: string
  dial_ratio: number
  agents_ready: number
  agents_on_call: number
  calls_in_flight: number
  queue_pending: number
}

interface CampaignStats {
  queue: Array<{ status: string; cnt: number }>
  calls: Array<{ answered: number; abandoned: number; total: number; avg_duration_sec: number }>
  sessions: Array<{ status: string; cnt: number }>
  abandon_pct: number
  cbn_limit_pct: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function n(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0)
}

// ── Gauge ─────────────────────────────────────────────────────────────────────

function AbanGauge({ pct, limit }: { pct: number; limit: number }) {
  const ratio = Math.min(pct / limit, 1)
  const colour = ratio >= 0.9 ? RED : ratio >= 0.6 ? AMBER : GREEN
  const barW = Math.round(ratio * 100)

  return (
    <div style={{ flex: 1, minWidth: 200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, marginBottom: 5 }}>
        <span style={{ color: 'var(--txt2)', fontWeight: FW.semibold }}>Abandonment Rate</span>
        <span style={{ fontWeight: FW.bold, color: colour }}>{pct}%</span>
      </div>
      <div style={{ height: 10, borderRadius: RADIUS.sm, background: 'var(--th-bg)', overflow: 'hidden', border: '1px solid var(--bdr)' }}>
        <div style={{ width: `${barW}%`, height: '100%', background: colour, borderRadius: RADIUS.sm, transition: 'width .4s' }} />
      </div>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[1] }}>CBN cap: {limit}%</div>
    </div>
  )
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function Tile({ label, value, colour, icon }: { label: string; value: string | number; colour?: string; icon?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 100, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {icon && <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: colour ?? NAVY }}>{icon}</span>}
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)' }}>{label}</span>
      </div>
      <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: colour ?? 'var(--txt)', lineHeight: 1 }}>{value}</div>
    </div>
  )
}

// ── Campaign Card ─────────────────────────────────────────────────────────────

function CampaignCard({
  camp, stats, onAction,
}: {
  camp: LiveCampaign
  stats: CampaignStats | null
  onAction: (id: number, action: 'pause' | 'stop' | 'start') => void
}) {
  const answered = n(stats?.calls[0]?.answered)
  const total    = n(stats?.calls[0]?.total)
  const connRate = total > 0 ? Math.round((answered / total) * 100) : 0
  const abanPct  = stats?.abandon_pct ?? 0
  const abanColour = abanPct >= 2.7 ? RED : abanPct >= 1.5 ? AMBER : GREEN
  const avgDur = total > 0 ? Math.round(n(stats?.calls[0]?.avg_duration_sec)) : 0
  const mins = Math.floor(avgDur / 60)
  const secs = avgDur % 60

  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: SP[5], background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: SP[4], flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{camp.name}</div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', marginTop: 2 }}>Dial ratio: {camp.dial_ratio}×</div>
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          {camp.status === 'active' && (
            <>
              <button onClick={() => onAction(camp.id, 'pause')}
                style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: `1.5px solid ${AMBER}40`, background: `${AMBER}10`, color: AMBER, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
                Pause
              </button>
              <button onClick={() => onAction(camp.id, 'stop')}
                style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: `1.5px solid ${RED}40`, background: `${RED}10`, color: RED, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
                Stop
              </button>
            </>
          )}
          {(camp.status === 'paused' || camp.status === 'draft') && (
            <button onClick={() => onAction(camp.id, 'start')}
              style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: `1.5px solid ${GREEN}40`, background: `${GREEN}10`, color: GREEN, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
              Resume
            </button>
          )}
        </div>
      </div>

      {/* Agent + queue row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: SP[4], flexWrap: 'wrap' }}>
        <Tile label="Ready Agents"  value={camp.agents_ready}    colour={GREEN}  icon="person" />
        <Tile label="On Call"       value={camp.agents_on_call}  colour={AMBER}  icon="call" />
        <Tile label="In Flight"     value={camp.calls_in_flight} colour={NAVY}   icon="phone_forwarded" />
        <Tile label="Queue Pending" value={camp.queue_pending}                   icon="queue" />
      </div>

      {/* Stats row */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: SP[4] }}>
          <Tile label="Calls Total"   value={total} />
          <Tile label="Answered"      value={answered} colour={GREEN} />
          <Tile label="Connect Rate"  value={`${connRate}%`} colour={connRate >= 50 ? GREEN : AMBER} />
          <Tile label="Avg Duration"  value={`${mins}:${secs.toString().padStart(2,'0')}`} />
        </div>
      )}

      {/* Abandonment gauge */}
      <div style={{ display: 'flex', gap: SP[4], alignItems: 'center' }}>
        <AbanGauge pct={abanPct} limit={3} />
        <div style={{ fontSize: TEXT.sm, color: abanColour, fontWeight: FW.bold, flexShrink: 0 }}>
          {abanPct >= 2.7 ? '⚠ Near CBN limit' : abanPct >= 1.5 ? 'Monitor closely' : 'Within limit'}
        </div>
      </div>
    </div>
  )
}

// ── Recent calls feed ─────────────────────────────────────────────────────────

interface RecentCall {
  id: number
  phone: string
  call_state: string
  started_at: string
  duration_sec: number
  is_abandoned: boolean
  agent_name: string | null
  campaign_id: number
}

function RecentCallRow({ call }: { call: RecentCall }) {
  const colour = call.is_abandoned ? RED : call.call_state === 'answered' ? GREEN : 'var(--txt3)'
  const icon   = call.is_abandoned ? 'call_missed' : call.call_state === 'answered' ? 'call' : 'phone_disabled'
  const dur    = call.duration_sec > 0 ? `${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s` : '—'
  const time   = new Date(call.started_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: colour, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold }}>{call.phone}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{call.agent_name ?? 'unassigned'} · {time}</div>
      </div>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', flexShrink: 0 }}>{dur}</div>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.md, background: `${colour}18`, color: colour, flexShrink: 0 }}>
        {call.is_abandoned ? 'Abandoned' : call.call_state}
      </span>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DialerSupervisor() {
  const [live, setLive]       = useState<LiveCampaign[]>([])
  const [all, setAll]         = useState<LiveCampaign[]>([])
  const [statsMap, setStatsMap] = useState<Record<number, CampaignStats>>({})
  const [recent, setRecent]   = useState<RecentCall[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const [liveData, allData] = await Promise.all([
        apiFetch<LiveCampaign[]>('/api/dialer/live'),
        apiFetch<LiveCampaign[]>('/api/dialer/campaigns'),
      ])
      setLive(Array.isArray(liveData) ? liveData : [])
      setAll(Array.isArray(allData) ? allData : [])

      // Load stats for all active campaigns
      const activeCamps = Array.isArray(allData) ? allData.filter((c: LiveCampaign) => c.status === 'active') : []
      const statsEntries = await Promise.allSettled(
        activeCamps.map(c => apiFetch<CampaignStats>(`/api/dialer/campaigns/${c.id}/stats`).then(s => [c.id, s] as [number, CampaignStats]))
      )
      const newStats: Record<number, CampaignStats> = {}
      statsEntries.forEach(r => { if (r.status === 'fulfilled') newStats[r.value[0]] = r.value[1] })
      setStatsMap(newStats)

      setError(null)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  // Poll every 10s
  useEffect(() => {
    const iv = setInterval(loadAll, 10_000)
    return () => clearInterval(iv)
  }, [loadAll])

  async function handleAction(id: number, action: 'pause' | 'stop' | 'start') {
    try {
      await apiPost(`/api/dialer/campaigns/${id}/${action}`, {})
      const label = action === 'start' ? 'started' : action === 'pause' ? 'paused' : 'stopped'
      toast.success(`Campaign ${label}`)
      loadAll()
    } catch (e: any) { toast.error(e.message) }
  }

  // Summary totals across all active campaigns
  const totalReady   = live.reduce((s, c) => s + n(c.agents_ready), 0)
  const totalOnCall  = live.reduce((s, c) => s + n(c.agents_on_call), 0)
  const totalFlight  = live.reduce((s, c) => s + n(c.calls_in_flight), 0)
  const totalPending = live.reduce((s, c) => s + n(c.queue_pending), 0)

  // Global abandon rate across all active campaigns
  const globalTotal    = Object.values(statsMap).reduce((s, st) => s + n(st.calls[0]?.total), 0)
  const globalAbandoned = Object.values(statsMap).reduce((s, st) => s + n(st.calls[0]?.abandoned), 0)
  const globalAbanPct  = globalTotal > 0 ? Math.round((globalAbandoned / globalTotal) * 1000) / 10 : 0

  const paused    = all.filter(c => c.status === 'paused')
  const inactive  = all.filter(c => c.status === 'draft' || c.status === 'completed')

  return (
    <Page
      title="Dialer Supervisor"
      subtitle="Live overview of all active predictive dialer campaigns"
      actions={
        <button onClick={loadAll} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>refresh</span>
          Refresh
        </button>
      }
    >
      <ErrBanner error={error} onRetry={loadAll} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : (
        <>
          {/* Global summary strip */}
          <div style={{ display: 'flex', gap: 10, marginBottom: SP[5], flexWrap: 'wrap' }}>
            <Tile label="Active Campaigns" value={live.length} colour={live.length > 0 ? GREEN : 'var(--txt3)'} icon="campaign" />
            <Tile label="Agents Ready"     value={totalReady}  colour={GREEN}  icon="person" />
            <Tile label="Agents On Call"   value={totalOnCall} colour={AMBER}  icon="call" />
            <Tile label="Calls In Flight"  value={totalFlight} colour={NAVY}   icon="phone_forwarded" />
            <Tile label="Queue Pending"    value={totalPending}                icon="queue" />
            <div style={{ flex: 1, minWidth: 200 }}>
              <AbanGauge pct={globalAbanPct} limit={3} />
            </div>
          </div>

          {/* Active campaigns */}
          {live.length === 0 ? (
            <SectionCard title="Active Campaigns">
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt3)', fontSize: TEXT.base }}>
                <span className="material-symbols-rounded" style={{ fontSize: 40, display: 'block', marginBottom: 10, opacity: 0.4 }}>campaign</span>
                No active campaigns right now.
              </div>
            </SectionCard>
          ) : (
            <SectionCard title={`Active Campaigns (${live.length})`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {live.map(c => (
                  <CampaignCard key={c.id} camp={c} stats={statsMap[c.id] ?? null} onAction={handleAction} />
                ))}
              </div>
            </SectionCard>
          )}

          {/* Paused campaigns */}
          {paused.length > 0 && (
            <SectionCard title={`Paused (${paused.length})`} style={{ marginTop: SP[4] }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {paused.map(c => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)' }}>
                    <div style={{ flex: 1, fontSize: TEXT.base, fontWeight: FW.semibold }}>{c.name}</div>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md, background: `${AMBER}18`, color: AMBER }}>paused</span>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Queue: {n(c.queue_pending)} pending</div>
                    <button onClick={() => handleAction(c.id, 'start')}
                      style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: `1.5px solid ${GREEN}40`, background: `${GREEN}10`, color: GREEN, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
                      Resume
                    </button>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Recent calls */}
          {recent.length > 0 && (
            <SectionCard title="Recent Calls" style={{ marginTop: SP[4] }}>
              {recent.map(c => <RecentCallRow key={c.id} call={c} />)}
            </SectionCard>
          )}
        </>
      )}
    </Page>
  )
}
