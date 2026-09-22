import { useEffect, useRef, useState } from 'react'
import { SectionCard, Modal, Button, EmptyState, Badge } from '../../../components/UI'
import { FW, RED, SP, TEXT } from '../../../lib/design'
import type { Dataset } from './model'
import { parseJson } from './model'

export interface SavedReport {
  id: number; name: string; description: string; dataset: string; config: any
  is_public: boolean; is_mine?: boolean; created_by_name?: string
  active_schedules?: number; updated_at?: string
}
export interface Schedule {
  id: number; report_id: number; report_name: string; dataset: string
  frequency: string; hour: number; day_of_week: number; day_of_month: number
  recipients: any; format: string; is_active: boolean
  last_run_at?: string; next_run_at?: string; last_status?: string; created_by_name?: string
  can_manage?: boolean // false → set up by someone else: view only
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function Labeled({ label, htmlFor, children, style }: { label: string; htmlFor?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ marginBottom: SP[3], ...style }}>
      <label htmlFor={htmlFor} style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )
}

const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 6, border: '1px solid var(--input-bdr)',
  background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, fontFamily: 'inherit',
}

// ── Recipients ──────────────────────────────────────────────────────────────

// An address is taken only when it is shaped like one: no spaces, one @, and a dot in the
// part after it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// useRecipients holds the recipient list and the text still being typed. commit() adds
// the typed addresses and also returns the whole list, so a submit button can send it in
// the same click: the state it sets is only read on the next render, and without that the
// first click on Send ignored an address not yet confirmed with Enter. It returns null
// when some of the typed text isn't an address, which is left in the box to correct.
function useRecipients() {
  const [list, setList] = useState<string[]>([])
  const [text, setText] = useState('')
  const [rejected, setRejected] = useState<string[]>([])
  const commit = (): string[] | null => {
    const parts = text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
    if (!parts.length) return list
    const next = [...list]
    const bad: string[] = []
    for (const p of parts) {
      if (!EMAIL_RE.test(p)) { if (!bad.includes(p)) bad.push(p) } else if (!next.includes(p)) next.push(p)
    }
    setList(next)
    setText(bad.join(', '))
    setRejected(bad)
    return bad.length ? null : next
  }
  const reset = (v: string[]) => { setList(v); setText(''); setRejected([]) }
  return { list, setList, text, setText, rejected, setRejected, commit, reset, ready: list.length > 0 || text.trim() !== '' }
}
type RecipientsState = ReturnType<typeof useRecipients>

function Recipients({ id, r }: { id: string; r: RecipientsState }) {
  const errId = `${id}-error`
  const bad = r.rejected
  return (
    <>
      <div style={{ ...field, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minHeight: 40 }}>
        {r.list.map(e => (
          <span key={e} className="rb-pill filter" style={{ fontSize: 12 }}>
            <span className="rb-pill-main">{e}</span>
            <button type="button" className="rb-x" aria-label={`Remove ${e}`} onClick={() => r.setList(r.list.filter(x => x !== e))}>×</button>
          </span>
        ))}
        <input id={id} value={r.text} onChange={e => { r.setText(e.target.value); if (bad.length) r.setRejected([]) }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); r.commit() } }}
          onBlur={() => r.commit()} placeholder={r.list.length ? '' : 'name@o3cards.com, …'}
          aria-invalid={bad.length > 0 || undefined} aria-describedby={bad.length ? errId : undefined}
          style={{ flex: 1, minWidth: 160, border: 'none', outline: 'none', background: 'transparent', color: 'var(--txt)', fontSize: TEXT.sm, fontFamily: 'inherit' }} />
      </div>
      {bad.length > 0 && (
        <div id={errId} role="alert" className="rb-hint" style={{ color: RED, marginTop: 4 }}>
          {bad.length === 1
            ? `“${bad[0]}” isn’t a full email address, such as name@o3cards.com.`
            : `These aren’t full email addresses: ${bad.join(', ')}.`}
        </div>
      )}
    </>
  )
}

// useBusy tracks which item's request is still running, so a second click on the same
// button does nothing until the first has finished. The ref catches a double click that
// lands before the disabled button has rendered.
function useBusy() {
  const running = useRef(new Set<string>())
  const [, setTick] = useState(0)
  const run = async (key: string, fn: () => unknown) => {
    if (running.current.has(key)) return
    running.current.add(key); setTick(t => t + 1)
    try { await fn() } finally { running.current.delete(key); setTick(t => t + 1) }
  }
  return { run, busy: (key: string) => running.current.has(key) }
}

// ── Saved reports ───────────────────────────────────────────────────────────

