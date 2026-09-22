import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Page, ErrBanner, Button, Input, Textarea, ConfirmModal, Sk, Spinner } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { GREEN, AMBER, RED, NAVY, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { currentUser } from '../../hooks/useAuth'
import { toast } from 'sonner'
import {
  canManageReports, useCatalogue, scheduleSentence, plural, fmtWhen, firstLine, emailInitials,
  AUDIENCE_COLOR, Segmented, PreviewFrame, PREVIEW_WIDTHS, waitForRun,
} from './management/shared'
import type { Catalogue, CatalogueSection, Cadence, Template, ReportRow } from './management/shared'

/*
  Report editor.

  One page to make or change a report: what it is called, when it goes out, which
  sections it carries and in what order, and who receives it — with the email itself
  beside the form, built from the unsaved draft, at desktop and phone widths. A new
  report starts from a template (management, sales) or from nothing.
*/

// ── Draft ─────────────────────────────────────────────────────────────────────

interface Draft {
  name: string
  description: string
  audience: string
  template: Template
  cadence: Cadence
  due_rule: string
  send_time: string
  sections: string[]
  recipients: string[]
  is_active: boolean
}

type FieldErrors = Partial<Record<'name' | 'sections' | 'send_time', string>>

const DEFAULT_RULE: Record<Cadence, string> = { daily: 'tue_to_sat', weekly: 'monday', monthly: 'first_of_month' }
const WEEKDAY_SHORT: Record<string, string> = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri' }
const CADENCE_HELP: Record<Cadence, string> = {
  daily: 'Covers the previous working day',
  weekly: 'Covers the last full week',
  monthly: 'Covers the month just closed',
}

function toDraft(r: ReportRow): Draft {
  return {
    name: r.name, description: r.description ?? '', audience: r.audience, template: r.template,
    cadence: r.cadence, due_rule: r.due_rule, send_time: r.send_time, sections: [...r.sections],
    recipients: [...r.recipients], is_active: r.is_active,
  }
}

function draftFromTemplate(t: Template, catalogue: Catalogue, me: string): Draft {
  const spec = t === 'custom' ? null : catalogue.templates[t]
  return {
    name: '',
    description: spec?.description ?? '',
    audience: t === 'custom' ? 'other' : t,
    template: t,
    cadence: 'daily',
    due_rule: t === 'custom' ? 'weekdays' : 'tue_to_sat',
    send_time: '09:00',
    sections: spec ? [...spec.daily] : [],
    recipients: me ? [me] : [],
    is_active: true,
  }
}

function validate(d: Draft): FieldErrors {
  const e: FieldErrors = {}
  const name = d.name.trim()
  if (name.length < 3) e.name = 'Give the report a name of at least 3 characters.'
  else if (name.length > 80) e.name = 'Keep the name to 80 characters or fewer.'
  if (!d.sections.length) e.sections = 'Add at least one section.'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.send_time)) e.send_time = 'Use a 24-hour time, such as 09:00.'
  return e
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function useWide(min: number) {
  const query = `(min-width: ${min}px)`
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setWide(m.matches)
    on()
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return wide
}

