import { useCallback, useEffect, useMemo, useState } from 'react'
import { SectionCard, Button, Textarea, Spinner, EmptyState } from '../../components/UI'
// The day log and the lead log are one dialog now — see components/SalesActivityModal.
// This file used to carry a second component also called LogActivityModal, which is part
// of how Sales ended up with four different "Log Activity" forms.
import SalesActivityModal from '../../components/SalesActivityModal'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, PURPLE, BLUE, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtNum, fmtDate } from '../../lib/fmt'

// My Day — the officer's own record of what they did.
//
// A sales officer's work is mostly outside the building: an employer visit, a call from
// the car, a customer met at a branch. None of it was recorded anywhere, so a day spent
// on four employer visits that produced no lead that afternoon showed up as nothing at
// all, and there was no way for the officer to show otherwise.
//
// Two halves, matching the two things the backend stores separately (migration 307):
// the individual entries, and the end-of-day report. They are not the same statement —
// "I logged six calls" and "I am done, and here is what I make of today" are different,
// and a day with entries but no report is a day still in progress.

interface DayActivity {
  id: number
  type: string
  subject: string
  body?: string
  outcome?: string
  location?: string
  contact_id?: number | null
  contact_name?: string | null
  occurred_at: string
}
interface DayReport {
  id: number
  report_date: string
  summary: string
  plan: string
  submitted_at?: string | null
}

const TYPES = [
  { value: 'visit', label: 'Visit', hint: 'You went somewhere' },
  { value: 'call', label: 'Call', hint: 'You rang someone' },
  { value: 'meeting', label: 'Meeting', hint: 'A scheduled sit-down' },
  { value: 'note', label: 'Note', hint: 'Anything else worth recording' },
]

const TYPE_ICON: Record<string, string> = {
  visit: 'location_on', call: 'call', meeting: 'groups', note: 'sticky_note_2',
}
const TYPE_COLOR: Record<string, string> = {
  visit: PURPLE, call: BLUE, meeting: NAVY, note: 'var(--txt3)',
}
const typeLabel = (t: string) => TYPES.find(x => x.value === t)?.label ?? t

