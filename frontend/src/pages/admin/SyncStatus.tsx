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
  status: string
  last_run_at: string | null
  last_ok_at: string | null
  last_error: string | null
  detail: string | null
  manual: boolean
  trigger: string
  interval_sec: number
  next_run_at: string | null
}

const REFRESH_MS = 5000

const CATEGORY_ORDER = ['Data Sync', 'Integration', 'Scheduled Job', 'Worker Pool']
const CATEGORY_ICON: Record<string, string> = {
  'Data Sync': 'sync', 'Integration': 'hub', 'Scheduled Job': 'schedule', 'Worker Pool': 'conveyor_belt',
}

const S: Record<string, { c: string; label: string; dot: string }> = {
  ok:        { c: GREEN,    label: 'Healthy',  dot: GREEN },
  running:   { c: '#2563EB', label: 'Running', dot: '#2563EB' },
  error:     { c: RED,      label: 'Error',    dot: RED },
  scheduled: { c: AMBER,    label: 'Waiting',  dot: AMBER },
  idle:      { c: AMBER,    label: 'Waiting',  dot: AMBER },
}
const sInfo = (s: string) => S[s] ?? S.scheduled
const effStatus = (w: Worker) => (w.category === 'Worker Pool' && w.status === 'scheduled' ? 'running' : w.status)

// ── Live time helpers ─────────────────────────────────────────────────────────

function relLive(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never run'
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
function countdown(iso: string | null | undefined, now: number): { label: string; due: boolean } | null {
  if (!iso) return null
  const s = Math.floor((new Date(iso).getTime() - now) / 1000)
  if (s <= 0) return { label: 'due now', due: true }
  if (s < 60) return { label: `in ${s}s`, due: false }
  const m = Math.floor(s / 60), sec = s % 60
  if (m < 60) return { label: `in ${m}m ${String(sec).padStart(2, '0')}s`, due: false }
  const h = Math.floor(m / 60)
  if (h < 24) return { label: `in ${h}h ${m % 60}m`, due: false }
  return { label: `in ${Math.floor(h / 24)}d`, due: false }
}
// progress 0..1 through the current interval (time since last run / interval)
function cycleProg(w: Worker, now: number): number | null {
  if (w.interval_sec <= 0 || !w.last_run_at) return null
  const p = (now - new Date(w.last_run_at).getTime()) / (w.interval_sec * 1000)
  return Math.min(1, Math.max(0, p))
}

// ── Status LED ────────────────────────────────────────────────────────────────

function LED({ status }: { status: string }) {
  const { dot } = sInfo(status)
  const pulse = status === 'running'
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 12, height: 12, flexShrink: 0 }}>
      {pulse && <span style={{ position: 'absolute', inset: -4, borderRadius: '50%', background: dot, opacity: .4, animation: 'syncpulse 1.2s ease-out infinite' }} />}
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: dot, boxShadow: `0 0 0 3px ${dot}22`,
        animation: (status === 'scheduled' || status === 'idle') ? 'syncbreathe 2.4s ease-in-out infinite' : 'none' }} />
    </span>
  )
}

// ── Worker card ───────────────────────────────────────────────────────────────

function WorkerCard({ w, now, onRun, busy, flash, idx }: { w: Worker; now: number; onRun: (w: Worker) => void; busy: boolean; flash: boolean; idx: number }) {
  const status = effStatus(w)
  const info = sInfo(status)
  const running = status === 'running' || busy
  const cd = countdown(w.next_run_at, now)
  const prog = cycleProg(w, now)
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      display: 'flex', alignItems: 'flex-start', gap: 14, padding: '15px 18px', paddingBottom: 17,
      background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl,
      borderLeft: `3px solid ${info.c}`,
      boxShadow: flash ? `0 0 0 2px ${GREEN}, 0 0 22px ${GREEN}55` : 'none',
      transition: 'box-shadow .5s ease',
      animation: 'syncrise .45s ease both', animationDelay: `${Math.min(idx, 12) * 28}ms`,
    }}>
      {running && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          background: `linear-gradient(100deg, transparent 30%, ${info.c}16 50%, transparent 70%)`,
          backgroundSize: '200% 100%', animation: 'syncshimmer 1.5s linear infinite' }} />
      )}
      <div style={{ paddingTop: 4, zIndex: 1 }}><LED status={status} /></div>

      <div style={{ flex: 1, minWidth: 0, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{w.name}</span>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', padding: '1px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', whiteSpace: 'nowrap' }}>{w.cadence}</span>
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 4, lineHeight: 1.5 }}>{w.description}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: info.c }}>{running && !busy ? 'Running' : info.label}</span>
          <span style={{ color: 'var(--txt3)' }}>·</span>
          <span title={w.last_run_at ? fmtDatetime(w.last_run_at) : ''} style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>{relLive(w.last_run_at, now)}</span>
          {w.detail && (<><span style={{ color: 'var(--txt3)' }}>·</span><span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{w.detail}</span></>)}
          {cd && status !== 'running' && (
            <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '1px 8px', borderRadius: RADIUS['2xl'],
              background: cd.due ? `${AMBER}1e` : 'var(--chip-bg)', color: cd.due ? AMBER : 'var(--txt2)', whiteSpace: 'nowrap' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13, verticalAlign: '-2px', marginRight: 3 }}>timer</span>next {cd.label}
            </span>
          )}
        </div>
        {w.last_error && (
          <div style={{ fontSize: TEXT.xs, color: RED, fontFamily: 'monospace', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.last_error.slice(0, 160)}</div>
        )}
      </div>

      {w.manual && (
        <button onClick={() => onRun(w)} disabled={busy} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, zIndex: 1,
          border: '1px solid var(--card-bdr)', background: busy ? 'var(--chip-bg)' : 'var(--card)',
          color: busy ? 'var(--txt3)' : NAVY, fontSize: TEXT.sm, fontWeight: FW.bold,
          cursor: busy ? 'default' : 'pointer', fontFamily: INTER, whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, ...(busy ? { animation: 'syncspin 1s linear infinite' } : {}) }}>sync</span>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      )}

      {/* cycle progress bar — sweeps toward the next run; indeterminate while running */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'var(--chip-bg)', zIndex: 1 }}>
        {running ? (
          <div style={{ position: 'absolute', height: '100%', width: '35%', background: info.c, borderRadius: 2, animation: 'syncindet 1.3s ease-in-out infinite' }} />
        ) : prog !== null ? (
          <div style={{ height: '100%', width: `${prog * 100}%`, background: prog > 0.9 ? AMBER : info.c, borderRadius: 2, transition: 'width 1s linear' }} />
        ) : null}
      </div>
    </div>
  )
}

