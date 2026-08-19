import { useLiveData } from '../../hooks/useRealtime'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, Modal } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { LiveBadge, relTime } from '../../components/MyWorkspace'

// The sales team-lead's live view — the counterpart of the call-centre supervisor
// wallboard. It answers, at a glance: who is carrying what, what is unowned, and
// where the pipeline is bunching. Its headline action is Distribute: handing the
// unowned lead pool out to officers is what turns every officer dashboard on.

interface Totals {
  total_leads: number; unowned_leads: number; converted_mtd: number
  overdue_followups: number; pipeline_kobo: number
}
interface Officer {
  id: number; full_name: string; role: string; is_active: boolean
  open_leads: number; overdue: number; stalled: number; converted_mtd: number
  pipeline_kobo: number; book_size: number
}
interface FunnelRow { stage: string; cnt: number; value_kobo: number }
interface UnownedLead { id: number; name: string | null; lead_source: string; phone: string | null; created_at: string }

interface Supervisor {
  totals: Totals
  officers: Officer[]
  funnel: FunnelRow[]
  unowned_leads: UnownedLead[]
}

interface PickOfficer { id: number; full_name: string; role: string; book_size: number; already_officer: boolean }

const STAGE_COLOR: Record<string, string> = {
  Prospect: BLUE, Qualified: AMBER, Proposal: NAVY, Negotiation: PURPLE, Won: GREEN,
}

