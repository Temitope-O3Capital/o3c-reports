import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  SectionCard, Button, Spinner, EmptyState, Avatar, DataTable, StatusBadge,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { SelectMenu } from '../../components/SelectMenu'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtDate } from '../../lib/fmt'
import { useLiveData } from '../../hooks/useRealtime'

// Daily Reports — what the sales floor did on a day, written to be READ by the MD.
//
// WHY THE TABLE AND NOT A STACK OF CARDS. The first version of this page was a column of
// full-width cards. On a laptop that puts prose on 200-character lines, squeezes a 280px
// side panel against a 1fr body, and turns sixteen officers into endless scrolling with no
// way to scan — the "dimensions are off" complaint, and it was fair. This is the house
// table with its column-header filter menus, which is the idiom that already works here:
// one row per officer, scannable, filterable, sortable, and a row opens into the day.
//
// AND THE TYPE IS BIGGER ON PURPOSE. The old version set eyebrows at 11px and body at
// 12px, which is an engineer reading a dense console, not an MD reading a report. Names are
// 19px semibold, figures 23px bold, body 15px at 1.65 — one step up across the board, and
// the numbers carry weight because they are the thing being read.
//
// THE DAY IS COMPOSED, NOT SUBMITTED. app.sales_daily_reports has never held a row and the
// summary field is optional on purpose: asking an officer to write up a day they already
// logged is asking them to type it twice, and the second telling is the one that gets
// skipped. The activity IS the report; the note is commentary on it.
//
// FOUR STATES, NEVER ONE NUMBER. Worked, quiet, away and no access need opposite responses
// from a reader. An officer who cannot sign in is not idle, and somebody on approved leave
// is not quiet — the server decides those from app.is_unavailable and app.business_calendar,
// so a declared public holiday can never render as a missed day.

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

/** A row carries flat fields so the table's own filters and search can reach them. */
interface Row extends Officer {
  state_label: string
  office_label: string
}

const STATE_META: Record<Officer['state'], { label: string; colour: string; rank: number }> = {
  worked:    { label: 'Worked',    colour: GREEN,         rank: 0 },
  quiet:     { label: 'Quiet',     colour: AMBER,         rank: 1 },
  away:      { label: 'Away',      colour: 'var(--txt3)', rank: 2 },
  no_access: { label: 'No access', colour: RED,           rank: 3 },
}

const KIND_ICON: Record<string, string> = {
  visit: 'directions_walk', call: 'call', meeting: 'groups', email: 'mail',
  note: 'sticky_note_2', interested: 'thumb_up', handed_to_sales: 'forward',
  documents_requested: 'description', application_submitted: 'assignment_turned_in',
  approved: 'verified',
}

const EYEBROW = {
  fontSize: TEXT.xs,
  fontWeight: FW.semibold,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.07em',
  color: 'var(--txt3)',
}