export function SavedTab({ saved, datasets, onOpen, onDuplicate, onEmail, onSchedule, onDelete }: {
  saved: SavedReport[]; datasets: Dataset[]
  onOpen: (r: SavedReport) => void; onDuplicate: (r: SavedReport) => unknown; onEmail: (r: SavedReport) => void
  onSchedule: (r: SavedReport) => void; onDelete: (r: SavedReport) => void
}) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const { run, busy } = useBusy()
  const dsLabel = (key: string) => datasets.find(d => d.key === key)?.label ?? key

  if (!saved.length) return (
    <SectionCard title=""><EmptyState icon="bookmark" title="No Saved Reports Yet"
      description="Build a report on the Builder tab and save it. It shows up here for you, and for colleagues who report on the same data if you share it." /></SectionCard>
  )

  const shown = saved
    .filter(r => {
      const s = q.trim().toLowerCase()
      if (!s) return true
      return r.name.toLowerCase().includes(s) || (r.description ?? '').toLowerCase().includes(s) || dsLabel(r.dataset).toLowerCase().includes(s)
    })
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b.updated_at ?? '').localeCompare(a.updated_at ?? '')))

  return (
    <>
      <div style={{ display: 'flex', gap: SP[3], alignItems: 'center', marginBottom: SP[3], flexWrap: 'wrap' }}>
        <input id="rb-saved-search" className="rb-input" style={{ maxWidth: 280 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Search saved reports…" aria-label="Search saved reports" />
        <select id="rb-saved-sort" className="rb-input" style={{ width: 'auto' }} value={sort} onChange={e => setSort(e.target.value as 'updated' | 'name')} aria-label="Sort saved reports">
          <option value="updated">Recently Updated</option>
          <option value="name">Name</option>
        </select>
        <span className="rb-hint">{shown.length} of {saved.length}</span>
      </div>
      {!shown.length ? (
        <SectionCard title=""><EmptyState icon="search_off" title="No Reports Match" description="Try a different search." /></SectionCard>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: SP[3] }}>
          {shown.map(r => {
            const table = parseJson(r.config).view === 'table'
            return (
              <SectionCard key={r.id} title={r.name} subtitle={r.description || undefined}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: SP[2] }}>
                  <Badge variant="neutral">{dsLabel(r.dataset)}</Badge>
                  <Badge variant="neutral">{table ? 'Table' : 'Summary'}</Badge>
                  {r.is_public && <Badge variant="info">Shared</Badge>}
                  {r.is_mine === false && r.created_by_name && <Badge variant="neutral">By {r.created_by_name}</Badge>}
                  {!!r.active_schedules && <Badge variant="success">{r.active_schedules} Schedule{r.active_schedules === 1 ? '' : 's'}</Badge>}
                </div>
                {r.updated_at && <div className="rb-hint" style={{ marginBottom: SP[2] }}>Updated {timeAgo(r.updated_at)}</div>}
                <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
                  <Button size="xs" icon={r.is_mine === false ? 'open_in_new' : 'edit'} onClick={() => onOpen(r)}>{r.is_mine === false ? 'Open' : 'Open & Edit'}</Button>
                  <Button size="xs" variant="secondary" icon="content_copy" loading={busy(`dup:${r.id}`)}
                    onClick={() => run(`dup:${r.id}`, () => onDuplicate(r))}>Duplicate</Button>
                  <Button size="xs" variant="secondary" icon="mail" onClick={() => onEmail(r)}>Email</Button>
                  <Button size="xs" variant="secondary" icon="schedule" onClick={() => onSchedule(r)}>Schedule</Button>
                  {r.is_mine !== false && <Button size="xs" variant="ghost" icon="delete" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r)} />}
                </div>
              </SectionCard>
            )
          })}
        </div>
      )}
    </>
  )
}

// ── Schedules ───────────────────────────────────────────────────────────────

function describeSchedule(s: Schedule): string {
  const hh = `${String(s.hour).padStart(2, '0')}:00`
  if (s.frequency === 'weekly') return `Weekly · ${DOW[s.day_of_week] ?? 'Monday'} at ${hh}`
  if (s.frequency === 'monthly') return `Monthly · Day ${s.day_of_month} at ${hh}`
  return `Daily at ${hh}`
}
export function recipientList(v: any): string[] {
  if (Array.isArray(v)) return v
  try { return JSON.parse(v || '[]') } catch { return [] }
}
function fmtWhen(s?: string): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function timeAgo(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  return fmtWhen(s)
}