export default function SalesSupervisor() {
  const navigate = useNavigate()
  const [data, setData] = useState<Supervisor | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number>(() => Date.now())
  const [, setTick] = useState(0)
  const [showDistribute, setShowDistribute] = useState(false)
  const [targetFor, setTargetFor] = useState<{ id: number; full_name: string } | null>(null)

  const load = useCallback(async (silent = false) => {
    setErr(null)
    try {
      const r = await apiFetch<{ data: Supervisor }>('/api/sales/supervisor')
      setData({
        totals: r.data?.totals ?? ({} as Totals),
        officers: r.data?.officers ?? [],
        funnel: r.data?.funnel ?? [],
        unowned_leads: r.data?.unowned_leads ?? [],
      })
      setUpdatedAt(Date.now())
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['crm', 'deals'] })
  useEffect(() => { const id = setInterval(load, 20000); return () => clearInterval(id) }, [load])
  // "updated Ns ago" ticker.
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id) }, [])
  const agoSecs = Math.max(0, Math.round((Date.now() - updatedAt) / 1000))

  const funnelMax = useMemo(() => Math.max(1, ...(data?.funnel ?? []).map(f => Number(f.cnt))), [data])

  if (loading && !data) return (
    <Page title="Sales Team"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (err && !data) return <Page title="Sales Team"><ErrBanner error={err} onRetry={load} /></Page>
  if (!data) return null

  const t = data.totals
  const unowned = Number(t.unowned_leads ?? 0)

  return (
    <Page
      title="Sales Team"
      subtitle="Live team workload, pipeline and lead distribution"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>updated {agoSecs < 2 ? 'now' : `${agoSecs}s ago`}</span>
          <LiveBadge />
          <button onClick={() => setTargetFor({ id: 0, full_name: '' })}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>flag</span>
            Set Targets
          </button>
          <button onClick={() => setShowDistribute(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, border: 'none', background: RED, color: '#fff', cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>hub</span>
            Distribute Leads{unowned > 0 ? ` (${fmtNum(unowned)})` : ''}
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Team KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="Open leads" value={fmtNum(t.total_leads)} icon="filter_alt" accent={NAVY} />
        <KpiCard label="Unowned" value={fmtNum(t.unowned_leads)} sub="need an officer"
          icon="person_off" accent={unowned > 0 ? RED : GREEN} />
        <KpiCard label="Overdue follow-ups" value={fmtNum(t.overdue_followups)}
          icon="alarm" accent={Number(t.overdue_followups) > 0 ? AMBER : NAVY} />
        <KpiCard label="Converted MTD" value={fmtNum(t.converted_mtd)} icon="verified" accent={GREEN} />
        <KpiCard label="Open pipeline" value={fmtKobo(t.pipeline_kobo)} icon="payments" accent={PURPLE} />
      </div>

      {/* Agent wallboard */}
      <SectionCard title="Officer Wallboard" subtitle="Live workload by officer" badge={data.officers.length || undefined}
        style={{ marginBottom: SP[4] }}>
        {data.officers.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '40px 16px', textAlign: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 32, color: 'var(--txt3)' }}>group_add</span>
            <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', maxWidth: 420, lineHeight: 1.5 }}>
              No officer holds leads yet. <strong>Distribute the {fmtNum(unowned)} unowned leads</strong> to
              your team and every officer's dashboard comes alive.
            </p>
            <button onClick={() => setShowDistribute(true)}
              style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
              Distribute Leads
            </button>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 720 }}>
              <WallHeader />
              {data.officers.map(o => <WallRow key={o.id} o={o} onClick={() => navigate(`/sales/book?officer_id=${o.id}`)} />)}
            </div>
          </div>
        )}
      </SectionCard>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        {/* Pipeline funnel */}
        <SectionCard title="Open Pipeline" subtitle="Leads by stage">
          {data.funnel.length === 0 ? (
            <Empty text="No open leads in the pipeline." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
              {data.funnel.map(f => {
                const c = STAGE_COLOR[f.stage] ?? NAVY
                return (
                  <div key={f.stage}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, marginBottom: 3 }}>
                      <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{f.stage}</span>
                      <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtNum(f.cnt)} · {fmtKobo(f.value_kobo)}</span>
                    </div>
                    <div style={{ height: 8, background: 'var(--chip-bg)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 4, background: c, width: `${Math.max(2, (Number(f.cnt) / funnelMax) * 100)}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>

        {/* Unowned lead feed */}
        <SectionCard title="Unowned Leads" subtitle="Waiting for an officer"
          actions={unowned > 0 ? (
            <button onClick={() => setShowDistribute(true)}
              style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: RED, background: 'none', border: 'none', cursor: 'pointer' }}>Distribute</button>
          ) : undefined}>
          {data.unowned_leads.length === 0 ? (
            <Empty text="Every lead has an owner. Nice." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.unowned_leads.map(l => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `${SP[2]} 0`, borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}
                  onClick={() => navigate(`/sales/customers/${l.id}`)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name ?? 'Unknown lead'}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{l.lead_source}{l.phone ? ` · ${l.phone}` : ''}</div>
                  </div>
                  <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{relTime(l.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {showDistribute && (
        <DistributeModal unowned={unowned} onClose={() => setShowDistribute(false)} onDone={() => { setShowDistribute(false); load() }} />
      )}
      {targetFor && (
        <SetTargetsModal officers={data.officers} onClose={() => setTargetFor(null)} onDone={() => { setTargetFor(null); load() }} />
      )}
    </Page>
  )
}

// ── Wallboard rows ─────────────────────────────────────────────────────────────

const GRID = '2.2fr 1fr 1fr 1fr 1fr 1fr 1.4fr'

function WallHeader() {
  const cell: React.CSSProperties = { fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.3 }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: `0 8px 8px`, borderBottom: '1px solid var(--bdr)' }}>
      <span style={cell}>Officer</span>
      <span style={{ ...cell, textAlign: 'right' }}>Open</span>
      <span style={{ ...cell, textAlign: 'right' }}>Overdue</span>
      <span style={{ ...cell, textAlign: 'right' }}>Stalled</span>
      <span style={{ ...cell, textAlign: 'right' }}>Book</span>
      <span style={{ ...cell, textAlign: 'right' }}>Won MTD</span>
      <span style={{ ...cell, textAlign: 'right' }}>Pipeline</span>
    </div>
  )
}

function WallRow({ o, onClick }: { o: Officer; onClick: () => void }) {
  const num: React.CSSProperties = { ...NUM, textAlign: 'right', fontSize: TEXT.sm }
  const initials = (o.full_name ?? '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div onClick={onClick}
      style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '10px 8px', alignItems: 'center', borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: RADIUS.full, flexShrink: 0, background: `${NAVY}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: NAVY }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.base, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.full_name}</div>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{o.role}</div>
        </div>
      </div>
      <span style={num}>{fmtNum(o.open_leads)}</span>
      <span style={{ ...num, color: Number(o.overdue) > 0 ? RED : 'var(--txt3)' }}>{fmtNum(o.overdue)}</span>
      <span style={{ ...num, color: Number(o.stalled) > 0 ? AMBER : 'var(--txt3)' }}>{fmtNum(o.stalled)}</span>
      <span style={num}>{fmtNum(o.book_size)}</span>
      <span style={{ ...num, color: Number(o.converted_mtd) > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(o.converted_mtd)}</span>
      <span style={num}>{fmtKobo(o.pipeline_kobo)}</span>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>{text}</div>
}

// ── Set-Targets modal ────────────────────────────────────────────────────────
// Targets set here flow straight to /api/sales/targets — the same store the Targets
// page and every agent's My Dashboard read, so a target set on the wallboard shows up
// on the officer's station and in the leaderboard immediately.
function SetTargetsModal({ officers, onClose, onDone }: {
  officers: Officer[]; onClose: () => void; onDone: () => void
}) {
  const thisMonth = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })()
  const [officer, setOfficer] = useState('')
  const [period, setPeriod] = useState(thisMonth)
  const [loans, setLoans] = useState('')
  const [disb, setDisb] = useState('')
  const [fds, setFds] = useState('')
  const [fdAmt, setFdAmt] = useState('')
  const [cards, setCards] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!officer) { toast.error('Pick an officer'); return }
    setSaving(true)
    try {
      await apiPost('/api/sales/targets', {
        user_id: parseInt(officer), period,
        loan_count: parseInt(loans) || 0,
        disbursement_kobo: Math.round(parseFloat(disb) * 100) || 0,
        fd_count: parseInt(fds) || 0,
        fd_amount_kobo: Math.round(parseFloat(fdAmt) * 100) || 0,
        card_count: parseInt(cards) || 0,
      })
      toast.success('Target set')
      onDone()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }

  return (
    <Modal open onClose={onClose} title="Set sales target" width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving…' : 'Save target'}</button>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={lbl}>Officer</label>
          <select value={officer} onChange={e => setOfficer(e.target.value)} style={inp}>
            <option value="">— Select officer —</option>
            {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Period</label>
          <input type="month" value={period} onChange={e => setPeriod(e.target.value)} style={inp} />
        </div>
        <div />
        <div><label style={lbl}>Loan count</label><input type="number" value={loans} onChange={e => setLoans(e.target.value)} placeholder="0" style={inp} /></div>
        <div><label style={lbl}>Disbursement (₦)</label><input type="number" value={disb} onChange={e => setDisb(e.target.value)} placeholder="0.00" style={inp} /></div>
        <div><label style={lbl}>FD count</label><input type="number" value={fds} onChange={e => setFds(e.target.value)} placeholder="0" style={inp} /></div>
        <div><label style={lbl}>FD amount (₦)</label><input type="number" value={fdAmt} onChange={e => setFdAmt(e.target.value)} placeholder="0.00" style={inp} /></div>
        <div><label style={lbl}>Card count</label><input type="number" value={cards} onChange={e => setCards(e.target.value)} placeholder="0" style={inp} /></div>
      </div>
    </Modal>
  )
}

// ── Distribute modal ───────────────────────────────────────────────────────────

function DistributeModal({ unowned, onClose, onDone }: { unowned: number; onClose: () => void; onDone: () => void }) {
  const [officers, setOfficers] = useState<PickOfficer[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [strategy, setStrategy] = useState<'round_robin' | 'by_state'>('round_robin')
  const [limit, setLimit] = useState<string>('')
  const [preview, setPreview] = useState<{ would_assign: number; per_officer: { officer_id: number; full_name: string; count: number }[] } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch<{ data: PickOfficer[] }>('/api/sales/officers')
        setOfficers(r.data ?? [])
      } catch (e: any) { toast.error(e.message ?? 'Could not load officers') }
    })()
  }, [])

  function toggle(id: number) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
    setPreview(null)
  }

  function body(dryRun: boolean) {
    return {
      officer_ids: [...selected],
      strategy,
      limit: limit ? Math.max(0, parseInt(limit, 10) || 0) : 0,
      dry_run: dryRun,
    }
  }

  async function doPreview() {
    if (selected.size === 0) { toast.error('Pick at least one officer'); return }
    setBusy(true)
    try {
      const r = await apiPost<{ data: any }>('/api/sales/leads/distribute', body(true))
      setPreview({ would_assign: r.data.would_assign, per_officer: r.data.per_officer })
    } catch (e: any) { toast.error(e.message ?? 'Preview failed') }
    finally { setBusy(false) }
  }

  async function doDistribute() {
    if (selected.size === 0) { toast.error('Pick at least one officer'); return }
    setBusy(true)
    try {
      const r = await apiPost<{ data: any }>('/api/sales/leads/distribute', body(false))
      toast.success(`Distributed ${fmtNum(r.data.assigned)} leads to ${selected.size} officer${selected.size > 1 ? 's' : ''}`)
      onDone()
    } catch (e: any) { toast.error(e.message ?? 'Distribution failed') }
    finally { setBusy(false) }
  }

  const field: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)' }
  const lbl: React.CSSProperties = { fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4, display: 'block' }

  return (
    <Modal open onClose={onClose} title="Distribute unowned leads" width={560} maxHeight="80vh"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtNum(unowned)} unowned · {selected.size} selected</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={doPreview} disabled={busy || selected.size === 0}
              style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: busy ? 'default' : 'pointer', opacity: busy || selected.size === 0 ? 0.6 : 1 }}>Preview split</button>
            <button onClick={doDistribute} disabled={busy || selected.size === 0}
              style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: busy ? 'default' : 'pointer', opacity: busy || selected.size === 0 ? 0.6 : 1 }}>{busy ? 'Working…' : 'Distribute'}</button>
          </div>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>Strategy</label>
            <select value={strategy} onChange={e => { setStrategy(e.target.value as any); setPreview(null) }} style={field}>
              <option value="round_robin">Round-robin (even split)</option>
              <option value="by_state">By state (keep states together)</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Limit (blank = all)</label>
            <input value={limit} onChange={e => { setLimit(e.target.value.replace(/[^0-9]/g, '')); setPreview(null) }} placeholder="e.g. 500" style={field} />
          </div>
        </div>
        {strategy === 'by_state' && (
          <div style={{ fontSize: TEXT.xs, color: AMBER, background: `${AMBER}12`, border: `1px solid ${AMBER}33`, borderRadius: RADIUS.md, padding: '8px 10px' }}>
            Heads-up: every current lead has a blank state, so “by state” assigns them all to one officer. Use round-robin for an even split.
          </div>
        )}

        <div>
          <label style={lbl}>Officers ({selected.size} selected)</label>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }}>
            {officers.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>Loading officers…</div>
            ) : officers.map(o => (
              <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}>
                <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.base }}>{o.full_name}</div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{o.role}{o.book_size > 0 ? ` · ${fmtNum(o.book_size)} in book` : ''}</div>
                </div>
                {o.already_officer && <span style={{ fontSize: TEXT['2xs'], color: GREEN, fontWeight: FW.semibold }}>officer</span>}
              </label>
            ))}
          </div>
        </div>

        {preview && (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: 12 }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, marginBottom: 8 }}>
              Preview: {fmtNum(preview.would_assign)} leads would be assigned:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {preview.per_officer.map(p => (
                <div key={p.officer_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm }}>
                  <span style={{ color: 'var(--txt2)' }}>{p.full_name}</span>
                  <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtNum(p.count)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
