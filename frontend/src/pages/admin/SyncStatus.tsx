import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Page } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, NUM, INTER, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Worker {
  key: string
  name: string
  category: string
  cadence: string
  description: string
  status: string            // ok | error | running | scheduled | idle
  last_run_at: string | null
  last_ok_at: string | null
  last_error: string | null
  detail: string | null
  manual: boolean
  trigger: string
}

const CATEGORY_ORDER = ['Data Sync', 'Integration', 'Scheduled Job', 'Worker Pool']
const CATEGORY_ICON: Record<string, string> = {
  'Data Sync': 'sync', 'Integration': 'hub', 'Scheduled Job': 'schedule', 'Worker Pool': 'conveyor_belt',
}

// status → colour/label. 'scheduled' = known cadence, no recent run recorded yet.
const S: Record<string, { c: string; label: string; dot: string }> = {
  ok:        { c: GREEN, label: 'Healthy',   dot: GREEN },
  running:   { c: '#2563EB', label: 'Running', dot: '#2563EB' },
  error:     { c: RED,   label: 'Error',     dot: RED },
  scheduled: { c: '#64748B', label: 'Idle',   dot: '#94A3B8' },
  idle:      { c: '#64748B', label: 'Idle',   dot: '#94A3B8' },
}
const sInfo = (s: string) => S[s] ?? S.scheduled

function relTime(iso?: string | null): string {
  if (!iso) return 'never run'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Status LED (pulses while running) ─────────────────────────────────────────

function LED({ status }: { status: string }) {
  const { dot } = sInfo(status)
  const running = status === 'running'
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 12, height: 12, flexShrink: 0 }}>
      {running && (
        <span style={{
          position: 'absolute', inset: -3, borderRadius: '50%', background: dot, opacity: .35,
          animation: 'syncpulse 1.4s ease-out infinite',
        }} />
      )}
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: dot, boxShadow: `0 0 0 3px ${dot}22` }} />
    </span>
  )
}

// ── Worker card ───────────────────────────────────────────────────────────────