export function SchedulesTab({ schedules, onToggle, onEdit, onRunNow, onDelete }: {
  schedules: Schedule[]; onToggle: (s: Schedule) => unknown; onEdit: (s: Schedule) => void
  onRunNow: (s: Schedule) => unknown; onDelete: (s: Schedule) => void
}) {
  const { run, busy } = useBusy()
  if (!schedules.length) return (
    <SectionCard title=""><EmptyState icon="schedule" title="No Schedules Yet"
      description="Open a saved report and choose Schedule to have it emailed automatically: daily, weekly or monthly." /></SectionCard>
  )
  return (
    <SectionCard title="Scheduled Deliveries" subtitle="Reports emailed automatically · times are West Africa (Lagos)">
      <div className="rb-table-wrap" style={{ maxHeight: 'none' }}>
        <table className="rb-table">
          <thead>
            <tr>{['Report', 'Cadence', 'Recipients', 'Format', 'Next Run', 'Last Run', 'Status', ''].map(h => (
              <th key={h} scope="col"><span className="rb-th-btn" style={{ cursor: 'default' }}>{h}</span></th>
            ))}</tr>
          </thead>
          <tbody>
            {schedules.map(s => {
              const rec = recipientList(s.recipients)
              const failed = (s.last_status || '').startsWith('error')
              return (
                <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.6 }}>
                  <td>{s.report_name}</td>
                  <td>{describeSchedule(s)}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 240 }}>{rec.join(', ') || '—'}</td>
                  <td>{s.format?.toUpperCase()}</td>
                  <td>{s.is_active ? fmtWhen(s.next_run_at) : 'Paused'}</td>
                  <td>{fmtWhen(s.last_run_at)}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 240, color: failed ? RED : 'var(--txt2)' }}>{s.last_status || '—'}</td>
                  <td>
                    {s.can_manage === false ? (
                      <span className="rb-hint">{s.created_by_name ? `Set up by ${s.created_by_name}` : 'Set up by a colleague'}</span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 2 }}>
                        <Button size="xs" variant="ghost" icon="edit" onClick={() => onEdit(s)}>Edit</Button>
                        <Button size="xs" variant="ghost" icon="send" loading={busy(`run:${s.id}`)}
                          onClick={() => run(`run:${s.id}`, () => onRunNow(s))}>Send Now</Button>
                        <Button size="xs" variant="ghost" icon={s.is_active ? 'pause' : 'play_arrow'} loading={busy(`toggle:${s.id}`)}
                          onClick={() => run(`toggle:${s.id}`, () => onToggle(s))}>{s.is_active ? 'Pause' : 'Resume'}</Button>
                        <Button size="xs" variant="ghost" icon="delete" aria-label={`Delete the ${s.report_name} schedule`} onClick={() => onDelete(s)} />
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}

// ── Email ───────────────────────────────────────────────────────────────────

export function EmailModal({ open, onClose, name, onSend, busy, restricted }: {
  open: boolean; onClose: () => void; name: string
  onSend: (recipients: string[], format: string, message: string) => void; busy: boolean; restricted: boolean
}) {
  const rec = useRecipients()
  const [format, setFormat] = useState('xlsx')
  const [message, setMessage] = useState('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { rec.reset([]); setMessage('') } }, [open])
  const send = () => {
    const to = rec.commit()
    if (to?.length) onSend(to, format, message)
  }
  return (
    <Modal open={open} onClose={onClose} title="Email This Report"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!rec.ready} onClick={send}>Send Now</Button></>}>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[3] }}>
        Sends <b>{name}</b> exactly as it looks now, attached as a spreadsheet and previewed in the email.
        {restricted && ' Reports on your department’s data go to company email addresses only.'}
      </div>
      <Labeled label="Recipients" htmlFor="rb-email-recipients"><Recipients id="rb-email-recipients" r={rec} /></Labeled>
      <Labeled label="Attachment" htmlFor="rb-email-format">
        <select id="rb-email-format" value={format} onChange={e => setFormat(e.target.value)} style={field}>
          <option value="xlsx">Excel (.xlsx)</option>
          <option value="csv">CSV (.csv)</option>
        </select>
      </Labeled>
      <Labeled label="Note (Optional)" htmlFor="rb-email-note">
        <textarea id="rb-email-note" value={message} onChange={e => setMessage(e.target.value)} rows={2} placeholder="Add a short note…" style={{ ...field, resize: 'vertical' }} />
      </Labeled>
    </Modal>
  )
}

// ── Schedule ────────────────────────────────────────────────────────────────

interface ScheduleInitial { frequency: string; hour: number; day_of_week: number; day_of_month: number; format: string; recipients: any }

