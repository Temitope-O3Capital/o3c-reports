import { useCallback, useEffect, useMemo, useState } from 'react'
import { SectionCard, Button, Spinner, EmptyState, Avatar } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtDate } from '../../lib/fmt'
import { useLiveData } from '../../hooks/useRealtime'

// Daily Reports — what the sales floor did on a day, written out to be READ.
//
// WHY THIS IS NOT THE TEAM CALENDAR. TeamCalendar is a month of coloured squares: it answers
// "did this person work" and stops. A green square cannot say what the officer did, which
// customer they saw, or what came of it — and that is the whole question an MD opens this
// for. Here the day is composed into detail: every visit with where it was, every call with
// its outcome, every lead that moved, and the officer's own note on top.
//
// WHY THE DAY IS COMPOSED, NOT SUBMITTED. app.sales_daily_reports has never held a row and
// the summary field was made optional on purpose — asking an officer to write up a day they
// have already logged is asking them to type it twice, and the second telling is the one
// that gets skipped. So the activity IS the report, and the note is commentary on it.
//
// THE FOUR STATES NEVER MERGE INTO ONE NUMBER. "Worked", "quiet", "away" and "no access"
// demand opposite responses from a reader. An officer who cannot sign in is not idle, and
// somebody on approved leave is not quiet — the server decides those from app.is_unavailable
// and app.business_calendar, so a declared public holiday can never render as a missed day.
// The first time a page like this tells the MD somebody was quiet during a week they were on
// signed-off leave, it is finished as a management tool.

interface Entry {
  type: string
  subject: string
  body?: string
  outcome?: string
  location?: string
  customer?: string
  at: string
}

interface Officer {
  officer_id: number
  officer_name: string
  role: string
  office: string
  state: 'worked' | 'quiet' | 'away' | 'no_access'
  activities: number
  visits: number
  calls: number
  meetings: number
  notes: number
  emails: number
  moves: number
  customers_touched: number
  live_leads: number
  overdue_followups: number
  own_note?: string
  own_plan?: string
  last_activity_at?: string
  working_day: boolean
  entries: Entry[]
  note_count: number
  open_threads: number
}

interface Payload {
  date: string
  working_day: boolean
  officers: Officer[]
  summary: { total: number; worked: number; quiet: number; away: number; no_access: number }
}

const STATE_META: Record<Officer['state'], { label: string; colour: string; rank: number }> = {
  worked:    { label: 'Worked',     colour: GREEN, rank: 0 },
  quiet:     { label: 'Quiet',      colour: AMBER, rank: 1 },
  away:      { label: 'Away',       colour: 'var(--txt3)', rank: 2 },
  no_access: { label: 'No access',  colour: RED,   rank: 3 },
}

const KIND_ICON: Record<string, string> = {
  visit: 'directions_walk', call: 'call', meeting: 'groups', email: 'mail',
  note: 'sticky_note_2', interested: 'thumb_up', handed_to_sales: 'forward',
  documents_requested: 'description', application_submitted: 'assignment_turned_in',
  approved: 'verified',
}

const EYEBROW = {
  fontSize: TEXT['2xs'],
  fontWeight: FW.semibold,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--txt3)',
}

