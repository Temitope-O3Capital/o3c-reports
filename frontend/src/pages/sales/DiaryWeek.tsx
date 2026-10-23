import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SectionCard, Button, Spinner, EmptyState } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { PlanVisitModal, type PlanOfficer } from './PlanVisitModal'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { NAVY, AMBER, PURPLE, BLUE, RED, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { useLiveData } from '../../hooks/useRealtime'

// The week, as a strip — the diary where the work actually happens.
//
// A month grid is the right shape for planning ahead and the wrong shape for a
// dashboard: My Workspace already carries eight sections, and a 42-cell calendar would
// dominate the page an officer opens to see their targets and follow-ups. Seven columns
// answer the question they actually have at 8am — what is today, what is tomorrow, and
// is Thursday already full.
//
// Two modes off one component, because the two audiences ask different questions:
//
//   mine  — one row, the officer's own week. Lives on My Workspace.
//   team  — one row per officer, so a head sees who is out, where, and whose week is
//           empty. Lives on the supervisor page, and lets them drop a plan into a
//           member's diary, which is the thing they could not do at all before.
//
// The full month stays at /sales/calendar for planning further out, and is linked from
// the header here rather than duplicated.

interface Plan {
  id: number
  kind: string
  planned_for: string
  planned_at?: string | null
  status: string
  title?: string | null
  officer_id?: number
  officer_name?: string
  contact_id?: number | null
  contact_name?: string | null
  where_city?: string | null
  where_state?: string | null
}
interface FollowUp {
  contact_id: number
  planned_for: string
  contact_name?: string | null
  where_city?: string | null
}

const KIND_COLOUR: Record<string, string> = {
  visit: NAVY, call: BLUE, meeting: PURPLE, follow_up: AMBER,
}
const DAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday of the current week, then seven days from it. */
function weekFrom(offsetWeeks: number): string[] {
  const now = new Date()
  const mondayShift = (now.getDay() + 6) % 7
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - mondayShift + offsetWeeks * 7))
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  })
}
const todayKey = () => new Date().toISOString().slice(0, 10)