export function ScheduleModal({ open, onClose, needsSave, unsavedChanges, onSaveFirst, onSubmit, busy, initial, restricted, period }: {
  open: boolean; onClose: () => void; needsSave: boolean; unsavedChanges: boolean; onSaveFirst: () => void
  onSubmit: (payload: any) => void; busy: boolean; initial?: ScheduleInitial; restricted: boolean
  // The period each email covers. A relative period is worked out on the day of each send;
  // fixed dates repeat the same days every time.
  period?: { label: string; fixed: boolean; from: string; to: string; dateLabel: string }
}) {
  const [frequency, setFrequency] = useState('daily')
  const [hour, setHour] = useState(7)
  const [dow, setDow] = useState(1)
  const [dom, setDom] = useState(1)
  const [format, setFormat] = useState('xlsx')
  const rec = useRecipients()
  useEffect(() => {
    if (!open) return
    if (initial) {
      setFrequency(initial.frequency ?? 'daily'); setHour(initial.hour ?? 7)
      setDow(initial.day_of_week ?? 1); setDom(initial.day_of_month ?? 1)
      setFormat(initial.format ?? 'xlsx'); rec.reset(recipientList(initial.recipients))
    } else {
      setFrequency('daily'); setHour(7); setDow(1); setDom(1); setFormat('xlsx'); rec.reset([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])
  const submit = () => {
    const to = rec.commit()
    if (to?.length) onSubmit({ frequency, hour, day_of_week: dow, day_of_month: dom, recipients: to, format })
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Edit Schedule' : 'Schedule This Report'}
      footer={needsSave
        ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={onSaveFirst}>Save Report First</Button></>
        : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!rec.ready} onClick={submit}>{initial ? 'Save Changes' : 'Create Schedule'}</Button></>}>
      {needsSave ? (
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Save this report first. A schedule sends a saved report, so it keeps running on its own.</div>
      ) : (
        <>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[3] }}>
            The saved report runs on its own and is emailed to the recipients. Times are West Africa (Lagos).
            {restricted && ' Company email addresses only.'}
          </div>
          {period && (period.fixed ? (
            <div className="rb-note warn" style={{ marginBottom: SP[3] }}>
              <span className="material-symbols-rounded" aria-hidden="true">event_busy</span>
              <span>This report uses fixed dates, <b>{period.from}</b> to <b>{period.to}</b>, so every email repeats those same days. For a rolling report, set the Period to one such as <b>Last Working Week (Mon–Fri)</b> and save.</span>
            </div>
          ) : (
            <div className="rb-note" style={{ marginBottom: SP[3] }}>
              <span className="material-symbols-rounded" aria-hidden="true">date_range</span>
              <span>Each email covers <b>{period.label}</b> by {period.dateLabel}, worked out on the day it’s sent.</span>
            </div>
          ))}
          {unsavedChanges && !initial && (
            <div className="rb-note warn" style={{ marginBottom: SP[3] }}>
              <span className="material-symbols-rounded" aria-hidden="true">warning</span>
              <span>This report has unsaved changes. The schedule sends the <b>saved</b> version: save first if the changes should go out.</span>
            </div>
          )}
          <Labeled label="Frequency" htmlFor="rb-sched-frequency">
            <select id="rb-sched-frequency" value={frequency} onChange={e => setFrequency(e.target.value)} style={field}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </Labeled>
          <div style={{ display: 'flex', gap: SP[3] }}>
            {frequency === 'weekly' && (
              <Labeled label="Day of Week" htmlFor="rb-sched-dow" style={{ flex: 1 }}>
                <select id="rb-sched-dow" value={dow} onChange={e => setDow(Number(e.target.value))} style={field}>
                  {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </Labeled>
            )}
            {frequency === 'monthly' && (
              <Labeled label="Day of Month" htmlFor="rb-sched-dom" style={{ flex: 1 }}>
                <select id="rb-sched-dom" value={dom} onChange={e => setDom(Number(e.target.value))} style={field}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </Labeled>
            )}
            <Labeled label="Time" htmlFor="rb-sched-hour" style={{ flex: 1 }}>
              <select id="rb-sched-hour" value={hour} onChange={e => setHour(Number(e.target.value))} style={field}>
                {Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </Labeled>
            <Labeled label="Format" htmlFor="rb-sched-format" style={{ flex: 1 }}>
              <select id="rb-sched-format" value={format} onChange={e => setFormat(e.target.value)} style={field}>
                <option value="xlsx">Excel</option>
                <option value="csv">CSV</option>
              </select>
            </Labeled>
          </div>
          <Labeled label="Recipients" htmlFor="rb-sched-recipients"><Recipients id="rb-sched-recipients" r={rec} /></Labeled>
        </>
      )}
    </Modal>
  )
}