type PreviewState =
  | { state: 'idle' }
  | { state: 'building' }
  | { state: 'ready'; html: string; subject: string; builtAt: string; basis: string | null }
  | { state: 'failed'; error: string }

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReportEditor() {
  const { key } = useParams<{ key: string }>()
  const isNew = !key
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { catalogue, error: catalogueError } = useCatalogue()
  const canManage = canManageReports()
  const wide = useWide(1180)
  const me = ((currentUser() as { email?: string } | null)?.email ?? '').toLowerCase()

  const [report, setReport] = useState<ReportRow | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' })
  const [previewWidth, setPreviewWidth] = useState(600)
  const buildToken = useRef<{ cancelled: boolean }>({ cancelled: false })
  const autoPreviewed = useRef(false)

  // ── Load ──
  useEffect(() => {
    if (isNew) return
    let live = true
    setLoadError(null)
    apiFetch<ReportRow>(`/api/management-reports/${encodeURIComponent(key!)}`)
      .then(async r => {
        if (!live) return
        const d = toDraft(r)
        setReport(r); setDraft(d); setSaved(d)
        // Show the last thing this report actually built, if there is one, until a new
        // preview is asked for.
        if (r.preview_run_id) {
          try {
            const p = await apiFetch<{ subject: string; html: string }>(`/api/management-reports/runs/${r.preview_run_id}/preview`)
            if (live) setPreview({ state: 'ready', html: p.html, subject: p.subject, builtAt: r.preview_at ?? '', basis: null })
          } catch { /* no saved preview to show; the panel offers to build one */ }
        }
      })
      .catch((e: any) => { if (live) setLoadError(e.message) })
    return () => { live = false }
  }, [isNew, key])

  useEffect(() => () => { buildToken.current.cancelled = true }, [])

  const dirty = !!draft && (isNew || JSON.stringify(draft) !== JSON.stringify(saved))
  const errors = useMemo(() => (draft ? validate(draft) : {}), [draft])
  const shownErrors: FieldErrors = attempted ? errors : {}

  // Warn before closing the tab on unsaved work.
  useEffect(() => {
    if (!dirty || !canManage) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, canManage])

  const previewBasis = draft ? JSON.stringify([draft.name, draft.template, draft.cadence, draft.sections]) : null
  const previewStale = preview.state === 'ready' && preview.basis !== null && preview.basis !== previewBasis

  // Opened from a report card's Preview with nothing built yet: build one straight away.
  useEffect(() => {
    if (autoPreviewed.current || !draft || isNew || params.get('preview') !== '1') return
    if (report && !report.preview_run_id) { autoPreviewed.current = true; buildPreview() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, report])

  const update = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d))

  function setCadence(c: Cadence) {
    if (!catalogue) return
    setDraft(d => {
      if (!d) return d
      const rules = catalogue.due_rules.filter(r => r.cadence === c).map(r => r.id)
      const due_rule = rules.includes(d.due_rule) ? d.due_rule : DEFAULT_RULE[c]
      // A template's section list that has not been edited follows the cadence (weekly and
      // monthly add demographics); a list someone has changed is left exactly as they made it.
      let sections = d.sections
      if (d.template !== 'custom') {
        const spec = catalogue.templates[d.template]
        if (JSON.stringify(d.sections) === JSON.stringify(spec[d.cadence])) sections = [...spec[c]]
      }
      return { ...d, cadence: c, due_rule, sections }
    })
  }

  function draftConfig(d: Draft) {
    return { name: d.name.trim() || 'Untitled report', description: d.description.trim(), template: d.template, cadence: d.cadence, sections: d.sections }
  }

  async function buildPreview() {
    if (!draft) return
    if (!draft.sections.length) { toast.error('Add at least one section to preview.'); return }
    buildToken.current.cancelled = true
    const token = { cancelled: false }
    buildToken.current = token
    const basis = previewBasis
    setPreview({ state: 'building' })
    try {
      const config = draftConfig(draft)
      const res = isNew
        ? await apiPost<{ run_id: number }>('/api/management-reports/preview', { config })
        : await apiPost<{ run_id: number }>(`/api/management-reports/${encodeURIComponent(key!)}/send`, { mode: 'preview', config })
      const run = await waitForRun(res.run_id, token)
      if (token.cancelled) return
      if (run.status === 'failed') {
        setPreview({ state: 'failed', error: firstLine(run.error) || 'The report could not be built.' })
        return
      }
      const p = await apiFetch<{ subject: string; html: string }>(`/api/management-reports/runs/${res.run_id}/preview`)
      if (token.cancelled) return
      setPreview({ state: 'ready', html: p.html, subject: p.subject, builtAt: new Date().toISOString(), basis })
    } catch (e: any) {
      if (!token.cancelled && e.message !== 'cancelled') setPreview({ state: 'failed', error: e.message })
    }
  }

  async function sendTest() {
    if (!draft || isNew) return
    if (!draft.sections.length) { toast.error('Add at least one section first.'); return }
    setTesting(true)
    try {
      await apiPost(`/api/management-reports/${encodeURIComponent(key!)}/send`, { mode: 'test', config: draftConfig(draft) })
      toast.success(`Sending a test to ${me || 'you'}${dirty ? ', with your unsaved changes' : ''}. It arrives in about a minute.`)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setTesting(false)
    }
  }

  async function save() {
    if (!draft) return
    setAttempted(true)
    if (Object.keys(errors).length) { toast.error('Some fields need attention before this can be saved.'); return }
    setSaving(true)
    const body: Record<string, unknown> = {
      name: draft.name.trim(), description: draft.description.trim(), audience: draft.audience,
      cadence: draft.cadence, due_rule: draft.due_rule, send_time: draft.send_time,
      sections: draft.sections, recipients: draft.recipients, is_active: draft.is_active,
    }
    if (!report?.is_builtin) body.template = draft.template
    try {
      if (isNew) {
        const created = await apiPost<ReportRow>('/api/management-reports', body)
        toast.success(`${created.name} created.${created.is_active && created.recipients.length ? ' It sends on its next scheduled day.' : ''}`)
        setSaved(draft)
        navigate(`/reports/management/${encodeURIComponent(created.report_key)}`, { replace: true })
      } else {
        const updated = await apiPut<ReportRow>(`/api/management-reports/${encodeURIComponent(key!)}`, body)
        const d = toDraft(updated)
        setReport(updated); setDraft(d); setSaved(d); setAttempted(false)
        toast.success('Changes saved.')
      }
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!report) return
    setDeleting(true)
    try {
      await apiDelete(`/api/management-reports/${encodeURIComponent(report.report_key)}`)
      toast.success(`${report.name} deleted. Its send history is kept.`)
      setSaved(draft)
      navigate('/reports/management')
    } catch (e: any) {
      toast.error(e.message)
      setDeleting(false)
    }
  }

  const back = { label: 'Email Reports', to: '/reports/management' }

  // ── States before the form ──
  if (catalogueError || loadError) {
    return (
      <Page title={isNew ? 'New Report' : 'Report'} back={back}>
        <ErrBanner error={catalogueError || loadError} onRetry={() => window.location.reload()} />
      </Page>
    )
  }
  if (!catalogue || (!isNew && !draft)) {
    return (
      <Page title={isNew ? 'New Report' : 'Loading Report'} back={back}>
        <div style={{ display: 'grid', gap: SP[5], maxWidth: 760 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ ...panelShell, display: 'grid', gap: SP[3] }}><Sk w={160} h={16} /><Sk h={36} /><Sk w="60%" h={14} /></div>
          ))}
        </div>
      </Page>
    )
  }
  if (isNew && !draft) {
    return (
      <Page title="New Report" subtitle="Start from a template and change anything, or build it section by section" back={back}>
        <TemplateChooser catalogue={catalogue} onPick={t => setDraft(draftFromTemplate(t, catalogue, me))} />
      </Page>
    )
  }
  const d = draft as Draft
  const readOnly = !canManage
  const sectionById = new Map(catalogue.sections.map(s => [s.id, s]))
  const title = d.name.trim() || (isNew ? 'New Report' : report?.name ?? 'Report')

  return (
    <Page
      title={title}
      subtitle={isNew
        ? `From the ${d.template === 'custom' ? 'blank' : catalogue.templates[d.template].title.toLowerCase()} template`
        : `${report?.is_builtin ? 'Built-in report' : `Made by ${report?.created_by_name || 'a colleague'}`}${report?.updated_at ? ` · last changed ${fmtWhen(report.updated_at)}${report.updated_by_name ? ` by ${report.updated_by_name}` : ''}` : ''}`}
      back={back}
    >
      <div style={{
        display: 'grid', gap: SP[6], alignItems: 'start',
        gridTemplateColumns: wide ? 'minmax(0, 1fr) minmax(380px, 470px)' : 'minmax(0, 1fr)',
        paddingBottom: canManage ? 96 : 0,
      }}>
        <div style={{ display: 'grid', gap: SP[5], minWidth: 0 }}>
          <Panel step={1} title="About This Report" description="How it appears on the Reports page and in the inbox.">
            <div style={{ display: 'grid', gap: SP[4] }}>
              <Input id="rpt-name" label="Name" value={d.name} disabled={readOnly || !!report?.is_builtin}
                onChange={e => update({ name: e.target.value })} placeholder="For example: Collections Weekly"
                error={shownErrors.name}
                hint={report?.is_builtin ? 'Built-in reports keep the name management already knows.' : undefined} />
              <Textarea id="rpt-description" label="Description" rows={2} value={d.description} disabled={readOnly}
                onChange={e => update({ description: e.target.value })}
                placeholder="One sentence on what it is for"
                hint="Shown on the report card, and as the preview line of emails made from scratch." />
              <div>
                <FieldLabel>Audience</FieldLabel>
                <div role="group" aria-label="Audience" style={{ display: 'flex', flexWrap: 'wrap', gap: SP[2] }}>
                  {catalogue.audiences.map(a => {
                    const on = d.audience === a.id
                    const colour = AUDIENCE_COLOR[a.id] ?? '#6B7280'
                    return (
                      <button key={a.id} type="button" aria-pressed={on} disabled={readOnly} onClick={() => update({ audience: a.id })}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px',
                          borderRadius: RADIUS.full, cursor: readOnly ? 'default' : 'pointer', fontFamily: INTER,
                          fontSize: TEXT.sm, fontWeight: on ? FW.semibold : FW.medium,
                          border: `1px solid ${on ? colour : 'var(--bdr)'}`,
                          background: on ? `${colour}14` : 'var(--card)', color: on ? 'var(--txt)' : 'var(--txt2)',
                        }}>
                        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: RADIUS.full, background: colour }} />
                        {a.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </Panel>

          <Panel step={2} title="When It Goes Out" description="The period each email covers follows how often it is sent.">
            <div style={{ display: 'grid', gap: SP[4] }}>
              <div>
                <FieldLabel>How Often</FieldLabel>
                <Segmented<Cadence> ariaLabel="How often" disabled={readOnly} value={d.cadence} onChange={setCadence}
                  options={(['daily', 'weekly', 'monthly'] as Cadence[]).map(c => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} />
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 6 }}>{CADENCE_HELP[d.cadence]}</div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[5], alignItems: 'flex-end' }}>
                <div style={{ minWidth: 0 }}>
                  <FieldLabel>{d.cadence === 'weekly' ? 'On' : d.cadence === 'monthly' ? 'On' : 'Which Days'}</FieldLabel>
                  {d.cadence === 'monthly' ? (
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', padding: '7px 0' }}>The 1st of each month</div>
                  ) : (
                    <Segmented ariaLabel="Which days" disabled={readOnly} value={d.due_rule} onChange={v => update({ due_rule: v })}
                      options={catalogue.due_rules.filter(r => r.cadence === d.cadence).map(r => ({
                        value: r.id,
                        label: d.cadence === 'weekly' ? (WEEKDAY_SHORT[r.id] ?? r.label) : r.label,
                      }))} />
                  )}
                </div>
                <div style={{ width: 150 }}>
                  <Input id="rpt-time" type="time" step={300} label="Send Time (WAT)" value={d.send_time} disabled={readOnly}
                    onChange={e => update({ send_time: e.target.value })} error={shownErrors.send_time} />
                </div>
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SP[3], flexWrap: 'wrap',
                padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg, background: 'var(--th-bg)', border: '1px solid var(--bdr)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], minWidth: 0 }}>
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20, color: d.is_active ? NAVY : 'var(--txt3)' }}>event_repeat</span>
                  <span style={{ fontSize: TEXT.sm, color: d.is_active ? 'var(--txt)' : 'var(--txt3)' }}>
                    {d.is_active ? scheduleSentence(d, catalogue) : 'Paused. Nothing is sent until sending is turned back on.'}
                  </span>
                </div>
                <Switch checked={d.is_active} disabled={readOnly} onChange={v => update({ is_active: v })}
                  label={d.is_active ? 'Sending' : 'Paused'} />
              </div>
            </div>
          </Panel>

          <Panel step={3} title="What's in It"
            description="Sections appear in the email in this order. Add from the library, and move or remove as you like."
            aside={!readOnly && d.template !== 'custom' ? (
              <button type="button" style={linkButton}
                onClick={() => update({ sections: [...catalogue.templates[d.template as 'management' | 'sales'][d.cadence]] })}>
                Reset to Template
              </button>
            ) : undefined}>
            <SectionComposer
              catalogue={catalogue}
              sectionById={sectionById}
              sections={d.sections}
              readOnly={readOnly}
              error={shownErrors.sections}
              onChange={sections => update({ sections })}
            />
          </Panel>

          <Panel step={4} title="Who Receives It" description="Everyone gets their own copy and cannot see the other addresses.">
            <RecipientsEditor recipients={d.recipients} readOnly={readOnly} me={me}
              active={d.is_active} onChange={recipients => update({ recipients })} />
          </Panel>

          {!isNew && report && !report.is_builtin && canManage && (
            <Panel title="Delete This Report" description="It stops sending and leaves the Reports page. Its send history is kept.">
              <Button type="button" variant="danger" icon="delete" onClick={() => setConfirmDelete(true)}>Delete Report</Button>
            </Panel>
          )}
        </div>

        <aside style={{ position: wide ? 'sticky' : 'static', top: SP[4], minWidth: 0 }} aria-label="Email preview">
          <PreviewPanel
            preview={preview}
            stale={previewStale}
            width={previewWidth}
            onWidth={setPreviewWidth}
            wide={wide}
            canManage={canManage}
            canTest={!isNew}
            testing={testing}
            onBuild={buildPreview}
            onTest={sendTest}
            me={me}
          />
        </aside>
      </div>

      {canManage && (
        <SaveBar
          isNew={isNew}
          dirty={dirty}
          saving={saving}
          errorCount={attempted ? Object.keys(errors).length : 0}
          onDiscard={() => { if (saved) { setDraft(saved); setAttempted(false) } else navigate('/reports/management') }}
          onSave={save}
        />
      )}

      <ConfirmModal
        open={confirmDelete}
        danger
        title={`Delete ${report?.name ?? 'this report'}?`}
        body="It stops sending and leaves the Reports page. Everything it has already sent stays in the send history."
        confirmLabel="Delete Report"
        loading={deleting}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </Page>
  )
}