export function DiaryWeek({ mode }: { mode: 'mine' | 'team' }) {
  const isMobile = useIsMobile()
  const [week, setWeek] = useState(0)
  const [plans, setPlans] = useState<Plan[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [officers, setOfficers] = useState<PlanOfficer[]>([])
  const [loading, setLoading] = useState(true)
  const [planDay, setPlanDay] = useState<string | null>(null)
  const [planFor, setPlanFor] = useState<number | undefined>(undefined)

  const days = useMemo(() => weekFrom(week), [week])
  const from = days[0]
  const to = days[6]

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = new URLSearchParams({ from, to })
      if (mode === 'team') q.set('scope', 'team')
      const res = await apiFetch<any>(`/api/sales/visit-plans?${q.toString()}`)
      const d = res?.data ?? res
      setPlans(d?.plans ?? [])
      setFollowUps(d?.follow_ups ?? [])
      if (mode === 'team') setOfficers((d?.officers ?? []).map((o: any) => ({ id: o.id, full_name: o.full_name })))
    } catch {
      // A diary that cannot load must not take the dashboard down with it; the section
      // simply reads as empty, which is also what an officer with no plans sees.
      setPlans([]); setFollowUps([])
    } finally { setLoading(false) }
  }, [from, to, mode])
  useEffect(() => { load() }, [load])
  // Live: a supervisor dropping a visit into the week has to appear in it.
  useLiveData(load, { topics: ['sales_visits', 'activities'] })

  const byDay = useMemo(() => {
    const m = new Map<string, Plan[]>()
    for (const p of plans) {
      const k = (p.planned_for || '').slice(0, 10)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(p)
    }
    return m
  }, [plans])

  const followByDay = useMemo(() => {
    const m = new Map<string, FollowUp[]>()
    for (const f of followUps) {
      const k = (f.planned_for || '').slice(0, 10)
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(f)
    }
    return m
  }, [followUps])

  const weekLabel = week === 0 ? 'This Week' : week === 1 ? 'Next Week'
    : week === -1 ? 'Last Week' : `${new Date(from + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`

  function Chip({ p }: { p: Plan }) {
    const c = KIND_COLOUR[p.kind] ?? 'var(--txt3)'
    const done = p.status !== 'planned'
    const body = (
      <>
        {p.planned_at && (
          <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75, marginRight: 4 }}>
            {String(p.planned_at).slice(11, 16)}
          </span>
        )}
        {p.contact_name || p.title || 'Planned'}
      </>
    )
    const style: React.CSSProperties = {
      display: 'block', width: '100%', textAlign: 'left', fontSize: TEXT.xs, lineHeight: 1.3,
      padding: '3px 6px', borderRadius: RADIUS.sm, border: 'none', cursor: p.contact_id ? 'pointer' : 'default',
      background: `${c}1a`, color: done ? 'var(--txt3)' : c,
      textDecoration: done ? 'line-through' : undefined,
      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
    }
    return p.contact_id
      ? <Link to={`/sales/leads/${p.contact_id}`} style={style} title={p.title || undefined}>{body}</Link>
      : <span style={style}>{body}</span>
  }

  const rows: { key: string; label: string; officerId?: number; plans: Plan[] }[] =
    mode === 'team'
      ? officers.map(o => ({ key: String(o.id), label: o.full_name, officerId: o.id,
          plans: plans.filter(p => p.officer_id === o.id) }))
      : [{ key: 'mine', label: '', plans }]

  return (
    <SectionCard
      title={mode === 'team' ? 'The Team’s Week' : 'My Week'}
      subtitle={mode === 'team'
        ? 'Who is out, where, and whose week is empty'
        : 'What you have planned, and the follow-ups your leads are due'}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Button size="xs" variant="secondary" icon="chevron_left" onClick={() => setWeek(w => w - 1)} />
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', minWidth: 66, textAlign: 'center' }}>
            {weekLabel}
          </span>
          <Button size="xs" variant="secondary" icon="chevron_right" onClick={() => setWeek(w => w + 1)} />
          <Button size="xs" variant="secondary" icon="add"
            onClick={() => { setPlanFor(undefined); setPlanDay(todayKey()) }}>Plan</Button>
          <Link to="/sales/calendar" style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, marginLeft: 4 }}>
            Full Month
          </Link>
        </div>
      }
    >
      {loading && plans.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}><Spinner size={20} /></div>
      ) : mode === 'team' && officers.length === 0 ? (
        <EmptyState icon="groups" title="No Team Yet"
          description="Add officers to a team to plan their week from here." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          {/* An empty week rendered as a blank seven-column grid reads as broken rather
              than as empty — and app.sales_visit_plans has never held a row, so this is
              the state everybody sees. The grid stays, because it is the thing you plan
              INTO; the line says why it is bare. */}
          {plans.length === 0 && (
            <div style={{
              marginBottom: SP[3], padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md,
              background: 'var(--bg2)', border: '1px solid var(--bdr)',
              fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6,
            }}>
              <b style={{ color: 'var(--txt)' }}>Nothing planned this week.</b>{' '}
              {mode === 'team'
                ? 'Plan a visit for an officer and it appears on their row here, and on their own diary.'
                : 'Plan a visit and it appears here, and on your head’s team week.'}
            </div>
          )}
          <div style={{ minWidth: isMobile ? 640 : undefined }}>
            {/* Day headings */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: (mode === 'team' ? '132px ' : '') + 'repeat(7, minmax(0, 1fr))',
              gap: 6, marginBottom: 6,
            }}>
              {mode === 'team' && <div />}
              {days.map((d, i) => {
                const isToday = d === todayKey()
                return (
                  <div key={d} style={{
                    fontSize: TEXT.xs, fontWeight: isToday ? FW.bold : FW.semibold,
                    color: isToday ? NAVY : 'var(--txt3)', textAlign: 'center',
                    textTransform: 'uppercase', letterSpacing: '0.04em',
                  }}>
                    {DAY_LABEL[i]} {Number(d.slice(8, 10))}
                  </div>
                )
              })}
            </div>

            {rows.map(row => (
              <div key={row.key} style={{
                display: 'grid',
                gridTemplateColumns: (mode === 'team' ? '132px ' : '') + 'repeat(7, minmax(0, 1fr))',
                gap: 6, marginBottom: 6, alignItems: 'stretch',
              }}>
                {mode === 'team' && (
                  <div style={{
                    fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)',
                    display: 'flex', alignItems: 'center', minWidth: 0,
                    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                  }}>{row.label}</div>
                )}
                {days.map(d => {
                  const items = (mode === 'team'
                    ? row.plans.filter(p => (p.planned_for || '').slice(0, 10) === d)
                    : byDay.get(d) ?? [])
                  const dues = mode === 'mine' ? (followByDay.get(d) ?? []) : []
                  const isToday = d === todayKey()
                  const weekend = [5, 6].includes(days.indexOf(d))
                  return (
                    <button key={d}
                      onClick={() => { setPlanFor(row.officerId); setPlanDay(d) }}
                      title={`Plan something for ${d}`}
                      style={{
                        minHeight: 64, padding: 5, textAlign: 'left', cursor: 'pointer',
                        borderRadius: RADIUS.md,
                        border: isToday ? `1.5px solid ${NAVY}` : '1px solid var(--bdr)',
                        background: weekend ? 'var(--row-hvr)' : 'var(--card)',
                        display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
                      }}>
                      {items.slice(0, 3).map(p => <Chip key={p.id} p={p} />)}
                      {dues.slice(0, 2).map(f => (
                        <span key={'f' + f.contact_id} style={{
                          fontSize: TEXT.xs, lineHeight: 1.3, padding: '3px 6px', borderRadius: RADIUS.sm,
                          background: `${AMBER}1a`, color: d < todayKey() ? RED : AMBER,
                          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                        }}>{f.contact_name || 'Follow-up'}</span>
                      ))}
                      {items.length + dues.length === 0 && (
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', opacity: 0.6 }}>—</span>
                      )}
                      {items.length + dues.length > 5 && (
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
                          +{items.length + dues.length - 5} more
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {planDay && (
        <PlanVisitModal
          day={planDay}
          officerId={planFor}
          officers={mode === 'team' ? officers : undefined}
          onClose={() => setPlanDay(null)}
          onDone={() => { setPlanDay(null); load() }}
        />
      )}
    </SectionCard>
  )
}
