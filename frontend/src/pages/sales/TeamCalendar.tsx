import { useCallback, useEffect, useMemo, useState } from 'react'
import { SectionCard, Button, Spinner, Avatar, EmptyState } from '../../components/UI'
import { Drawer } from '../../components/Drawer'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, PURPLE, BLUE, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtNum, fmtDate } from '../../lib/fmt'

// The team calendar — a month of the floor, one row per officer.
//
// What a head needs from this page is not a total. It is "who is working, who has gone
// quiet, and what did Tuesday actually look like for Justina" — and until the daily log
// existed (migration 307) none of that was answerable, because an officer's visits and
// calls were never written down anywhere.
//
// THE THREE STATES OF A DAY, and why a simple submitted/not-submitted mark is not enough:
//
//   submitted          the officer signed the day off       — green
//   worked, no report  entries logged, no report yet        — amber: in progress, or forgotten
//   nothing at all     no entries, no report                — blank: the one to ask about
//
// A two-state mark would fold the middle case into "not submitted" and put an officer who
// logged nine visits in the same bucket as one who was not seen all day. Those are
// opposite problems and only one of them needs a conversation.
//
// Weekends are dimmed rather than hidden: a blank Saturday is expected, and a worked
// Saturday is worth seeing.

interface DayCell {
  officer_id: number
  officer_name: string
  day: string
  activities: number
  visits: number
  calls: number
  meetings: number
  notes: number
  contacts_touched: number
  report_submitted: boolean
  submitted_at?: string | null
}
interface Officer { id: number; full_name: string; role?: string }

interface DayDetail {
  officer_id: number
  officer_name: string
  day: string
  report: { summary: string; plan: string; submitted_at?: string | null } | null
  activities: Array<{
    id: number; type: string; subject: string; body?: string; outcome?: string
    location?: string; contact_name?: string | null; occurred_at: string
  }>
}

const TYPE_ICON: Record<string, string> = {
  visit: 'location_on', call: 'call', meeting: 'groups', note: 'sticky_note_2',
}
const TYPE_COLOR: Record<string, string> = {
  visit: PURPLE, call: BLUE, meeting: NAVY, note: 'var(--txt3)',
}

/** Every day in the month of `anchor`, as YYYY-MM-DD. */
function monthDays(anchor: Date): string[] {
  const y = anchor.getFullYear(), m = anchor.getMonth()
  const last = new Date(y, m + 1, 0).getDate()
  const out: string[] = []
  for (let d = 1; d <= last; d++) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  }
  return out
}
const isWeekend = (iso: string) => {
  const d = new Date(iso + 'T00:00:00').getDay()
  return d === 0 || d === 6
}