// ── Layout pieces ─────────────────────────────────────────────────────────────

const panelShell: CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl,
  boxShadow: 'var(--card-shadow)', padding: `${SP[5]} ${SP[6]}`, minWidth: 0,
}

const linkButton: CSSProperties = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: INTER,
  fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, whiteSpace: 'nowrap',
}

function Panel({ step, title, description, aside, children }: {
  step?: number; title: string; description?: string; aside?: ReactNode; children: ReactNode
}) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section aria-labelledby={id} style={panelShell}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: SP[3], marginBottom: SP[5] }}>
        <div style={{ display: 'flex', gap: SP[3], minWidth: 0 }}>
          {step !== undefined && (
            <span aria-hidden="true" style={{
              width: 26, height: 26, borderRadius: RADIUS.full, flexShrink: 0, marginTop: 1,
              background: 'var(--chip-bg)', color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.bold,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
            }}>{step}</span>
          )}
          <div style={{ minWidth: 0 }}>
            <h2 id={id} style={{ margin: 0, fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>{title}</h2>
            {description && <p style={{ margin: '3px 0 0', fontSize: TEXT.sm, color: 'var(--txt3)', lineHeight: 1.5 }}>{description}</p>}
          </div>
        </div>
        {aside}
      </header>
      {children}
    </section>
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 8, fontFamily: INTER }}>{children}</div>
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: SP[2], border: 'none', background: 'none', padding: 0,
        cursor: disabled ? 'default' : 'pointer', fontFamily: INTER, fontSize: TEXT.sm, fontWeight: FW.semibold,
        color: checked ? GREEN : AMBER,
      }}>
      <span aria-hidden="true" style={{
        width: 38, height: 22, borderRadius: RADIUS.full, position: 'relative', flexShrink: 0,
        background: checked ? GREEN : 'var(--input-bdr)', transition: 'background 150ms',
      }}>
        <span style={{
          position: 'absolute', top: 3, left: checked ? 19 : 3, width: 16, height: 16, borderRadius: RADIUS.full,
          background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)', transition: 'left 150ms',
        }} />
      </span>
      {label}
    </button>
  )
}