/** YYYY-MM-DD in LOCAL terms — toISOString() would shift Lagos back a day. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return isoDay(new Date(y, m - 1, d + days))
}

export default function DailyReports() {
  // Yesterday, matching the server's default. A day read at 10am is half a day, and an
  // officer judged on it looks idle for the ordinary reason that the morning is not over.
  const [date, setDate] = useState(() => shiftDay(isoDay(new Date()), -1))
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<number | null>(null)
  const [rep, setRep] = useState('')
  const [stateFilter, setStateFilter] = useState('')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await apiFetch<{ data: Payload }>(
        `/api/sales/daily-reports?date=${encodeURIComponent(date)}`)
      setData(r.data ?? null)
    } catch {
      toast.error('Could not load the day')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { void load() }, [load])
  useLiveData(() => void load(true), { topics: ['activities', 'crm', 'sales_visits'] })
  // A different day is a different report; keep nothing expanded across the change.
  useEffect(() => { setOpenId(null) }, [date])

  const rows: Row[] = useMemo(() => {
    const list = (data?.officers ?? []).map(o => ({
      ...o,
      state_label: STATE_META[o.state].label,
      office_label: o.office || 'No office set',
    }))
    list.sort((a, b) =>
      STATE_META[a.state].rank - STATE_META[b.state].rank ||
      b.activities - a.activities ||
      a.officer_name.localeCompare(b.officer_name))
    return list
      .filter(r => !rep || String(r.officer_id) === rep)
      .filter(r => !stateFilter || r.state === stateFilter)
  }, [data, rep, stateFilter])

  const open = rows.find(r => r.officer_id === openId) ?? null
  const today = isoDay(new Date())
  const s = data?.summary

  const cols: TableCol<Row>[] = [
    {
      key: 'officer_name', label: 'Officer', sortable: true,
      render: r => (
        <div style={{ display: 'flex', gap: SP[3], alignItems: 'center', minWidth: 0 }}>
          <Avatar name={r.officer_name} size={38} />
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: TEXT.xl, fontWeight: FW.semibold, color: 'var(--txt)',
              lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{r.officer_name}</div>
            <div style={{ ...EYEBROW, marginTop: 2 }}>
              {r.role.replace(/_/g, ' ')} · {r.office_label}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'state_label', label: 'Day', sortable: true, width: 130,
      render: r => (
        <span style={{
          ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, textTransform: 'uppercase',
          letterSpacing: '0.05em', padding: `3px ${SP[2]}`, borderRadius: RADIUS.sm,
          border: `1px solid ${STATE_META[r.state].colour}`, color: STATE_META[r.state].colour,
          whiteSpace: 'nowrap',
        }}>{STATE_META[r.state].label}</span>
      ),
    },
    {
      key: 'activities', label: 'Work Logged', sortable: true, align: 'right', width: 150,
      render: r => (
        <div>
          <div style={{
            ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold,
            color: r.activities > 0 ? 'var(--txt)' : 'var(--txt3)', lineHeight: 1.1,
          }}>{r.activities}</div>
          {r.activities > 0 && (
            <div style={{ ...EYEBROW, marginTop: 2, letterSpacing: '0.04em' }}>
              {[
                r.visits && `${r.visits} visit${r.visits === 1 ? '' : 's'}`,
                r.calls && `${r.calls} call${r.calls === 1 ? '' : 's'}`,
                r.meetings && `${r.meetings} mtg`,
                r.emails && `${r.emails} email`,
                r.moves && `${r.moves} moved`,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'live_leads', label: 'Live Book', sortable: true, align: 'right', width: 130,
      render: r => (
        <div>
          <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.semibold, color: 'var(--txt)' }}>
            {r.live_leads}
          </div>
          {r.overdue_followups > 0 && (
            <div style={{ ...EYEBROW, marginTop: 2, color: RED, letterSpacing: '0.04em' }}>
              {r.overdue_followups} overdue
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'last_activity_at', label: 'Last Seen', sortable: true, width: 120,
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.base, color: 'var(--txt2)' }}>
          {r.last_activity_at ? fmtDate(r.last_activity_at) : '—'}
        </span>
      ),
    },
    {
      key: '_open', label: '', sortable: false, width: 60, align: 'right',
      render: r => (
        <span className="material-symbols-rounded" style={{
          fontSize: 22, color: openId === r.officer_id ? NAVY : 'var(--txt3)',
        }}>{openId === r.officer_id ? 'expand_less' : 'expand_more'}</span>
      ),
    },
  ]

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto', display: 'grid', gap: SP[5] }}>
      <header>
        <h1 style={{
          margin: 0, fontSize: TEXT['3xl'], fontWeight: FW.bold,
          color: 'var(--txt)', letterSpacing: '-0.01em',
        }}>Daily Reports</h1>
        <p style={{
          margin: `${SP[1]} 0 0`, fontSize: TEXT.md, color: 'var(--txt2)', lineHeight: 1.6,
          maxWidth: '72ch',
        }}>
          What the sales floor did on a day, composed from what they logged. Open a row to
          read the day as it happened.
        </p>
      </header>

      {/* Toolbar: the day, and who to look at. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: SP[3], alignItems: 'center',
        padding: SP[3], borderRadius: RADIUS.md,
        background: 'var(--card)', border: '1px solid var(--bdr)',
      }}>
        <div style={{ display: 'flex', gap: SP[1], alignItems: 'center' }}>
          <Button variant="secondary" icon="chevron_left"
            onClick={() => setDate(d => shiftDay(d, -1))}>Previous</Button>
          <input
            type="date" value={date} max={today}
            onChange={e => { if (e.target.value) setDate(e.target.value) }}
            style={{
              fontSize: TEXT.md, fontWeight: FW.medium, padding: `8px ${SP[3]}`,
              borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)',
              background: 'var(--input-bg)', color: 'var(--txt)',
            }}
          />
          <Button variant="secondary" icon="chevron_right"
            disabled={shiftDay(date, 1) > today}
            onClick={() => setDate(d => shiftDay(d, 1))}>Next</Button>
        </div>

        <div style={{ width: 230 }}>
          <SelectMenu
            value={rep} onChange={setRep} searchable
            options={(data?.officers ?? [])
              .slice()
              .sort((a, b) => a.officer_name.localeCompare(b.officer_name))
              .map(o => ({
                value: String(o.officer_id), label: o.officer_name,
                hint: STATE_META[o.state].label,
              }))}
            clearLabel="All Sales Reps"
            ariaLabel="Filter by sales rep" leadingIcon="person"
          />
        </div>

        <div style={{ width: 190 }}>
          <SelectMenu
            value={stateFilter} onChange={setStateFilter}
            options={(['worked', 'quiet', 'away', 'no_access'] as const).map(k => ({
              value: k, label: STATE_META[k].label,
              hint: String((data?.officers ?? []).filter(o => o.state === k).length),
            }))}
            clearLabel="Any Day State"
            ariaLabel="Filter by the state of the day" leadingIcon="filter_list"
          />
        </div>

        <div style={{ marginLeft: 'auto', fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          {fmtDate(date)}
        </div>
      </div>

      {/* The four states, large, and never summed into one attendance figure. */}
      {s && (
        <div style={{
          display: 'grid', gap: SP[3],
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        }}>
          <Figure label="Worked" value={s.worked} of={s.total} colour={GREEN} />
          <Figure label="Quiet" value={s.quiet} colour={AMBER} />
          <Figure label="Away" value={s.away} colour="var(--txt2)" />
          <Figure label="Cannot sign in" value={s.no_access} colour={RED} />
        </div>
      )}

      {data && !data.working_day && (
        <div style={{
          padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md,
          background: 'var(--bg2)', borderLeft: `3px solid ${NAVY}`,
          fontSize: TEXT.md, color: 'var(--txt2)', lineHeight: 1.6,
        }}>
          <b style={{ color: 'var(--txt)' }}>Not a working day.</b>{' '}
          The business calendar has this as a weekend or a declared public holiday, so a
          blank day here is expected rather than missed.
        </div>
      )}

      {loading ? (
        <div style={{ padding: SP[10], textAlign: 'center' }}><Spinner /></div>
      ) : (
        <DataTable<Row>
          cols={cols}
          rows={rows}
          keyFn={r => r.officer_id}
          onRowClick={r => setOpenId(id => (id === r.officer_id ? null : r.officer_id))}
          searchKeys={['officer_name', 'office_label']}
          searchPlaceholder="Search a sales rep…"
          filters={[
            { key: 'state_label', label: 'Day' },
            { key: 'office_label', label: 'Office' },
          ]}
          emptyText={
            <EmptyState
              icon="groups"
              title="Nobody To Report On"
              description="No officer matches these filters. A head sees their own team; management sees the floor."
            />
          }
        />
      )}

      {/* The day in full, expanded under the table and collapsible from the row. */}
      {open && <OfficerDay o={open} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function Figure({ label, value, of, colour }: {
  label: string; value: number; of?: number; colour: string
}) {
  return (
    <SectionCard padding={false}>
      <div style={{ padding: `${SP[4]} ${SP[4]}` }}>
        <div style={EYEBROW}>{label}</div>
        <div style={{
          ...NUM, marginTop: SP[1], fontSize: TEXT['3xl'], fontWeight: FW.bold,
          color: value > 0 ? colour : 'var(--txt3)', lineHeight: 1.05,
        }}>
          {value}{of !== undefined && (
            <span style={{ fontSize: TEXT.lg, fontWeight: FW.medium, color: 'var(--txt3)' }}>
              {' '}of {of}
            </span>
          )}
        </div>
      </div>
    </SectionCard>
  )
}

function OfficerDay({ o, onClose }: { o: Officer; onClose: () => void }) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? o.entries : o.entries.slice(0, 12)

  return (
    <SectionCard padding={false} style={{ borderTop: `3px solid ${NAVY}` }}>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: SP[3], alignItems: 'center',
        justifyContent: 'space-between', padding: `${SP[4]} ${SP[5]}`,
        borderBottom: '1px solid var(--bdr)',
      }}>
        <div style={{ display: 'flex', gap: SP[3], alignItems: 'center' }}>
          <Avatar name={o.officer_name} size={44} />
          <div>
            <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)' }}>
              {o.officer_name}
            </div>
            <div style={{ ...EYEBROW, marginTop: 2 }}>
              {o.role.replace(/_/g, ' ')} · {o.office || 'No office set'} ·{' '}
              {o.entries.length} entr{o.entries.length === 1 ? 'y' : 'ies'}
            </div>
          </div>
        </div>
        <Button variant="secondary" icon="close" onClick={onClose}>Collapse</Button>
      </div>

      <div style={{ padding: SP[5], display: 'grid', gap: SP[5] }}>
        {/* Why a blank day is blank, said plainly, with the book carried while it is. */}
        {o.activities === 0 && (
          <p style={{
            margin: 0, fontSize: TEXT.md, lineHeight: 1.7, color: 'var(--txt2)', maxWidth: '76ch',
          }}>
            {o.state === 'no_access'
              ? <>Nothing logged, and <b style={{ color: RED }}>no sign-in has ever been recorded</b> for
                  this account — an access problem rather than an idle day. They are carrying{' '}
                  <b style={{ ...NUM, color: 'var(--txt)' }}>{o.live_leads}</b> live leads
                  {o.overdue_followups > 0 && <> with <b style={{ ...NUM, color: RED }}>{o.overdue_followups}</b> overdue follow-ups</>},
                  assigned and therefore flagged by nothing else in the system.</>
              : o.state === 'away'
                ? <>Away on this date — recorded leave or unavailability — so nothing is expected.</>
                : !o.working_day
                  ? <>Nothing logged, and the business calendar does not count this as a working day.</>
                  : <>Nothing logged on a working day, carrying{' '}
                      <b style={{ ...NUM, color: 'var(--txt)' }}>{o.live_leads}</b> live leads
                      {o.overdue_followups > 0 && <> and <b style={{ ...NUM, color: AMBER }}>{o.overdue_followups}</b> overdue follow-ups</>}.
                      {o.last_activity_at
                        ? <> Last activity on record: {fmtDate(o.last_activity_at)}.</>
                        : <> No activity on record at all.</>}</>}
          </p>
        )}

        {/* Their own words, kept visibly apart from what the system counted. */}
        {(o.own_note || o.own_plan) && (
          <div style={{
            padding: SP[4], borderRadius: RADIUS.md,
            background: 'var(--bg2)', borderLeft: `3px solid ${NAVY}`,
          }}>
            <div style={EYEBROW}>In their own words</div>
            {o.own_note && (
              <p style={{
                margin: `${SP[2]} 0 0`, fontSize: TEXT.lg, lineHeight: 1.65,
                color: 'var(--txt)', maxWidth: '72ch',
              }}>{o.own_note}</p>
            )}
            {o.own_plan && (
              <p style={{
                margin: `${SP[3]} 0 0`, fontSize: TEXT.base, lineHeight: 1.65, color: 'var(--txt2)',
              }}><b style={{ color: 'var(--txt)' }}>Next:</b> {o.own_plan}</p>
            )}
          </div>
        )}

        {/* THIS IS THE REPORT, and it has to say so. app.sales_daily_reports holds zero
            rows and always has, so own_note is NULL for every officer on every day — which
            meant the "in their own words" panel never rendered and the expansion opened
            onto a bare list under a quiet heading. A reader looking for "the report" found
            no report. The day composed from logged work IS the report on this floor; the
            heading now states that, and the absence of a written note is stated rather
            than left as a gap. */}
        {o.entries.length > 0 && (
          <div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: SP[2],
              alignItems: 'baseline', marginBottom: SP[3],
            }}>
              <h3 style={{
                margin: 0, fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)',
              }}>The Report</h3>
              <span style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>
                composed from the {o.entries.length} thing{o.entries.length === 1 ? '' : 's'} they
                logged · {[
                  o.visits && `${o.visits} visit${o.visits === 1 ? '' : 's'}`,
                  o.calls && `${o.calls} call${o.calls === 1 ? '' : 's'}`,
                  o.meetings && `${o.meetings} meeting${o.meetings === 1 ? '' : 's'}`,
                  o.emails && `${o.emails} email${o.emails === 1 ? '' : 's'}`,
                  o.notes && `${o.notes} note${o.notes === 1 ? '' : 's'}`,
                  o.moves && `${o.moves} lead move${o.moves === 1 ? '' : 's'}`,
                ].filter(Boolean).join(', ')}
              </span>
            </div>
            {!o.own_note && (
              <p style={{
                margin: `0 0 ${SP[4]}`, fontSize: TEXT.base, color: 'var(--txt3)',
                lineHeight: 1.65, fontStyle: 'italic', maxWidth: '72ch',
              }}>
                No end-of-day note was written, and none is expected — officers are not asked
                to type up a day they have already logged. What follows is the day itself.
              </p>
            )}
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: SP[4] }}>
              {shown.map((e, i) => (
                <li key={i} style={{ display: 'flex', gap: SP[4], alignItems: 'flex-start' }}>
                  <span style={{
                    ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt3)',
                    width: 52, flex: 'none', paddingTop: 2,
                  }}>
                    {e.at ? new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                  </span>
                  <span className="material-symbols-rounded" style={{
                    fontSize: 21, color: NAVY, flex: 'none', paddingTop: 1,
                  }}>{KIND_ICON[e.type] ?? 'radio_button_unchecked'}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)', lineHeight: 1.35,
                    }}>
                      {e.subject || e.type.replace(/_/g, ' ')}
                      {e.customer && (
                        <span style={{ color: 'var(--txt2)', fontWeight: FW.normal }}> · {e.customer}</span>
                      )}
                    </div>
                    {(e.outcome || e.location) && (
                      <div style={{ marginTop: SP[1], display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
                        {e.outcome && <StatusBadge status={e.outcome.replace(/_/g, ' ')} />}
                        {e.location && (
                          <span style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>
                            📍 {e.location}
                          </span>
                        )}
                      </div>
                    )}
                    {e.body && (
                      <p style={{
                        margin: `${SP[2]} 0 0`, fontSize: TEXT.base, color: 'var(--txt2)',
                        lineHeight: 1.7, overflowWrap: 'anywhere', maxWidth: '76ch',
                      }}>{e.body}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {o.entries.length > shown.length && (
              <Button variant="ghost" style={{ marginTop: SP[4] }} onClick={() => setShowAll(true)}>
                Show the remaining {o.entries.length - shown.length}
              </Button>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}