// count-up hook for the fleet numbers
function useCountUp(target: number, ms = 600): number {
  const [v, setV] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = from.current; const t0 = performance.now(); let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      setV(Math.round(start + (target - start) * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(step); else from.current = target
    }
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

function FleetNum({ value, color }: { value: number; color: string }) {
  const v = useCountUp(value)
  return <div style={{ ...NUM, fontSize: 34, fontWeight: FW.bold, color, marginTop: 4, lineHeight: 1 }}>{v}</div>
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminSyncStatus() {
  const [workers, setWorkers] = useState<Worker[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy]       = useState<Set<string>>(new Set())
  const [lastLoad, setLastLoad] = useState<number>(Date.now())
  const [now, setNow] = useState<number>(Date.now())
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const prevRuns = useRef<Record<string, string | null>>({})

  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [])

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ data?: { workers?: Worker[] }; workers?: Worker[] }>('/api/admin/workers')
      const list = (r?.data?.workers ?? r?.workers ?? []) as Worker[]
      // detect completions → flash the card green
      const fresh = new Set<string>()
      for (const w of list) {
        const prev = prevRuns.current[w.key]
        if (prev !== undefined && prev !== w.last_run_at && w.last_run_at) fresh.add(w.key)
        prevRuns.current[w.key] = w.last_run_at
      }
      if (fresh.size) {
        setFlash(fresh)
        window.setTimeout(() => setFlash(new Set()), 1400)
      }
      setWorkers(Array.isArray(list) ? list : [])
      setLastLoad(Date.now())
    } catch { /* keep last view */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { const t = window.setInterval(load, REFRESH_MS); return () => window.clearInterval(t) }, [load])

  async function run(w: Worker) {
    setBusy(prev => new Set(prev).add(w.key))
    try {
      let path = w.trigger
      if (path.includes('/zoho/import-calls')) {
        const to = new Date().toISOString().slice(0, 10)
        const from = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)
        path = `${path}?from_date=${from}&to_date=${to}`
      }
      await apiFetch(path, { method: 'POST' })
      toast.success(`${w.name} — sync started`)
      setTimeout(load, 1500)
    } catch (e: any) {
      toast.error(e?.message || `Could not start ${w.name}`)
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(w.key); return n })
    }
  }

  const stats = useMemo(() => {
    const eff = workers.map(effStatus)
    return { total: workers.length, healthy: eff.filter(s => s === 'ok' || s === 'running').length,
      running: eff.filter(s => s === 'running').length, errors: eff.filter(s => s === 'error').length }
  }, [workers])

  const grouped = useMemo(() => {
    const g: Record<string, Worker[]> = {}
    for (const w of workers) (g[w.category] ??= []).push(w)
    return g
  }, [workers])

  const recent = useMemo(() =>
    workers.filter(w => w.last_run_at).sort((a, b) => new Date(b.last_run_at!).getTime() - new Date(a.last_run_at!).getTime()).slice(0, 5)
  , [workers])

  const fleetColor = stats.errors ? RED : stats.running ? '#2563EB' : GREEN
  const refreshPct = Math.min(100, ((now - lastLoad) / REFRESH_MS) * 100)

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Sync & Workers"
      subtitle="Every background sync, integration and worker — status and controls in one place"
      actions={
        <button onClick={load} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md,
          border: '1px solid var(--card-bdr)', background: 'var(--card)', color: NAVY, fontSize: TEXT.sm, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>refresh</span>Refresh
        </button>
      }
    >
      <style>{`
        @keyframes syncpulse { 0% { transform: scale(.55); opacity:.55 } 100% { transform: scale(2); opacity:0 } }
        @keyframes syncspin { to { transform: rotate(360deg) } }
        @keyframes syncshimmer { 0% { background-position: 150% 0 } 100% { background-position: -150% 0 } }
        @keyframes syncbreathe { 0%,100% { opacity:.55 } 50% { opacity:1 } }
        @keyframes livedot { 0%,100% { opacity:1; transform:scale(1) } 50% { opacity:.4; transform:scale(.8) } }
        @keyframes syncindet { 0% { left:-35% } 100% { left:100% } }
        @keyframes syncrise { from { opacity:0; transform:translateY(9px) } to { opacity:1; transform:translateY(0) } }
        @keyframes aurora { 0% { transform:translate(-8%,-12%) rotate(0deg) } 50% { transform:translate(10%,8%) rotate(180deg) } 100% { transform:translate(-8%,-12%) rotate(360deg) } }
      `}</style>

      {/* Fleet health band — live, with aurora */}
      <div style={{
        position: 'relative', overflow: 'hidden',
        display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr', gap: SP[3], marginBottom: 22,
        background: `linear-gradient(135deg, ${NAVY} 0%, #14385a 100%)`, borderRadius: RADIUS.xl, padding: '22px 26px',
      }}>
        {/* aurora blobs */}
        <div style={{ position: 'absolute', top: '-40%', left: '10%', width: 320, height: 320, borderRadius: '50%',
          background: `radial-gradient(circle, ${fleetColor}44 0%, transparent 65%)`, filter: 'blur(24px)', animation: 'aurora 14s ease-in-out infinite', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: '-50%', right: '8%', width: 300, height: 300, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(94,233,166,.28) 0%, transparent 65%)', filter: 'blur(26px)', animation: 'aurora 18s ease-in-out infinite reverse', pointerEvents: 'none' }} />
        {/* refresh progress line */}
        <div style={{ position: 'absolute', top: 0, left: 0, height: 3, width: `${refreshPct}%`, background: 'rgba(94,233,166,.95)', transition: 'width 1s linear', borderTopLeftRadius: RADIUS.xl, zIndex: 2 }} />

        <div style={{ zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#5EE9A6', animation: 'livedot 1.5s ease-in-out infinite' }} />
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: '#5EE9A6', textTransform: 'uppercase', letterSpacing: '1px' }}>Live</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', background: fleetColor, boxShadow: `0 0 0 4px ${fleetColor}33`,
              animation: stats.running ? 'livedot 1.4s ease-in-out infinite' : 'none' }} />
            <span style={{ fontSize: TEXT['2xl'], fontWeight: FW.bold, color: '#fff' }}>
              {stats.errors ? `${stats.errors} need attention` : stats.running ? `${stats.running} syncing now` : 'All systems healthy'}
            </span>
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.55)', marginTop: 8, ...NUM }}>
            auto-refresh {Math.max(0, Math.ceil((REFRESH_MS - (now - lastLoad)) / 1000))}s · updated {relLive(new Date(lastLoad).toISOString(), now)}
          </div>
        </div>
        {[
          { label: 'Workers', value: stats.total, c: '#fff' },
          { label: 'Healthy', value: stats.healthy, c: '#5EE9A6' },
          { label: 'Errors', value: stats.errors, c: stats.errors ? '#FF8A8A' : 'rgba(255,255,255,.85)' },
        ].map(k => (
          <div key={k.label} style={{ borderLeft: '1px solid rgba(255,255,255,.12)', paddingLeft: 22, zIndex: 1 }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'rgba(255,255,255,.6)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{k.label}</div>
            <FleetNum value={k.value} color={k.c} />
          </div>
        ))}
      </div>

      {/* Live activity ticker */}
      {recent.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 16px', marginBottom: 22,
          background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.5px', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15, color: GREEN }}>bolt</span>Recent activity
          </span>
          {recent.map(w => (
            <span key={w.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: sInfo(effStatus(w)).dot }} />
              <span style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{w.name.split(' · ')[0]}</span>
              <span style={{ ...NUM, color: 'var(--txt3)' }}>{relLive(w.last_run_at, now)}</span>
            </span>
          ))}
        </div>
      )}

      {loading && workers.length === 0 && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--txt3)' }}>Loading workers…</div>
      )}

      {CATEGORY_ORDER.filter(c => grouped[c]?.length).map(cat => (
        <div key={cat} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>{CATEGORY_ICON[cat] ?? 'settings'}</span>
            <h3 style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', margin: 0 }}>{cat}</h3>
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', padding: '1px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)' }}>{grouped[cat].length}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 480px), 1fr))', gap: SP[3] }}>
            {grouped[cat].map((w, i) => <WorkerCard key={w.key} w={w} now={now} onRun={run} busy={busy.has(w.key)} flash={flash.has(w.key)} idx={i} />)}
          </div>
        </div>
      ))}
    </Page>
  )
}