export function MyDay({ onLogged }: { onLogged?: () => void }) {
  const [activities, setActivities] = useState<DayActivity[]>([])
  const [report, setReport] = useState<DayReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [logOpen, setLogOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch<{ activities: DayActivity[]; report: DayReport | null }>('/api/sales/my-day')
      setActivities(r?.activities ?? [])
      setReport(r?.report ?? null)
    } catch (e: any) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Outcome codes are stored, not labels — so the day would otherwise read
  // "answered_interested" back at the officer who chose "Answered — Interested".
  // Loaded from the same endpoint the form picks from, so the two can never disagree.
  const [dispLabels, setDispLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    apiFetch<{ data: Record<string, { code: string; label: string }[]> }>('/api/sales/activity/dispositions')
      .then(r => {
        const m: Record<string, string> = {}
        Object.values(r?.data ?? {}).forEach(list => list.forEach(d => { m[d.code] = d.label }))
        setDispLabels(m)
      })
      .catch(() => { /* falls back to the raw code, which is still readable */ })
  }, [])

  const counts = useMemo(() => {
    const c: Record<string, number> = { visit: 0, call: 0, meeting: 0, note: 0 }
    activities.forEach(a => { if (c[a.type] != null) c[a.type]++ })
    return c
  }, [activities])

  const submitted = !!report?.submitted_at

  return (
    <SectionCard
      title="My Day"
      subtitle={`${fmtDate(new Date().toISOString().slice(0, 10))} · ${fmtNum(activities.length)} logged`}
      badge={activities.length || undefined}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* "Accounted for", not "submitted". The day's summary is derived from these
              entries, so logging the work IS filing the day — there is no second step to
              have completed. The old chip read "Day submitted" and only appeared once an
              officer had typed a report, which made a fully-worked day look unfinished. */}
          {activities.length > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: TEXT.xs, fontWeight: FW.semibold, color: GREEN,
            }}>
              <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 15 }}>task_alt</span>
              Day accounted for
            </span>
          )}
          <Button size="sm" variant="primary" icon="add" onClick={() => setLogOpen(true)}>Log Activity</Button>
        </div>
      }
      style={{ marginBottom: SP[4] }}
    >
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '30px 0' }}><Spinner size={22} /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>

          {/* The day in four numbers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(90px,1fr))', gap: SP[2] }}>
            {TYPES.map(t => (
              <div key={t.value} style={{
                padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.lg, background: 'var(--bg)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                  <span className="material-symbols-rounded" aria-hidden
                    style={{ fontSize: 14, color: TYPE_COLOR[t.value] }}>{TYPE_ICON[t.value]}</span>
                  <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    {t.label}
                  </span>
                </div>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: counts[t.value] ? 'var(--txt)' : 'var(--txt3)', lineHeight: 1 }}>
                  {counts[t.value]}
                </div>
              </div>
            ))}
          </div>

          {/* What happened, latest first */}
          {activities.length === 0 ? (
            <EmptyState icon="event_note" title="Nothing logged yet today"
              description="Record a visit, a call or a meeting as it happens — it takes a few seconds and it is what your day looks like to your head."
              action={{ label: 'Log Activity', icon: 'add', onClick: () => setLogOpen(true) }} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {activities.map(a => (
                <div key={a.id} style={{
                  display: 'flex', gap: SP[3], padding: `${SP[2]} 0`,
                  borderBottom: '1px solid var(--bdr)', alignItems: 'flex-start',
                }}>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', minWidth: 44, paddingTop: 2 }}>
                    {new Date(a.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="material-symbols-rounded" aria-hidden style={{
                    fontSize: 17, color: TYPE_COLOR[a.type], flexShrink: 0, marginTop: 1,
                  }}>{TYPE_ICON[a.type] ?? 'circle'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)' }}>
                      {a.subject}
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>
                      {typeLabel(a.type)}
                      {a.location && <> · {a.location}</>}
                      {a.contact_name && <> · {a.contact_name}</>}
                      {a.outcome && <> · {dispLabels[a.outcome] ?? a.outcome}</>}
                    </div>
                    {a.body && (
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{a.body}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <DailyReport report={report} activityCount={activities.length} onSaved={load} />
        </div>
      )}

      <SalesActivityModal
        open={logOpen}
        officerMode
        onClose={() => setLogOpen(false)}
        onSaved={() => { setLogOpen(false); load(); onLogged?.() }}
      />
    </SectionCard>
  )
}

// ── The end-of-day report ─────────────────────────────────────────────────────

function DailyReport({ report, activityCount, onSaved }: {
  report: DayReport | null; activityCount: number; onSaved: () => void
}) {
  const [summary, setSummary] = useState(report?.summary ?? '')
  const [plan, setPlan] = useState(report?.plan ?? '')
  const [busy, setBusy] = useState(false)

  // Re-seed when the day reloads, but never overwrite what the officer is mid-way
  // through typing — a background refresh must not eat a half-written report.
  useEffect(() => {
    setSummary(s => (s ? s : report?.summary ?? ''))
    setPlan(p => (p ? p : report?.plan ?? ''))
  }, [report])

  const submitted = !!report?.submitted_at

  async function save(submit: boolean) {
    // Either field on its own is a legitimate note — "what is next" with nothing to report
    // about today is exactly what an officer writes after a quiet day.
    if (!summary.trim() && !plan.trim()) {
      toast.error('Write something first — this is optional, so an empty note saves nothing.')
      return
    }
    setBusy(true)
    try {
      await apiFetch('/api/sales/my-day/report', {
        method: 'PUT',
        body: JSON.stringify({ summary: summary.trim(), plan: plan.trim(), submit }),
      })
      toast.success('Note saved')
      onSaved()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  return (
    <div style={{
      padding: SP[3], borderRadius: RADIUS.lg,
      background: submitted ? `${GREEN}0A` : 'var(--bg)',
      border: `1px solid ${submitted ? `${GREEN}33` : 'var(--bdr)'}`,
    }}>
      {/* Optional, and said so plainly. The day's numbers are derived from the entries
          above, so this is no longer the thing that files the day — it is the place for
          what the entries cannot show: why the afternoon was lost, what the branch manager
          hinted at, what to warn the next officer about. Presenting it as a required
          submission is why sales_daily_reports never held a single row: nobody types their
          day twice, and the second telling is the one that gets skipped. */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: SP[2], marginBottom: SP[3], flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>
            Anything Worth Adding? <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(Optional)</span>
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {submitted
              ? `Added ${new Date(report!.submitted_at!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. You can still change it.`
              : activityCount === 0
                ? 'A day with nothing to log is worth explaining — say so here and your head will see it.'
                : 'Your day is already accounted for by the entries above. Add a note only if there is something they do not show.'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <Textarea label="Anything the entries do not show?" value={summary} onChange={e => setSummary(e.target.value)}
          rows={2} placeholder="e.g. Ikeja branch flooded, lost the afternoon. Dangote HR want a presentation for 40 staff." />
        <Textarea label="What is next? (Optional)" value={plan} onChange={e => setPlan(e.target.value)}
          rows={2} placeholder="e.g. Prepare the Dangote deck, call back Mr Adeyemi on Monday." />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {/* One button. "Save Draft" and "Submit Day" drew a distinction that no longer
              exists now that nothing depends on the day being submitted. */}
          <Button size="sm" variant="secondary" loading={busy} onClick={() => save(true)}
            disabled={!summary.trim() && !plan.trim()}>
            {submitted ? 'Update Note' : 'Save Note'}
          </Button>
        </div>
      </div>
    </div>
  )
}


export default MyDay
