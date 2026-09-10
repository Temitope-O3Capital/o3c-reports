import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, Button, Input, Textarea, Select, Spinner, ErrBanner } from '../../components/UI'
import { PreviewStudio } from '../../components/PreviewStudio'
import { apiFetch, apiPut } from '../../lib/api'
import { NAVY, RED, TEXT, FW, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

type QType = 'section' | 'rating' | 'nps' | 'single_choice' | 'multi_choice' | 'short_text' | 'long_text'
interface Q {
  qtype: QType
  label: string
  help_text: string
  required: boolean
  scale_min: number
  scale_max: number
  scale_min_label: string
  scale_max_label: string
  options: string[]
}
interface Meta {
  title: string; description: string; category: string; department: string
  intro: string; thank_you: string; signoff_name: string; signoff_title: string; accent_color: string
  is_anonymous: boolean
}

const QTYPES: { value: QType; label: string; icon: string }[] = [
  { value: 'section', label: 'Section header', icon: 'title' },
  { value: 'rating', label: 'Rating scale', icon: 'linear_scale' },
  { value: 'nps', label: 'Recommend / NPS', icon: 'recommend' },
  { value: 'single_choice', label: 'Single choice', icon: 'radio_button_checked' },
  { value: 'multi_choice', label: 'Multiple choice', icon: 'check_box' },
  { value: 'short_text', label: 'Short text', icon: 'short_text' },
  { value: 'long_text', label: 'Long text', icon: 'notes' },
]

function blankQ(qtype: QType): Q {
  return {
    qtype, label: '', help_text: '', required: qtype === 'rating' || qtype === 'nps',
    scale_min: qtype === 'nps' ? 0 : 1, scale_max: 10,
    scale_min_label: qtype === 'nps' ? 'Not at all likely' : 'Very Poor',
    scale_max_label: qtype === 'nps' ? 'Extremely likely' : 'Excellent',
    options: qtype === 'single_choice' || qtype === 'multi_choice' ? ['Option 1', 'Option 2'] : [],
  }
}

export default function SurveyBuilder() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [qs, setQs] = useState<Q[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const [locked, setLocked] = useState(false) // questions locked once responses exist

  useEffect(() => {
    apiFetch(`/api/surveys/${id}`)
      .then((d: any) => {
        const s = d.data?.survey ?? {}
        setLocked((d.data?.response_count ?? 0) > 0)
        setMeta({
          title: s.title || '', description: s.description || '', category: s.category || '', department: s.department || '',
          intro: s.intro || '', thank_you: s.thank_you || '', signoff_name: s.signoff_name || '', signoff_title: s.signoff_title || '',
          accent_color: s.accent_color || '#C00000', is_anonymous: !!s.is_anonymous,
        })
        setQs((d.data?.questions ?? []).map((q: any) => ({
          qtype: q.qtype, label: q.label || '', help_text: q.help_text || '', required: !!q.required,
          scale_min: q.scale_min ?? 1, scale_max: q.scale_max ?? 10,
          scale_min_label: q.scale_min_label || '', scale_max_label: q.scale_max_label || '',
          options: Array.isArray(q.options) ? q.options : [],
        })))
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [id])

  function patch(i: number, up: Partial<Q>) { setQs(qs.map((q, j) => j === i ? { ...q, ...up } : q)) }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= qs.length) return
    const next = [...qs];[next[i], next[j]] = [next[j], next[i]]; setQs(next)
  }
  function add(qtype: QType) { setQs([...qs, blankQ(qtype)]) }
  function remove(i: number) { setQs(qs.filter((_, j) => j !== i)) }

  function validate(): string | null {
    if (!meta) return 'Survey not loaded'
    if (!meta.title.trim()) return 'Give the survey a title.'
    if (locked) return null // questions unchanged; only meta is saved
    const answerable = qs.filter(q => q.qtype !== 'section')
    if (answerable.length === 0) return 'Add at least one question.'
    const unlabelled = qs.findIndex(q => !q.label.trim())
    if (unlabelled >= 0) return `Question ${unlabelled + 1} needs a label.`
    const badScale = qs.find(q => (q.qtype === 'rating' || q.qtype === 'nps') && q.scale_max <= q.scale_min)
    if (badScale) return `"${badScale.label}" has an invalid scale (max must exceed min).`
    const badChoice = qs.find(q => (q.qtype === 'single_choice' || q.qtype === 'multi_choice') && q.options.filter(o => o.trim()).length < 2)
    if (badChoice) return `"${badChoice.label}" needs at least two options.`
    return null
  }

  async function save() {
    if (!meta) return
    const v = validate()
    if (v) { setErr(v); toast.error(v); return }
    setSaving(true)
    try {
      await apiPut(`/api/surveys/${id}`, meta)
      if (!locked) await apiPut(`/api/surveys/${id}/questions`, { questions: qs.map(q => ({ ...q, options: q.options.filter(o => o.trim()) })) })
      toast.success('Survey saved')
      nav(`/feedback/surveys/${id}`)
    } catch (e: any) {
      setErr(e.message); toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading || !meta) return <Page title="Edit survey"><div style={{ padding: 40, display: 'grid', placeItems: 'center' }}><Spinner /></div></Page>

  return (
    <Page title="Edit survey" subtitle={meta.title || 'Untitled survey'} back={{ to: `/feedback/surveys/${id}`, label: 'Back to survey' }}
      actions={<>
        <Button variant="secondary" icon="visibility" onClick={() => setPreview(true)}>Preview</Button>
        <Button variant="secondary" onClick={() => nav(`/feedback/surveys/${id}`)}>Cancel</Button>
        <Button icon="save" loading={saving} onClick={save}>Save survey</Button>
      </>}>

      {err && <ErrBanner error={err} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 16, maxWidth: 820, margin: '0 auto' }}>
        {/* Meta */}
        <SectionCard title="Survey details">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input label="Title" required value={meta.title} onChange={e => setMeta({ ...meta, title: e.target.value })} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input label="Category" value={meta.category} onChange={e => setMeta({ ...meta, category: e.target.value })} />
              <Input label="Department" value={meta.department} onChange={e => setMeta({ ...meta, department: e.target.value })} />
            </div>
            <Textarea label="Intro message" hint="Appears at the top of the survey and in the invitation email." rows={3} value={meta.intro} onChange={e => setMeta({ ...meta, intro: e.target.value })} />
            <Textarea label="Thank-you message" hint="Shown after the customer submits." rows={2} value={meta.thank_you} onChange={e => setMeta({ ...meta, thank_you: e.target.value })} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input label="Sign-off name" value={meta.signoff_name} onChange={e => setMeta({ ...meta, signoff_name: e.target.value })} />
              <Input label="Sign-off title" value={meta.signoff_title} onChange={e => setMeta({ ...meta, signoff_title: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Accent colour</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['#C00000', '#0E2841', '#16A34A', '#7C3AED', '#0891B2', '#D97706'].map(c => (
                  <button key={c} onClick={() => setMeta({ ...meta, accent_color: c })}
                    style={{ width: 30, height: 30, borderRadius: 8, background: c, cursor: 'pointer', border: meta.accent_color === c ? '2px solid var(--txt)' : '2px solid transparent' }} />
                ))}
              </div>
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm, color: 'var(--txt)', cursor: 'pointer' }}>
              <input type="checkbox" checked={meta.is_anonymous} onChange={e => setMeta({ ...meta, is_anonymous: e.target.checked })} style={{ accentColor: RED, width: 15, height: 15 }} />
              Anonymous — don't store the respondent's identity with their answers
            </label>
          </div>
        </SectionCard>

        {/* Questions */}
        <SectionCard title="Questions" badge={qs.length}>
          {locked && (
            <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: RADIUS.md, background: `${NAVY}0D`, border: `1px solid ${NAVY}22`, display: 'flex', alignItems: 'center', gap: 10, fontSize: TEXT.sm, color: 'var(--txt)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY }}>lock</span>
              Questions are locked because this survey already has responses — changing them would corrupt the results. You can still edit the details above. To change questions, create a new survey.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {qs.length === 0 && (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.sm }}>
                No questions yet. Add one below.
              </div>
            )}
            {locked
              ? <SurveyPreview meta={meta} qs={qs} />
              : qs.map((q, i) => (
                <QuestionEditor key={i} q={q} idx={i} total={qs.length}
                  onPatch={up => patch(i, up)} onMove={dir => move(i, dir)} onRemove={() => remove(i)} />
              ))}
          </div>

          {!locked && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Add a question</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {QTYPES.map(t => (
                  <button key={t.value} onClick={() => add(t.value)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16, color: NAVY }}>{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      <PreviewStudio open={preview} onClose={() => setPreview(false)} survey={meta} questions={qs.map((q, i) => ({ ...q, id: i }))} />
    </Page>
  )
}

// Read-only render of the survey as the customer will roughly see it.
function SurveyPreview({ meta, qs }: { meta: Meta; qs: Q[] }) {
  const accent = meta.accent_color || '#C00000'
  let n = 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
        <div style={{ background: `linear-gradient(135deg, #0E2841, ${accent})`, color: '#fff', padding: '18px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.85 }}>Customer Feedback</div>
          <div style={{ fontSize: 19, fontWeight: 800, marginTop: 6 }}>{meta.title || 'Untitled survey'}</div>
        </div>
        {meta.intro && <div style={{ padding: '14px 20px', fontSize: 13, color: 'var(--txt2)', lineHeight: 1.6 }}>{meta.intro}</div>}
      </div>
      {qs.map((q, i) => {
        if (q.qtype === 'section') return (
          <div key={i} style={{ marginTop: 6 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--txt)' }}>{q.label || 'Section'}</div>
            {q.help_text && <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 2 }}>{q.help_text}</div>}
          </div>
        )
        n++
        const scale: number[] = []
        for (let s = q.scale_min; s <= q.scale_max; s++) scale.push(s)
        return (
          <div key={i} style={{ border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>
              <span style={{ color: accent, fontWeight: 800, marginRight: 6 }}>{String(n).padStart(2, '0')}</span>
              {q.label || <span style={{ color: 'var(--txt3)' }}>Untitled question</span>}
              {q.required && <span style={{ color: RED, marginLeft: 4 }}>*</span>}
            </div>
            <div style={{ marginTop: 10 }}>
              {(q.qtype === 'rating' || q.qtype === 'nps') && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {scale.map(s => (
                    <span key={s} style={{ minWidth: 30, height: 30, borderRadius: 7, border: '1.5px solid var(--bdr)', display: 'grid', placeItems: 'center', fontSize: 12.5, color: 'var(--txt2)', fontVariantNumeric: 'tabular-nums' }}>{s}</span>
                  ))}
                </div>
              )}
              {(q.qtype === 'single_choice' || q.qtype === 'multi_choice') && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {q.options.filter(o => o.trim()).map(o => (
                    <span key={o} style={{ padding: '6px 12px', borderRadius: 8, border: '1.5px solid var(--bdr)', fontSize: 12.5, color: 'var(--txt2)' }}>{o}</span>
                  ))}
                </div>
              )}
              {(q.qtype === 'short_text' || q.qtype === 'long_text') && (
                <div style={{ border: '1.5px solid var(--bdr)', borderRadius: 8, height: q.qtype === 'long_text' ? 56 : 34, background: 'var(--input-bg)' }} />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function QuestionEditor({ q, idx, total, onPatch, onMove, onRemove }: {
  q: Q; idx: number; total: number; onPatch: (up: Partial<Q>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void
}) {
  const meta = QTYPES.find(t => t.value === q.qtype)!
  const isScale = q.qtype === 'rating' || q.qtype === 'nps'
  const isChoice = q.qtype === 'single_choice' || q.qtype === 'multi_choice'
  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: 14, background: q.qtype === 'section' ? 'var(--th-bg)' : 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY }}>{meta.icon}</span>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{meta.label}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          <IconBtn icon="arrow_upward" disabled={idx === 0} onClick={() => onMove(-1)} />
          <IconBtn icon="arrow_downward" disabled={idx === total - 1} onClick={() => onMove(1)} />
          <IconBtn icon="delete" danger onClick={onRemove} />
        </div>
      </div>

      <Input label={q.qtype === 'section' ? 'Section title' : 'Question'} value={q.label} onChange={e => onPatch({ label: e.target.value })} placeholder={q.qtype === 'section' ? 'e.g. Service Evaluation' : 'Type your question'} />

      {q.qtype !== 'section' && (
        <div style={{ marginTop: 10 }}>
          <Input label="Helper text (optional)" value={q.help_text} onChange={e => onPatch({ help_text: e.target.value })} />
        </div>
      )}

      {isScale && (
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Select label="Scale min" value={String(q.scale_min)} onChange={e => onPatch({ scale_min: parseInt(e.target.value) })}>
            <option value="0">0</option><option value="1">1</option>
          </Select>
          <Select label="Scale max" value={String(q.scale_max)} onChange={e => onPatch({ scale_max: parseInt(e.target.value) })}>
            <option value="5">5</option><option value="10">10</option>
          </Select>
          <Input label="Low label" value={q.scale_min_label} onChange={e => onPatch({ scale_min_label: e.target.value })} />
          <Input label="High label" value={q.scale_max_label} onChange={e => onPatch({ scale_max_label: e.target.value })} />
        </div>
      )}

      {isChoice && (
        <div style={{ marginTop: 10 }}>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Options</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {q.options.map((opt, oi) => (
              <div key={oi} style={{ display: 'flex', gap: 6 }}>
                <input value={opt} onChange={e => onPatch({ options: q.options.map((o, j) => j === oi ? e.target.value : o) })}
                  style={{ flex: 1, padding: '7px 10px', border: '1.5px solid var(--input-bdr)', borderRadius: RADIUS.md, background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.base }} />
                <IconBtn icon="close" onClick={() => onPatch({ options: q.options.filter((_, j) => j !== oi) })} />
              </div>
            ))}
            <button onClick={() => onPatch({ options: [...q.options, `Option ${q.options.length + 1}`] })}
              style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', border: '1.5px dashed var(--bdr)', borderRadius: RADIUS.md, background: 'none', color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span> Add option
            </button>
          </div>
        </div>
      )}

      {q.qtype !== 'section' && (
        <label style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: TEXT.sm, color: 'var(--txt)', cursor: 'pointer' }}>
          <input type="checkbox" checked={q.required} onChange={e => onPatch({ required: e.target.checked })} style={{ accentColor: RED, width: 15, height: 15 }} />
          Required
        </label>
      )}
    </div>
  )
}

function IconBtn({ icon, onClick, disabled, danger }: { icon: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ width: 28, height: 28, borderRadius: 6, border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', color: disabled ? 'var(--txt3)' : danger ? RED : 'var(--txt2)', display: 'grid', placeItems: 'center' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )
}