// ── Template chooser ──────────────────────────────────────────────────────────

function TemplateChooser({ catalogue, onPick }: { catalogue: Catalogue; onPick: (t: Template) => void }) {
  const options: { t: Template; icon: string; title: string; description: string; detail: string; colour: string }[] = [
    { t: 'management', icon: 'monitoring', colour: NAVY, title: catalogue.templates.management.title,
      description: catalogue.templates.management.description, detail: plural(catalogue.templates.management.daily.length, 'section') },
    { t: 'sales', icon: 'trending_up', colour: AMBER, title: catalogue.templates.sales.title,
      description: catalogue.templates.sales.description, detail: plural(catalogue.templates.sales.daily.length, 'section') },
    { t: 'custom', icon: 'dashboard_customize', colour: '#6B7280', title: 'Start from Scratch',
      description: 'Pick exactly the sections you want from the library, in the order you want them.', detail: 'Empty to begin with' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: SP[4], maxWidth: 1040 }}>
      {options.map(o => (
        <button key={o.t} type="button" onClick={() => onPick(o.t)}
          style={{
            ...panelShell, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: SP[3],
            fontFamily: INTER, transition: 'box-shadow 160ms ease, border-color 160ms ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = o.colour; e.currentTarget.style.boxShadow = '0 8px 30px rgba(15,22,35,.10)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--card-bdr)'; e.currentTarget.style.boxShadow = 'var(--card-shadow)' }}>
          <span aria-hidden="true" style={{
            width: 40, height: 40, borderRadius: RADIUS.lg, background: `${o.colour}14`, color: o.colour,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 22 }}>{o.icon}</span>
          </span>
          <span style={{ fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)' }}>{o.title}</span>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.55, flex: 1 }}>{o.description}</span>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: SP[3], borderTop: '1px solid var(--bdr)' }}>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{o.detail}</span>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: o.colour, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Use This <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>arrow_forward</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

// ── Sections ──────────────────────────────────────────────────────────────────

function SectionComposer({ catalogue, sectionById, sections, readOnly, error, onChange }: {
  catalogue: Catalogue
  sectionById: Map<string, CatalogueSection>
  sections: string[]
  readOnly: boolean
  error?: string
  onChange: (next: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const included = new Set(sections)
  const groupTitle = (id: string) => catalogue.groups.find(g => g.id === id)?.title ?? id
  const q = search.trim().toLowerCase()
  const library = catalogue.groups.map(g => ({
    group: g,
    items: catalogue.sections.filter(s => s.group === g.id && (!q || `${s.title} ${s.description}`.toLowerCase().includes(q))),
  })).filter(g => g.items.length)

  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= sections.length) return
    const next = [...sections]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 290px), 1fr))', gap: SP[5], alignItems: 'start' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: SP[2] }}>
          <FieldLabel>In This Report</FieldLabel>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{plural(sections.length, 'section')}</span>
        </div>
        {sections.length === 0 ? (
          <div style={{
            border: `1.5px dashed ${error ? RED : 'var(--input-bdr)'}`, borderRadius: RADIUS.lg, padding: SP[6],
            textAlign: 'center', color: error ? RED : 'var(--txt3)', fontSize: TEXT.sm, lineHeight: 1.5,
          }}>
            {error ?? 'Nothing yet. Add sections from the library.'}
          </div>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, overflow: 'hidden' }}>
            {sections.map((id, i) => {
              const s = sectionById.get(id)
              return (
                <li key={id} style={{
                  display: 'grid', gridTemplateColumns: '26px minmax(0, 1fr) auto', gap: SP[2], alignItems: 'center',
                  padding: `9px ${SP[3]}`, borderTop: i ? '1px solid var(--bdr)' : 'none', background: 'var(--card)',
                }}>
                  <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, textAlign: 'right', paddingRight: 4, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: TEXT.sm, color: s ? 'var(--txt)' : RED, fontWeight: FW.medium, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s?.title ?? `${id} (no longer available)`}
                    </span>
                    {s && <span style={{ display: 'block', fontSize: TEXT.xs, color: 'var(--txt3)' }}>{groupTitle(s.group)}</span>}
                  </span>
                  {!readOnly && (
                    <span style={{ display: 'inline-flex', gap: 2 }}>
                      <IconButton icon="arrow_upward" label={`Move ${s?.title ?? id} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton icon="arrow_downward" label={`Move ${s?.title ?? id} down`} disabled={i === sections.length - 1} onClick={() => move(i, 1)} />
                      <IconButton icon="close" label={`Remove ${s?.title ?? id}`} onClick={() => onChange(sections.filter(x => x !== id))} />
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>

      {!readOnly && (
        <div style={{ minWidth: 0 }}>
          <FieldLabel>Section Library</FieldLabel>
          <Input id="rpt-section-search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search sections" prefix="search" aria-label="Search sections" />
          <div style={{ marginTop: SP[3], maxHeight: 540, overflowY: 'auto', paddingRight: 4, display: 'grid', gap: SP[4] }}>
            {library.length === 0 && (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', padding: SP[3] }}>No section matches “{search}”.</div>
            )}
            {library.map(({ group, items }) => (
              <div key={group.id}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: SP[2] }}>
                  {group.title}
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {items.map(s => {
                    const on = included.has(s.id)
                    return (
                      <div key={s.id} style={{
                        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: SP[3], alignItems: 'center',
                        padding: `10px ${SP[3]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
                        background: on ? 'var(--th-bg)' : 'var(--card)',
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)' }}>{s.title}</div>
                          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.45, marginTop: 2 }}>{s.description}</div>
                        </div>
                        {on ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.semibold, color: GREEN, whiteSpace: 'nowrap' }}>
                            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>check</span>Added
                          </span>
                        ) : (
                          <Button type="button" size="xs" variant="secondary" icon="add" onClick={() => onChange([...sections, s.id])}
                            aria-label={`Add ${s.title}`}>Add</Button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function IconButton({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      style={{
        width: 28, height: 28, borderRadius: RADIUS.sm, border: 'none', background: 'transparent',
        color: disabled ? 'var(--input-bdr)' : 'var(--txt2)', cursor: disabled ? 'default' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )
}

// ── Recipients ────────────────────────────────────────────────────────────────

function RecipientsEditor({ recipients, readOnly, me, active, onChange }: {
  recipients: string[]; readOnly: boolean; me: string; active: boolean; onChange: (next: string[]) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Accepts several addresses at once — pasted from an email thread or a spreadsheet —
  // separated by commas, semicolons, spaces or new lines.
  function add(raw = text) {
    const parts = raw.split(/[\s,;]+/).map(s => s.trim().replace(/^<|>$/g, '').toLowerCase()).filter(Boolean)
    if (!parts.length) return
    const bad = parts.filter(p => !EMAIL.test(p))
    if (bad.length) { setError(`Not an email address: ${bad.join(', ')}`); return }
    const next = [...recipients]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setText('')
    setError(null)
  }

  return (
    <div style={{ display: 'grid', gap: SP[3] }}>
      {recipients.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: SP[2] }}>
          {recipients.map(email => (
            <li key={email} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 6px 4px 4px', maxWidth: '100%',
              borderRadius: RADIUS.full, background: 'var(--chip-bg)', border: '1px solid var(--bdr)',
            }}>
              <span aria-hidden="true" style={{
                width: 22, height: 22, borderRadius: RADIUS.full, background: NAVY, color: '#fff', flexShrink: 0,
                fontSize: 9, fontWeight: FW.bold, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>{emailInitials(email)}</span>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', overflowWrap: 'anywhere' }}>{email}</span>
              {email === me && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>you</span>}
              {!readOnly && (
                <button type="button" aria-label={`Remove ${email}`} onClick={() => onChange(recipients.filter(x => x !== email))}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', display: 'inline-flex', padding: 0 }}>
                  <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>close</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div role="status" style={{
          padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg, fontSize: TEXT.sm, lineHeight: 1.5,
          background: active ? `${AMBER}12` : 'var(--th-bg)', color: active ? AMBER : 'var(--txt3)',
        }}>
          {active
            ? 'Nobody receives this report while the list is empty, and its scheduled sends are recorded as failed.'
            : 'No recipients yet.'}
        </div>
      )}

      {!readOnly && (
        <div>
          <div style={{ display: 'flex', gap: SP[2], alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Input id="rpt-recipient" value={text} placeholder="name@o3cards.com, or paste several"
                aria-label="Add recipients" inputMode="email" autoComplete="off"
                onChange={e => { setText(e.target.value); if (error) setError(null) }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }}
                onPaste={e => {
                  const pasted = e.clipboardData.getData('text')
                  if (/[\s,;]/.test(pasted.trim())) { e.preventDefault(); add(pasted) }
                }}
                error={error ?? undefined} />
            </div>
            <Button type="button" variant="secondary" onClick={() => add()} disabled={!text.trim()}>Add</Button>
          </div>
          {me && !recipients.includes(me) && (
            <button type="button" style={{ ...linkButton, marginTop: SP[2], fontWeight: FW.medium }} onClick={() => onChange([...recipients, me])}>
              Add Me ({me})
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Preview panel ─────────────────────────────────────────────────────────────

function PreviewPanel({ preview, stale, width, onWidth, wide, canManage, canTest, testing, onBuild, onTest, me }: {
  preview: PreviewState
  stale: boolean
  width: number
  onWidth: (w: number) => void
  wide: boolean
  canManage: boolean
  canTest: boolean
  testing: boolean
  onBuild: () => void
  onTest: () => void
  me: string
}) {
  const building = preview.state === 'building'
  return (
    <section style={{ ...panelShell, padding: SP[5], display: 'grid', gap: SP[4] }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SP[3], flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>Preview</h2>
        <Segmented ariaLabel="Preview width" size="sm" options={PREVIEW_WIDTHS} value={width} onChange={onWidth} />
      </header>

      <div role="status" aria-live="polite" style={{ fontSize: TEXT.sm, lineHeight: 1.5, minHeight: 21 }}>
        {building && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2], color: 'var(--txt2)' }}>
            <Spinner size={14} color={NAVY} /> Building the email with today's figures…
          </span>
        )}
        {preview.state === 'idle' && <span style={{ color: 'var(--txt3)' }}>Build a preview to see the email exactly as it will arrive.</span>}
        {preview.state === 'failed' && <span style={{ color: RED }}>{preview.error}</span>}
        {preview.state === 'ready' && (stale
          ? <span style={{ color: AMBER }}>You have changed the report since this preview. Build again to see the changes.</span>
          : <span style={{ color: 'var(--txt3)' }}>
              {preview.basis ? 'Built from your current draft' : 'The last version this report built'}
              {preview.builtAt ? `, ${fmtWhen(preview.builtAt)}` : ''}
            </span>)}
      </div>

      {canManage && (
        <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
          <Button type="button" variant={preview.state === 'ready' && !stale ? 'secondary' : 'primary'} icon="refresh"
            loading={building} disabled={building} onClick={onBuild}>
            {preview.state === 'idle' ? 'Build Preview' : 'Build Again'}
          </Button>
          <Button type="button" variant="ghost" icon="outgoing_mail" loading={testing} disabled={!canTest || testing} onClick={onTest}
            title={canTest ? `Sends to ${me || 'your email address'}` : 'Save the report first to send a test'}>
            Send a Test to Me
          </Button>
        </div>
      )}

      {preview.state === 'ready' ? (
        <>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', overflowWrap: 'anywhere' }}>
            <span style={{ fontWeight: FW.semibold, color: 'var(--txt2)' }}>Subject</span> &nbsp;{preview.subject}
          </div>
          <div style={{ opacity: stale ? 0.55 : 1, transition: 'opacity 150ms' }}>
            <PreviewFrame html={preview.html} width={width} title="Report email preview" height={wide ? 'calc(100vh - 330px)' : '70vh'} />
          </div>
        </>
      ) : (
        <div style={{
          borderRadius: RADIUS.lg, background: '#e8e6e1', minHeight: wide ? 'calc(100vh - 330px)' : 360,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: SP[6],
        }}>
          <div style={{ width: 'min(100%, 260px)', background: '#fffffe', borderRadius: 4, padding: SP[5], display: 'grid', gap: 10, opacity: building ? 1 : 0.8 }} aria-hidden="true">
            <div style={{ height: 3, background: '#8c6a3f', margin: `-${SP[5]} -${SP[5]} 8px` }} />
            <div style={{ height: 8, width: '40%', background: '#e6e4df', borderRadius: 2 }} />
            <div style={{ height: 16, width: '75%', background: '#dcd9d3', borderRadius: 2 }} />
            <div style={{ height: 8, width: '55%', background: '#e6e4df', borderRadius: 2 }} />
            {[0, 1, 2, 3].map(i => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid #f0eeea' }}>
                <div style={{ height: 7, width: '45%', background: '#e6e4df', borderRadius: 2 }} />
                <div style={{ height: 7, width: '18%', background: '#dcd9d3', borderRadius: 2 }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ── Save bar ──────────────────────────────────────────────────────────────────

function SaveBar({ isNew, dirty, saving, errorCount, onDiscard, onSave }: {
  isNew: boolean; dirty: boolean; saving: boolean; errorCount: number; onDiscard: () => void; onSave: () => void
}) {
  return (
    <div style={{
      position: 'sticky', bottom: 0, zIndex: 5, marginTop: SP[6],
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SP[3], flexWrap: 'wrap',
      padding: `${SP[3]} ${SP[5]}`, background: 'var(--card)', border: '1px solid var(--card-bdr)',
      borderRadius: RADIUS.xl, boxShadow: '0 -4px 24px rgba(15,22,35,.08)',
    }}>
      <span style={{ fontSize: TEXT.sm, color: errorCount ? RED : dirty ? 'var(--txt)' : 'var(--txt3)', display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        {errorCount > 0 ? (
          <><span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>error</span>{plural(errorCount, 'field needs', 'fields need')} attention</>
        ) : dirty ? (
          <><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: RADIUS.full, background: AMBER }} />{isNew ? 'Not created yet' : 'Unsaved changes'}</>
        ) : 'All changes saved'}
      </span>
      <span style={{ display: 'inline-flex', gap: SP[2] }}>
        {(dirty || isNew) && <Button type="button" variant="secondary" disabled={saving} onClick={onDiscard}>{isNew ? 'Cancel' : 'Discard Changes'}</Button>}
        <Button type="button" variant="primary" icon={isNew ? 'add' : 'check'} loading={saving} disabled={saving || (!dirty && !isNew)} onClick={onSave}>
          {isNew ? 'Create Report' : 'Save Changes'}
        </Button>
      </span>
    </div>
  )
}