/** YYYY-MM-DD for a Date, in LOCAL terms — toISOString() would shift Lagos back a day. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return isoDay(new Date(y, m - 1, d + days))
}

export default function DailyReports() {
  // Yesterday by default, which is what the server defaults to as well. A day read at 10am
  // is half a day, and an officer judged on it looks idle for the ordinary reason that the
  // morning is not over.
  const [date, setDate] = useState(() => shiftDay(isoDay(new Date()), -1))
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<Set<number>>(new Set())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await apiFetch<{ data: Payload }>(
        `/api/sales/daily-reports?date=${encodeURIComponent(date)}`)
      setData(r.data ?? null)
      // Open the ones with something to read. An MD should not have to click to find the
      // work; they should have to click to dismiss the absence of it.
      setOpen(new Set((r.data?.officers ?? [])
        .filter(o => o.entries.length > 0).map(o => o.officer_id)))
    } catch {
      toast.error('Could not load the day')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { void load() }, [load])
  useLiveData(() => void load(true), { topics: ['activities', 'crm', 'sales_visits'] })

  const officers = useMemo(() => {
    const list = [...(data?.officers ?? [])]
    // Worked first, then quiet, then away, then no access; most activity first within a
    // band, and alphabetical where that ties.
    list.sort((a, b) =>
      STATE_META[a.state].rank - STATE_META[b.state].rank ||
      b.activities - a.activities ||
      a.officer_name.localeCompare(b.officer_name))
    return list
  }, [data])

  const today = isoDay(new Date())
  const s = data?.summary

  return (
    <div style={{ display: 'grid', gap: SP[5] }}>
      <header style={{ borderBottom: `2px solid ${NAVY}`, paddingBottom: SP[3] }}>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: SP[3],
          alignItems: 'baseline', justifyContent: 'space-between',
        }}>
          <h1 style={{
            margin: 0, fontSize: TEXT['2xl'], fontWeight: FW.semibold, color: 'var(--txt)',
          }}>Daily Reports</h1>
          <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }}>
            <Button variant="secondary" size="sm" onClick={() => setDate(d => shiftDay(d, -1))}>
              ‹ Previous
            </Button>
            <input
              type="date" value={date} max={today}
              onChange={e => { if (e.target.value) setDate(e.target.value) }}
              style={{
                fontSize: TEXT.sm, padding: `6px ${SP[2]}`, borderRadius: RADIUS.md,
                border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
                color: 'var(--txt)',
              }}
            />
            <Button
              variant="secondary" size="sm"
              disabled={shiftDay(date, 1) > today}
              onClick={() => setDate(d => shiftDay(d, 1))}
            >Next ›</Button>
          </div>
        </div>

        {/* One line of state. The four never sum into a single "attendance" figure. */}
        <div style={{
          marginTop: SP[3], display: 'flex', flexWrap: 'wrap',
          gap: `${SP[1]} ${SP[5]}`, fontSize: TEXT.sm, color: 'var(--txt2)',
        }}>
          <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{fmtDate(date)}</span>
          {s && <>
            <span><b style={{ ...NUM, color: GREEN }}>{s.worked}</b> of <b style={{ ...NUM, color: 'var(--txt)' }}>{s.total}</b> worked</span>
            {s.quiet > 0 && <span><b style={{ ...NUM, color: AMBER }}>{s.quiet}</b> quiet</span>}
            {s.away > 0 && <span><b style={{ ...NUM }}>{s.away}</b> away</span>}
            {s.no_access > 0 && (
              <span><b style={{ ...NUM, color: RED }}>{s.no_access}</b> cannot sign in</span>
            )}
          </>}
        </div>

        {data && !data.working_day && (
          <div style={{
            marginTop: SP[3], padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md,
            background: 'var(--bg2)', border: '1px solid var(--bdr)',
            fontSize: TEXT.xs, color: 'var(--txt2)',
          }}>
            <b style={{ color: 'var(--txt)' }}>Not a working day.</b>{' '}
            The business calendar has this as a weekend or a declared public holiday, so a
            blank day here is expected rather than missed.
          </div>
        )}
      </header>

      {loading ? (
        <div style={{ padding: SP[8], textAlign: 'center' }}><Spinner /></div>
      ) : officers.length === 0 ? (
        <EmptyState
          icon="groups"
          title="No Sales Roster To Report On"
          description="Nobody on the sales roster is in scope for this view. A head sees their own team; management sees the floor."
        />
      ) : officers.map(o => (
        <OfficerDay
          key={o.officer_id}
          o={o}
          expanded={open.has(o.officer_id)}
          onToggle={() => setOpen(prev => {
            const next = new Set(prev)
            next.has(o.officer_id) ? next.delete(o.officer_id) : next.add(o.officer_id)
            return next
          })}
        />
      ))}
    </div>
  )
}