export function TeamCalendar() {
  const [anchor, setAnchor] = useState(() => new Date())
  const [cells, setCells] = useState<DayCell[]>([])
  const [officers, setOfficers] = useState<Officer[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<{ officerId: number; day: string } | null>(null)

  const days = useMemo(() => monthDays(anchor), [anchor])
  const from = days[0]
  const to = days[days.length - 1]

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch<{ days: DayCell[]; officers: Officer[] }>(
        `/api/sales/team-days?from=${from}&to=${to}`)
      setCells(r?.days ?? [])
      setOfficers(r?.officers ?? [])
    } catch (e: any) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { load() }, [load])

  // officer_id → day → cell, so the grid is O(1) per square instead of scanning.
  const byOfficer = useMemo(() => {
    const m = new Map<number, Map<string, DayCell>>()
    cells.forEach(c => {
      const day = (c.day || '').slice(0, 10)
      if (!m.has(c.officer_id)) m.set(c.officer_id, new Map())
      m.get(c.officer_id)!.set(day, c)
    })
    return m
  }, [cells])

  const monthLabel = anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
  const today = new Date().toISOString().slice(0, 10)

  // Only days up to today count towards "missing": a head should not see the rest of the
  // month flagged as unreported on the 3rd.
  const elapsed = days.filter(d => d <= today && !isWeekend(d))
  const totals = useMemo(() => {
    let submitted = 0, worked = 0, silent = 0
    officers.forEach(o => {
      const m = byOfficer.get(o.id)
      elapsed.forEach(d => {
        const c = m?.get(d)
        if (c?.report_submitted) submitted++
        else if (c && c.activities > 0) worked++
        else silent++
      })
    })
    return { submitted, worked, silent }
  }, [officers, byOfficer, elapsed])

  function shift(months: number) {
    setAnchor(a => new Date(a.getFullYear(), a.getMonth() + months, 1))
  }

  return (
    <SectionCard
      title="Team Calendar"
      subtitle={`${monthLabel} · a square per officer per day — click one to read the day`}
      padding={false}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Button size="sm" variant="secondary" icon="chevron_left" onClick={() => shift(-1)}>Prev</Button>
          <Button size="sm" variant="secondary" onClick={() => setAnchor(new Date())}>This Month</Button>
          <Button size="sm" variant="secondary" iconRight="chevron_right" onClick={() => shift(1)}>Next</Button>
        </div>
      }
    >
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '50px 0' }}><Spinner size={24} /></div>
      ) : officers.length === 0 ? (
        <div style={{ padding: SP[4] }}>
          <EmptyState icon="groups" title="No officers to show"
            description="You are not set as head of a team yet, so there is no floor to display. Teams are set up on the Teams page." />
        </div>
      ) : (
        <>
          {/* Legend + tallies. The three numbers are the page's actual summary: how much
              of the month is accounted for, and how much is not. */}
          <div style={{
            display: 'flex', gap: SP[4], flexWrap: 'wrap', alignItems: 'center',
            padding: `${SP[3]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)',
          }}>
            <Legend color={GREEN} label="Day submitted" count={totals.submitted} />
            <Legend color={AMBER} label="Worked, not submitted" count={totals.worked} />
            <Legend color="var(--bdr)" label="Nothing logged" count={totals.silent} />
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              Weekdays up to today only
            </span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
              <thead>
                <tr>
                  <th style={{
                    position: 'sticky', left: 0, zIndex: 2, background: 'var(--card)',
                    textAlign: 'left', padding: `${SP[2]} ${SP[4]}`, fontSize: TEXT.xs,
                    fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase',
                    letterSpacing: '.04em', borderBottom: '1px solid var(--bdr)', minWidth: 180,
                  }}>Officer</th>
                  {days.map(d => (
                    <th key={d} title={fmtDate(d)} style={{
                      padding: '6px 0', width: 26, fontSize: TEXT['2xs'],
                      fontWeight: d === today ? FW.bold : FW.normal,
                      color: d === today ? NAVY : isWeekend(d) ? 'var(--txt3)' : 'var(--txt2)',
                      borderBottom: '1px solid var(--bdr)',
                    }}>{Number(d.slice(8, 10))}</th>
                  ))}
                  <th style={{
                    padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.xs, fontWeight: FW.semibold,
                    color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em',
                    borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
                  }}>Logged</th>
                </tr>
              </thead>
              <tbody>
                {officers.map(o => {
                  const m = byOfficer.get(o.id)
                  const monthTotal = days.reduce((s, d) => s + (m?.get(d)?.activities ?? 0), 0)
                  return (
                    <tr key={o.id}>
                      <td style={{
                        position: 'sticky', left: 0, zIndex: 1, background: 'var(--card)',
                        padding: `${SP[2]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                          <Avatar name={o.full_name} size={22} />
                          <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', whiteSpace: 'nowrap' }}>
                            {o.full_name}
                          </span>
                        </div>
                      </td>
                      {days.map(d => (
                        <td key={d} style={{ padding: 1, borderBottom: '1px solid var(--bdr)', textAlign: 'center' }}>
                          <DaySquare cell={m?.get(d)} day={d} today={today}
                            onClick={() => setOpen({ officerId: o.id, day: d })} />
                        </td>
                      ))}
                      <td style={{
                        padding: `${SP[2]} ${SP[3]}`, borderBottom: '1px solid var(--bdr)',
                        textAlign: 'right',
                      }}>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: monthTotal ? 'var(--txt)' : 'var(--txt3)' }}>
                          {fmtNum(monthTotal)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {open && (
        <DayDrawer officerId={open.officerId} day={open.day} onClose={() => setOpen(null)} />
      )}
    </SectionCard>
  )
}

function Legend({ color, label, count }: { color: string; label: string; count: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
      <span style={{ width: 11, height: 11, borderRadius: 3, background: color, flexShrink: 0 }} />
      {label} <strong style={{ ...NUM, color: 'var(--txt)' }}>{fmtNum(count)}</strong>
    </span>
  )
}

/** One square. Colour says the state; the tooltip says the detail without a click. */
function DaySquare({ cell, day, today, onClick }: {
  cell?: DayCell; day: string; today: string; onClick: () => void
}) {
  const future = day > today
  const weekend = isWeekend(day)
  const submitted = !!cell?.report_submitted
  const worked = !!cell && cell.activities > 0

  const bg = submitted ? GREEN : worked ? AMBER : future ? 'transparent' : weekend ? 'var(--bg)' : 'var(--bdr)'
  const title = future
    ? fmtDate(day)
    : submitted
      ? `${fmtDate(day)} — day submitted, ${cell!.activities} logged`
      : worked
        ? `${fmtDate(day)} — ${cell!.activities} logged, not submitted`
        : `${fmtDate(day)} — nothing logged`

  return (
    <button
      type="button" onClick={future ? undefined : onClick} title={title} aria-label={title}
      disabled={future}
      style={{
        width: 20, height: 20, borderRadius: 4, background: bg,
        border: day === today ? `2px solid ${NAVY}` : '1px solid transparent',
        cursor: future ? 'default' : 'pointer', padding: 0, display: 'block',
        opacity: future ? 0.35 : weekend && !worked && !submitted ? 0.5 : 1,
      }}
    />
  )
}

// ── One day, in full ──────────────────────────────────────────────────────────

function DayDrawer({ officerId, day, onClose }: { officerId: number; day: string; onClose: () => void }) {
  const [data, setData] = useState<DayDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiFetch<DayDetail>(`/api/sales/team-days/${officerId}/${day}`)
      .then(setData)
      .catch((e: any) => toast.error(e.message))
      .finally(() => setLoading(false))
  }, [officerId, day])

  return (
    <Drawer open onClose={onClose} title={`${data?.officer_name ?? 'Officer'} · ${fmtDate(day)}`}>
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '50px 0' }}><Spinner size={24} /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {/* The officer's own account first — it is the thing a head opened this to read.
              An unsubmitted day says so rather than showing an empty box. */}
          <div style={{
            padding: SP[3], borderRadius: RADIUS.lg,
            background: data?.report?.submitted_at ? `${GREEN}0A` : 'var(--bg)',
            border: `1px solid ${data?.report?.submitted_at ? `${GREEN}33` : 'var(--bdr)'}`,
          }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
              {data?.report?.submitted_at ? 'Day Report' : 'Day Report — Not Submitted'}
            </div>
            {data?.report?.summary
              ? <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{data.report.summary}</div>
              : <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
                  {(data?.activities?.length ?? 0) > 0
                    ? 'Work was logged but the day was never signed off.'
                    : 'Nothing was logged and no report was filed for this day.'}
                </div>}
            {data?.report?.plan && (
              <>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', marginTop: SP[3], marginBottom: 3 }}>What's next</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'pre-wrap' }}>{data.report.plan}</div>
              </>
            )}
          </div>

          <div>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: SP[2] }}>
              Logged Activity {data?.activities?.length ? `(${data.activities.length})` : ''}
            </div>
            {!data?.activities?.length ? (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No entries for this day.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {data.activities.map(a => (
                  <div key={a.id} style={{
                    display: 'flex', gap: SP[3], padding: `${SP[2]} 0`,
                    borderBottom: '1px solid var(--bdr)', alignItems: 'flex-start',
                  }}>
                    <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', minWidth: 42, paddingTop: 2 }}>
                      {new Date(a.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="material-symbols-rounded" aria-hidden style={{
                      fontSize: 17, color: TYPE_COLOR[a.type] ?? 'var(--txt3)', flexShrink: 0, marginTop: 1,
                    }}>{TYPE_ICON[a.type] ?? 'circle'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)' }}>{a.subject}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>
                        {a.location && <>{a.location} · </>}
                        {a.contact_name && <>{a.contact_name} · </>}
                        {a.outcome || a.type}
                      </div>
                      {a.body && (
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{a.body}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  )
}

export default TeamCalendar
