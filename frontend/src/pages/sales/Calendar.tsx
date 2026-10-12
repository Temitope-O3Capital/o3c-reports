import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Button, Spinner, EmptyState, ErrBanner, StatusBadge } from '../../components/UI'
import { SelectMenuField } from '../../components/SelectMenu'
import { apiFetch, apiPost } from '../../lib/api'
import { currentUser } from '../../hooks/useAuth'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { toast } from 'sonner'
import { PlanVisitModal } from './PlanVisitModal'
import { NAVY, AMBER, PURPLE, BLUE, RED, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { fmtDate } from '../../lib/fmt'
import { useLiveData } from '../../hooks/useRealtime'

// The officer's planning calendar.
//
// Collections has had a date-organised worklist for a long time (Repayments Due); Sales
// had nothing forward-looking at all. The only calendar in Sales — Team (Live) — looks
// BACKWARDS: it reconstructs what each officer did from the activity stream, which is a
// head's question, not an officer's. An officer on Monday needs the opposite: what is
// coming, where, and in what order.
//
// Two kinds of thing land on this calendar and they come from different places:
//
//   PLANS      written here, in app.sales_visit_plans — the visits, calls and meetings
//              the officer intends. Theirs to add, move and close.
//   FOLLOW-UPS already recorded on the lead as next_action_at, set by the disposition
//              machinery when someone promised to come back to a customer. Shown, never
//              duplicated: the lead stays the only writer of its own next action.
//
// Both are rendered on the same squares because an officer deciding about Thursday does
// not care which table a commitment came from — and showing one without the other would
// have the calendar lie by omission.

interface Plan {
  id: number
  kind: string
  planned_for: string
  planned_at?: string | null
  status: string
  title?: string | null
  notes?: string | null
  address?: string | null
  where_city?: string | null
  where_state?: string | null
  outcome?: string | null
  contact_id?: number | null
  contact_name?: string | null
  contact_phone?: string | null
  contact_stage?: string | null
  source: 'plan'
}
interface FollowUp {
  contact_id: number
  next_action_at: string
  planned_for: string
  contact_name?: string | null
  contact_phone?: string | null
  contact_stage?: string | null
  where_city?: string | null
  where_state?: string | null
  source: 'follow_up'
}
type Entry = Plan | FollowUp
interface Officer { id: number; full_name: string; is_active: boolean }

const KIND_META: Record<string, { label: string; icon: string; colour: string }> = {
  visit:     { label: 'Visit',     icon: 'location_on', colour: NAVY },
  call:      { label: 'Call',      icon: 'call',        colour: BLUE },
  meeting:   { label: 'Meeting',   icon: 'groups',      colour: PURPLE },
  follow_up: { label: 'Follow-Up', icon: 'update',      colour: AMBER },
}
const kindMeta = (k: string) => KIND_META[k] ?? { label: k, icon: 'event', colour: 'var(--txt3)' }

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** The Monday-first grid covering the whole month, as yyyy-mm-dd strings. */
function monthGrid(year: number, month: number): string[] {
  const first = new Date(Date.UTC(year, month, 1))
  // getUTCDay is 0=Sunday; shift so Monday is 0, because the working week starts there.
  const lead = (first.getUTCDay() + 6) % 7
  const start = new Date(Date.UTC(year, month, 1 - lead))
  const cells: string[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    cells.push(d.toISOString().slice(0, 10))
  }
  // Trim a trailing all-next-month week so a short month does not render a blank row.
  while (cells.length > 35 && new Date(cells[cells.length - 7] + 'T00:00:00Z').getUTCMonth() !== month) {
    cells.splice(cells.length - 7, 7)
  }
  return cells
}

const todayKey = () => new Date().toISOString().slice(0, 10)

export default function SalesCalendar() {
  const navigate = useNavigate()
  const me = currentUser()
  const isMobile = useIsMobile()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [officerId, setOfficerId] = useState<string>('')
  const [officers, setOfficers] = useState<Officer[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [planDay, setPlanDay] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>(todayKey())

  const cells = useMemo(() => monthGrid(year, month), [year, month])
  const from = cells[0]
  const to = cells[cells.length - 1]

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const q = new URLSearchParams({ from, to })
      if (officerId) q.set('officer_id', officerId)
      const res = await apiFetch<any>(`/api/sales/visit-plans?${q.toString()}`)
      const d = res?.data ?? res
      setPlans((d?.plans ?? []).map((p: any) => ({ ...p, source: 'plan' as const })))
      setFollowUps((d?.follow_ups ?? []).map((f: any) => ({ ...f, source: 'follow_up' as const })))
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load the calendar')
    } finally { setLoading(false) }
  }, [from, to, officerId])
  useEffect(() => { load() }, [load])
  // Live: a supervisor dropping a visit into your week has to appear in it.
  useLiveData(load, { topics: ['sales_visits', 'activities', 'tasks'] })

  // A head may look at their team's diaries; an officer only ever sees their own, so
  // the picker is simply absent for them rather than present and refused.
  useEffect(() => {
    let dead = false
    apiFetch<{ data: any[] } | any[]>('/api/sales/teams').then(r => {
      if (dead) return
      const teams = Array.isArray(r) ? r : (r?.data ?? [])
      const mine = teams.filter((t: any) => t.head_user_id === me?.id)
      if (mine.length === 0) return
      const seen = new Map<number, Officer>()
      mine.forEach((t: any) => (t.members ?? []).forEach((m: any) => {
        if (m.user_id) seen.set(m.user_id, { id: m.user_id, full_name: m.full_name ?? `Officer ${m.user_id}`, is_active: true })
      }))
      setOfficers([...seen.values()].sort((a, b) => a.full_name.localeCompare(b.full_name)))
    }).catch(() => { /* not a head */ })
    return () => { dead = true }
  }, [me?.id])

  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>()
    const push = (k: string, e: Entry) => {
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(e)
    }
    plans.forEach(p => push((p.planned_for || '').slice(0, 10), p))
    followUps.forEach(f => push((f.planned_for || '').slice(0, 10), f))
    return m
  }, [plans, followUps])

  async function complete(plan: Plan, status: 'done' | 'missed') {
    try {
      await apiPost(`/api/sales/visit-plans/${plan.id}/complete`, { status })
      toast.success(status === 'done' ? 'Logged as done' : 'Marked as missed')
      load()
    } catch (e: any) { toast.error(e?.message ?? 'Could not close the plan') }
  }

  async function cancel(plan: Plan) {
    try {
      await apiFetch(`/api/sales/visit-plans/${plan.id}`, { method: 'DELETE' })
      toast.success('Removed from your diary')
      load()
    } catch (e: any) { toast.error(e?.message ?? 'Could not remove the plan') }
  }

  const monthLabel = new Date(Date.UTC(year, month, 1))
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  function shift(by: number) {
    const d = new Date(Date.UTC(year, month + by, 1))
    setYear(d.getUTCFullYear()); setMonth(d.getUTCMonth())
  }

  const dayEntries = byDay.get(selected) ?? []
  const plannedCount = plans.filter(p => p.status === 'planned').length
  const overdueFollowUps = followUps.filter(f => f.planned_for < todayKey()).length

  return (
    <Page
      title="My Calendar"
      subtitle="The visits and calls you have planned, and the follow-ups your leads are due"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
          {officers.length > 0 && (
            <div style={{ minWidth: 190 }}>
              <SelectMenuField
                label=""
                value={officerId}
                onChange={setOfficerId}
                options={[{ value: '', label: 'My diary' },
                  ...officers.map(o => ({ value: String(o.id), label: o.full_name }))]}
              />
            </div>
          )}
          <Button size="sm" variant="secondary" icon="chevron_left" onClick={() => shift(-1)} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', minWidth: 130, textAlign: 'center' }}>
            {monthLabel}
          </span>
          <Button size="sm" variant="secondary" icon="chevron_right" onClick={() => shift(1)} />
          <Button size="sm" variant="primary" icon="add" onClick={() => setPlanDay(selected)}>Plan</Button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* The two numbers worth knowing before looking at the grid. Overdue follow-ups
          are called out because they are the ones that rot quietly. */}
      <div style={{ display: 'flex', gap: SP[3], flexWrap: 'wrap', marginBottom: SP[4] }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          <strong style={{ color: 'var(--txt)' }}>{plannedCount}</strong> planned this month
        </div>
        <div style={{ fontSize: TEXT.sm, color: overdueFollowUps > 0 ? RED : 'var(--txt2)' }}>
          <strong>{overdueFollowUps}</strong> follow-up{overdueFollowUps === 1 ? '' : 's'} overdue
        </div>
      </div>

      {loading && plans.length === 0 && followUps.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}><Spinner size={26} /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 2fr) minmax(0, 1fr)', gap: SP[4], alignItems: 'start' }}>
          {/* ── The month ── */}
          <SectionCard title={monthLabel} subtitle="Click a day to see it in full, or to plan something">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
              {DAY_NAMES.map(d => (
                <div key={d} style={{
                  fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)',
                  textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'center', paddingBottom: 4,
                }}>{d}</div>
              ))}
              {cells.map(day => {
                const entries = byDay.get(day) ?? []
                const inMonth = new Date(day + 'T00:00:00Z').getUTCMonth() === month
                const isToday = day === todayKey()
                const isSel = day === selected
                const weekend = [5, 6].includes((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7)
                return (
                  <button key={day} onClick={() => setSelected(day)}
                    title={`${fmtDate(day)} — ${entries.length} item${entries.length === 1 ? '' : 's'}`}
                    style={{
                      minHeight: 62, padding: 5, textAlign: 'left', cursor: 'pointer',
                      borderRadius: RADIUS.md,
                      border: isSel ? `2px solid ${NAVY}` : '1px solid var(--bdr)',
                      background: !inMonth ? 'transparent' : weekend ? 'var(--row-hvr)' : 'var(--card)',
                      opacity: inMonth ? 1 : 0.4,
                      display: 'flex', flexDirection: 'column', gap: 3,
                    }}>
                    <span style={{
                      fontSize: TEXT.xs, fontWeight: isToday ? FW.bold : FW.medium,
                      color: isToday ? NAVY : 'var(--txt2)',
                    }}>
                      {Number(day.slice(8, 10))}
                    </span>
                    {entries.slice(0, 3).map((e, i) => {
                      const m = e.source === 'plan' ? kindMeta(e.kind) : kindMeta('follow_up')
                      const done = e.source === 'plan' && e.status !== 'planned'
                      return (
                        <span key={i} style={{
                          fontSize: 9.5, lineHeight: 1.25, borderRadius: 3, padding: '1px 3px',
                          background: `${m.colour}1f`, color: done ? 'var(--txt3)' : m.colour,
                          textDecoration: done ? 'line-through' : undefined,
                          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                        }}>
                          {e.contact_name || m.label}
                        </span>
                      )
                    })}
                    {entries.length > 3 && (
                      <span style={{ fontSize: 9, color: 'var(--txt3)' }}>+{entries.length - 3} more</span>
                    )}
                  </button>
                )
              })}
            </div>
          </SectionCard>

          {/* ── The selected day ── */}
          <SectionCard
            title={fmtDate(selected)}
            subtitle={`${dayEntries.length} item${dayEntries.length === 1 ? '' : 's'}`}
            actions={<Button size="xs" variant="secondary" icon="add" onClick={() => setPlanDay(selected)}>Plan</Button>}
          >
            {dayEntries.length === 0 ? (
              <EmptyState icon="event_available" title="Nothing Planned"
                description="Add a visit, call or meeting to this day." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                {dayEntries.map((e, i) => {
                  const m = e.source === 'plan' ? kindMeta(e.kind) : kindMeta('follow_up')
                  const where = [e.where_city, e.where_state].filter(Boolean).join(', ')
                  return (
                    <div key={i} style={{
                      padding: SP[3], borderRadius: RADIUS.lg, border: '1px solid var(--bdr)',
                      background: 'var(--card)', display: 'flex', flexDirection: 'column', gap: 6,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 16, color: m.colour }}>{m.icon}</span>
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: m.colour }}>{m.label}</span>
                        {e.source === 'plan' && e.status !== 'planned' && (
                          <StatusBadge status={e.status} />
                        )}
                        {e.source === 'follow_up' && e.planned_for < todayKey() && (
                          <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: RED }}>OVERDUE</span>
                        )}
                        {e.source === 'plan' && e.planned_at && (
                          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>
                            {String(e.planned_at).slice(11, 16)}
                          </span>
                        )}
                      </div>
                      <button onClick={() => e.contact_id && navigate(`/sales/leads/${e.contact_id}`)}
                        style={{
                          textAlign: 'left', border: 'none', background: 'none', padding: 0,
                          cursor: e.contact_id ? 'pointer' : 'default',
                          fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)',
                        }}>
                        {e.contact_name || (e.source === 'plan' ? (e.title || 'Untitled') : 'Lead')}
                      </button>
                      {(where || e.contact_phone) && (
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                          {where}{where && e.contact_phone ? ' · ' : ''}
                          {e.contact_phone && <span style={{ fontFamily: 'var(--font-mono)' }}>{e.contact_phone}</span>}
                        </div>
                      )}
                      {e.source === 'plan' && (e.title || e.address || e.notes) && (
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
                          {e.contact_name && e.title ? e.title : ''}
                          {e.address ? `${e.title && e.contact_name ? ' · ' : ''}${e.address}` : ''}
                          {e.notes ? ` — ${e.notes}` : ''}
                        </div>
                      )}
                      {e.source === 'plan' && e.status === 'planned' && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {/* Closing a plan writes a real activity, so the day shows up on
                              the team calendar and the lead's timeline without the officer
                              logging the same visit a second time. */}
                          <Button size="xs" variant="primary" icon="check"
                            onClick={() => complete(e, 'done')}>Done</Button>
                          <Button size="xs" variant="secondary" icon="event_busy"
                            onClick={() => complete(e, 'missed')}>Missed</Button>
                          <Button size="xs" variant="ghost" icon="close"
                            onClick={() => cancel(e)}>Remove</Button>
                        </div>
                      )}
                      {e.source === 'follow_up' && (
                        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', lineHeight: 1.5 }}>
                          Set on the lead itself. Work it from the lead, or plan a visit to replace it.
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {planDay && (
        <PlanVisitModal
          day={planDay}
          officerId={officerId ? Number(officerId) : undefined}
          onClose={() => setPlanDay(null)}
          onDone={() => { setPlanDay(null); load() }}
        />
      )}
    </Page>
  )
}