function OfficerDay({ o, expanded, onToggle }: {
  o: Officer
  expanded: boolean
  onToggle: () => void
}) {
  const meta = STATE_META[o.state]
  const counts: { label: string; n: number }[] = [
    { label: 'Visits', n: o.visits }, { label: 'Calls', n: o.calls },
    { label: 'Meetings', n: o.meetings }, { label: 'Emails', n: o.emails },
    { label: 'Notes', n: o.notes }, { label: 'Lead moves', n: o.moves },
  ].filter(c => c.n > 0)

  return (
    <SectionCard padding={false} style={{ borderLeft: `3px solid ${meta.colour}` }}>
      <div style={{ padding: SP[4] }}>
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: SP[3],
          alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', gap: SP[3], alignItems: 'center', minWidth: 0 }}>
            <Avatar name={o.officer_name} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)',
              }}>{o.officer_name}</div>
              <div style={{ ...EYEBROW, marginTop: 1 }}>
                {o.role.replace(/_/g, ' ')} · {o.office || 'no office set'}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{
              ...NUM, fontSize: TEXT['2xs'], textTransform: 'uppercase', letterSpacing: '0.05em',
              padding: `2px ${SP[2]}`, borderRadius: RADIUS.sm,
              border: `1px solid ${meta.colour}`, color: meta.colour,
            }}>{meta.label}</span>
            {o.entries.length > 0 && (
              <Button variant="ghost" size="sm" onClick={onToggle}>
                {expanded ? 'Hide the day' : `Read the day (${o.entries.length})`}
              </Button>
            )}
          </div>
        </div>

        {/* The figures, only the ones that happened. A row of zeroes is noise. */}
        {counts.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: `${SP[2]} ${SP[5]}`,
            marginTop: SP[3], paddingTop: SP[3], borderTop: '1px solid var(--bdr)',
          }}>
            {counts.map(c => (
              <div key={c.label}>
                <div style={EYEBROW}>{c.label}</div>
                <div style={{
                  ...NUM, fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)',
                }}>{c.n}</div>
              </div>
            ))}
            <div>
              <div style={EYEBROW}>Customers</div>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                {o.customers_touched}
              </div>
            </div>
          </div>
        )}

        {/* Why the day is blank, said plainly, with the book they are carrying while it is. */}
        {o.activities === 0 && (
          <p style={{
            marginTop: SP[3], marginBottom: 0, fontSize: TEXT.sm, lineHeight: 1.6,
            color: 'var(--txt2)', maxWidth: '68ch',
          }}>
            {o.state === 'no_access'
              ? <>Nothing logged, and <b style={{ color: RED }}>no sign-in has ever been recorded</b> for
                  this account — so this is an access problem rather than an idle day. They are
                  carrying <b style={{ ...NUM, color: 'var(--txt)' }}>{o.live_leads}</b> live
                  leads{o.overdue_followups > 0 && <> with <b style={{ ...NUM, color: RED }}>{o.overdue_followups}</b> overdue follow-ups</>}, assigned
                  and therefore flagged by nothing else in the system.</>
              : o.state === 'away'
                ? <>Away on this date — recorded leave or unavailability — so nothing is expected.</>
                : !o.working_day
                  ? <>Nothing logged, and the business calendar does not count this as a working day.</>
                  : <>Nothing logged on a working day, carrying <b style={{ ...NUM, color: 'var(--txt)' }}>{o.live_leads}</b> live
                      leads{o.overdue_followups > 0 && <> and <b style={{ ...NUM, color: AMBER }}>{o.overdue_followups}</b> overdue follow-ups</>}.
                      {o.last_activity_at
                        ? <> Last activity on record: {fmtDate(o.last_activity_at)}.</>
                        : <> No activity on record at all.</>}</>}
          </p>
        )}

        {/* The officer's own words, kept visibly separate from what the system counted. */}
        {(o.own_note || o.own_plan) && (
          <div style={{
            marginTop: SP[3], padding: SP[3], borderRadius: RADIUS.md,
            background: 'var(--bg2)', borderLeft: `2px solid ${NAVY}`,
          }}>
            <div style={EYEBROW}>In their own words</div>
            {o.own_note && (
              <p style={{ margin: `${SP[1]} 0 0`, fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6 }}>
                {o.own_note}
              </p>
            )}
            {o.own_plan && (
              <p style={{ margin: `${SP[2]} 0 0`, fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6 }}>
                <b>Next:</b> {o.own_plan}
              </p>
            )}
          </div>
        )}
      </div>

      {expanded && o.entries.length > 0 && (
        <div style={{ borderTop: '1px solid var(--bdr)', background: 'var(--bg2)', padding: SP[4] }}>
          <div style={{ ...EYEBROW, marginBottom: SP[3] }}>The day, as it was logged</div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: SP[3] }}>
            {o.entries.map((e, i) => (
              <li key={i} style={{ display: 'flex', gap: SP[3], alignItems: 'flex-start' }}>
                <span style={{
                  ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)',
                  width: 42, flex: 'none', paddingTop: 3,
                }}>
                  {e.at ? new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                </span>
                <span className="material-symbols-rounded" style={{
                  fontSize: 17, color: NAVY, flex: 'none', paddingTop: 1,
                }}>{KIND_ICON[e.type] ?? 'radio_button_unchecked'}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>
                    {e.subject || e.type.replace(/_/g, ' ')}
                    {e.customer && <span style={{ color: 'var(--txt2)', fontWeight: FW.normal }}> · {e.customer}</span>}
                  </div>
                  {(e.outcome || e.location) && (
                    <div style={{ ...EYEBROW, marginTop: 2, letterSpacing: '0.04em' }}>
                      {[e.outcome?.replace(/_/g, ' '), e.location].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {e.body && (
                    <p style={{
                      margin: `${SP[1]} 0 0`, fontSize: TEXT.xs, color: 'var(--txt2)',
                      lineHeight: 1.6, overflowWrap: 'anywhere', maxWidth: '72ch',
                    }}>{e.body}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </SectionCard>
  )
}