function WorkerCard({ w, onRun, busy }: { w: Worker; onRun: (w: Worker) => void; busy: boolean }) {
  const info = sInfo(w.status)
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 14, padding: '16px 18px',
      background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl,
      borderLeft: `3px solid ${info.c}`,
    }}>
      <div style={{ paddingTop: 4 }}><LED status={w.status} /></div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{w.name}</span>
          <span style={{
            fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', padding: '1px 8px',
            borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', whiteSpace: 'nowrap',
          }}>{w.cadence}</span>
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 4, lineHeight: 1.5 }}>{w.description}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: info.c }}>{info.label}</span>
          <span style={{ color: 'var(--txt3)' }}>·</span>
          <span title={w.last_run_at ? fmtDatetime(w.last_run_at) : ''} style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>{relTime(w.last_run_at)}</span>
          {w.detail && (<><span style={{ color: 'var(--txt3)' }}>·</span>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{w.detail}</span></>)}
        </div>
        {w.last_error && (
          <div style={{ fontSize: TEXT.xs, color: RED, fontFamily: 'monospace', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {w.last_error.slice(0, 160)}
          </div>
        )}
      </div>

      {w.manual && (
        <button onClick={() => onRun(w)} disabled={busy} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md,
          border: '1px solid var(--card-bdr)', background: busy ? 'var(--chip-bg)' : 'var(--card)',
          color: busy ? 'var(--txt3)' : NAVY, fontSize: TEXT.sm, fontWeight: FW.bold,
          cursor: busy ? 'default' : 'pointer', fontFamily: INTER, whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, ...(busy ? { animation: 'syncspin 1s linear infinite' } : {}) }}>sync</span>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminSyncStatus() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]       = useState<Set<string>>(new Set())
  const [lastLoad, setLastLoad] = useState<Date | null>(null)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      // respond() wraps the payload as { data: { workers, generated_at } }.
      const r = await apiFetch<{ data?: { workers?: Worker[] }; workers?: Worker[] }>('/api/admin/workers')
      const list = r?.data?.workers ?? r?.workers ?? []
      setWorkers(Array.isArray(list) ? list : [])
      setLastLoad(new Date())
    } catch { /* keep last view */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    timer.current = window.setInterval(load, 15000)   // live control-centre feel
    return () => { if (timer.current) window.clearInterval(timer.current) }
  }, [load])

  async function run(w: Worker) {
    setBusy(prev => new Set(prev).add(w.key))
    try {
      let path = w.trigger
      if (path.includes('/zoho/import-calls')) {   // Zoho needs a date window
        const to = new Date().toISOString().slice(0, 10)
        const from = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)
        path = `${path}?from_date=${from}&to_date=${to}`
      }
      await apiFetch(path, { method: 'POST' })
      toast.success(`${w.name} — sync started`)
      setTimeout(load, 2500)
    } catch (e: any) {
      toast.error(e?.message || `Could not start ${w.name}`)
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(w.key); return n })
    }
  }

  const stats = useMemo(() => ({
    total:   workers.length,
    healthy: workers.filter(w => w.status === 'ok').length,
    running: workers.filter(w => w.status === 'running').length,
    errors:  workers.filter(w => w.status === 'error').length,
  }), [workers])

  const grouped = useMemo(() => {
    const g: Record<string, Worker[]> = {}
    for (const w of workers) (g[w.category] ??= []).push(w)
    return g
  }, [workers])

  const fleetColor = stats.errors ? RED : stats.running ? '#2563EB' : GREEN

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Sync & Workers"
      subtitle="Every background sync, integration and worker — status and controls in one place"
      actions={
        <button onClick={load} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md,
          border: '1px solid var(--card-bdr)', background: 'var(--card)', color: NAVY, fontSize: TEXT.sm,
          fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>refresh</span>Refresh
        </button>
      }
    >
      <style>{`
        @keyframes syncpulse { 0% { transform: scale(.6); opacity:.5 } 100% { transform: scale(1.9); opacity:0 } }
        @keyframes syncspin { to { transform: rotate(360deg) } }
      `}</style>

      {/* Fleet health band */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr', gap: SP[3], marginBottom: 24,
        background: `linear-gradient(135deg, ${NAVY} 0%, #14385a 100%)`, borderRadius: RADIUS.xl, padding: '22px 26px',
      }}>
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'rgba(255,255,255,.6)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Fleet Status</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', background: fleetColor, boxShadow: `0 0 0 4px ${fleetColor}33` }} />
            <span style={{ fontSize: TEXT['2xl'], fontWeight: FW.bold, color: '#fff' }}>
              {stats.errors ? `${stats.errors} need attention` : stats.running ? 'Syncing' : 'All systems healthy'}
            </span>
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.55)', marginTop: 8, ...NUM }}>
            {lastLoad ? `Live · updated ${relTime(lastLoad.toISOString())}` : 'Loading…'}
          </div>
        </div>
        {[
          { label: 'Total', value: stats.total, c: '#fff' },
          { label: 'Healthy', value: stats.healthy, c: '#5EE9A6' },
          { label: 'Errors', value: stats.errors, c: stats.errors ? '#FF8A8A' : 'rgba(255,255,255,.85)' },
        ].map(k => (
          <div key={k.label} style={{ borderLeft: '1px solid rgba(255,255,255,.12)', paddingLeft: 22 }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'rgba(255,255,255,.6)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{k.label}</div>
            <div style={{ ...NUM, fontSize: 34, fontWeight: FW.bold, color: k.c, marginTop: 4, lineHeight: 1 }}>{k.value}</div>
          </div>
        ))}
      </div>

      {loading && workers.length === 0 && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--txt3)' }}>Loading workers…</div>
      )}

      {CATEGORY_ORDER.filter(c => grouped[c]?.length).map(cat => (
        <div key={cat} style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>{CATEGORY_ICON[cat] ?? 'settings'}</span>
            <h3 style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', margin: 0 }}>{cat}</h3>
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', padding: '1px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)' }}>{grouped[cat].length}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 480px), 1fr))', gap: SP[3] }}>
            {grouped[cat].map(w => <WorkerCard key={w.key} w={w} onRun={run} busy={busy.has(w.key)} />)}
          </div>
        </div>
      ))}
    </Page>
  )
}
