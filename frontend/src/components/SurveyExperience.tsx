import { useState, useMemo, useRef } from 'react'

// The customer-facing survey UI — a premium, editorial experience shared by the
// live public page (/s/:token) and the in-app Preview, so they are pixel-identical.
// Fully controlled: parent owns the answers map and the submit action.

const NAVY = '#0E2841'
const INK = '#1F2635'
const BODY = '#414A5A'
const MUTE = '#6E7889'
const FAINT = '#9AA3B2'
const LINE = '#E7E9F0'
const HAIR = '#EEF0F5'
const PAPER = '#F1F3F7'
const SERIF = "var(--font-sans)"
const SANS = "var(--font-sans)"

export interface SurveyQuestion {
  id: number
  qtype: 'section' | 'rating' | 'nps' | 'single_choice' | 'multi_choice' | 'short_text' | 'long_text'
  label: string
  help_text: string
  required: boolean
  scale_min: number
  scale_max: number
  scale_min_label: string
  scale_max_label: string
  options: string[]
}
export interface SurveyMeta {
  title: string
  intro?: string
  thank_you?: string
  accent_color?: string
  department?: string
  signoff_name?: string
  signoff_title?: string
  recipient_name?: string
}
export interface SurveyAnswer { rating?: number; text?: string; choices?: string[] }

// NPS band tones — restrained, not toy-bright.
export function npsColor(n: number): string {
  if (n <= 6) return '#B23B33'
  if (n <= 8) return '#B07D2C'
  return '#2E7D52'
}
function npsBand(n: number) { return n <= 6 ? 'Detractor' : n <= 8 ? 'Passive' : 'Promoter' }

interface Props {
  survey: SurveyMeta
  questions: SurveyQuestion[]
  answers: Record<number, SurveyAnswer>
  onChange: (next: Record<number, SurveyAnswer>) => void
  onSubmit: () => void
  submitting?: boolean
  submitError?: string | null
  done?: boolean
  embedded?: boolean
}

export function SurveyExperience({ survey, questions, answers, onChange, onSubmit, submitting, submitError, done, embedded }: Props) {
  const [attempted, setAttempted] = useState(false)
  const firstMissingRef = useRef<HTMLDivElement>(null)
  const accent = survey.accent_color || '#C00000'
  const eyebrow = (survey.department ? `${survey.department} · ` : '') + 'Customer Experience'

  const answerable = useMemo(() => questions.filter(q => q.qtype !== 'section'), [questions])
  const requiredQs = useMemo(() => answerable.filter(q => q.required), [answerable])

  function isAnswered(q: SurveyQuestion): boolean {
    const a = answers[q.id]
    if (!a) return false
    if (q.qtype === 'rating' || q.qtype === 'nps') return a.rating !== undefined
    if (q.qtype === 'single_choice' || q.qtype === 'multi_choice') return !!a.choices?.length
    return !!a.text?.trim()
  }
  const answeredCount = answerable.filter(isAnswered).length
  const requiredMissing = requiredQs.filter(q => !isAnswered(q))
  const progress = answerable.length ? Math.round((answeredCount / answerable.length) * 100) : 0

  const setRating = (id: number, v: number) => onChange({ ...answers, [id]: { ...answers[id], rating: v } })
  const setText = (id: number, v: string) => onChange({ ...answers, [id]: { ...answers[id], text: v } })
  const toggleChoice = (id: number, opt: string, multi: boolean) => {
    const cur = answers[id]?.choices ?? []
    const next = multi ? (cur.includes(opt) ? cur.filter(o => o !== opt) : [...cur, opt]) : [opt]
    onChange({ ...answers, [id]: { ...answers[id], choices: next } })
  }

  function handleSubmit() {
    setAttempted(true)
    if (requiredMissing.length) { firstMissingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
    onSubmit()
  }

  // container-type makes descendant `cqi` units resolve against THIS element's width
  // (not the viewport). That is what makes the survey adapt to a real device AND to
  // the fixed-width device frames in the Preview studio — a true responsive preview.
  const shell: React.CSSProperties = {
    minHeight: embedded ? '100%' : '100vh', height: embedded ? '100%' : undefined, overflowY: embedded ? 'auto' : undefined,
    background: PAPER, fontFamily: SANS, color: BODY, WebkitFontSmoothing: 'antialiased',
    containerType: 'inline-size',
  }
  const COL = 660
  const padX = 'clamp(16px, 4.2cqi, 24px)'      // page gutter, scales with width
  const titleSize = 'clamp(24px, 6.2cqi, 33px)'

  // ── Thank-you ───────────────────────────────────────────────────────────────
  if (done) return (
    <div style={{ ...shell, display: 'grid', placeItems: 'center', padding: '40px 20px' }}>
      <div style={{ maxWidth: 520, width: '100%', textAlign: 'center' }}>
        <Wordmark accent={accent} center />
        <div style={{ width: 44, height: 44, borderRadius: '50%', border: `1.5px solid ${accent}`, display: 'grid', placeItems: 'center', margin: '30px auto 0' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 24, color: accent }}>check</span>
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 500, color: NAVY, margin: '22px 0 0', letterSpacing: '-0.4px' }}>Thank you.</h1>
        <p style={{ fontSize: 15.5, lineHeight: 1.75, color: BODY, margin: '14px auto 0', maxWidth: 400 }}>
          {survey.thank_you || 'Your feedback has been received. We are grateful for the time you have taken to help us serve you better.'}
        </p>
        {survey.signoff_name && (
          <div style={{ marginTop: 30, paddingTop: 22, borderTop: `1px solid ${LINE}`, display: 'inline-block' }}>
            <div style={{ fontFamily: SERIF, fontSize: 16, color: NAVY, fontWeight: 500 }}>{survey.signoff_name}</div>
            <div style={{ fontSize: 13, color: MUTE, marginTop: 2 }}>{survey.signoff_title}</div>
          </div>
        )}
        <div style={{ marginTop: 26, fontSize: 11, letterSpacing: '1.5px', color: FAINT, textTransform: 'uppercase', fontWeight: 600 }}>O3 Capital · You deserve more</div>
      </div>
    </div>
  )

  let firstMissingAssigned = false

  return (
    <div style={shell}>
      {/* Progress */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'rgba(241,243,247,0.92)', backdropFilter: 'blur(10px)', borderBottom: `1px solid ${LINE}` }}>
        <div style={{ height: 3, background: HAIR }}><div style={{ height: '100%', width: `${progress}%`, background: accent, transition: 'width 280ms ease' }} /></div>
        <div style={{ maxWidth: COL, margin: '0 auto', padding: `9px ${padX}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Wordmark accent={accent} />
          <span style={{ fontSize: 11.5, color: MUTE, fontWeight: 600, letterSpacing: '0.02em' }}>
            {answeredCount}<span style={{ color: FAINT }}> / {answerable.length}</span>
          </span>
        </div>
      </div>

      {/* Masthead */}
      <div style={{ background: NAVY, color: '#fff' }}>
        <div style={{ maxWidth: COL, margin: '0 auto', padding: `clamp(30px,7cqi,44px) ${padX} clamp(28px,6cqi,40px)` }}>
          <div style={{ fontSize: 11, letterSpacing: '2.4px', textTransform: 'uppercase', fontWeight: 700, color: '#93A7BC' }}>{eyebrow}</div>
          <h1 style={{ fontFamily: SERIF, fontSize: titleSize, lineHeight: 1.14, fontWeight: 500, margin: '14px 0 0', letterSpacing: '-0.6px' }}>{survey.title}</h1>
          <div style={{ width: 44, height: 3, background: accent, marginTop: 20, borderRadius: 2 }} />
        </div>
      </div>

      <div style={{ maxWidth: COL, margin: '0 auto', padding: `clamp(24px,5cqi,34px) ${padX} 72px` }}>
        {/* Intro */}
        <p style={{ margin: 0, fontSize: 15.5, color: INK, fontWeight: 600 }}>{survey.recipient_name ? `Dear ${survey.recipient_name},` : 'Dear Valued Customer,'}</p>
        {survey.intro && <p style={{ margin: '12px 0 0', fontSize: 15, color: BODY, lineHeight: 1.78 }}>{survey.intro}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 20, paddingTop: 18, borderTop: `1px solid ${LINE}`, fontSize: 12.5, color: MUTE }}>
          <Meta icon="schedule" text="About 3 minutes" />
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: FAINT }} />
          <Meta icon="lock" text="Confidential" />
        </div>

        {attempted && requiredMissing.length > 0 && (
          <div style={{ marginTop: 22, padding: '13px 16px', background: '#FCF3F2', border: '1px solid #F1C9C4', borderRadius: 10, color: '#9C332B', fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 9 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>error</span>
            Please answer the {requiredMissing.length} required question{requiredMissing.length > 1 ? 's' : ''} highlighted below.
          </div>
        )}

        {/* Questions */}
        <div style={{ marginTop: 30, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {(() => { let sec = 0; return questions.map((q, qi) => {
            if (q.qtype === 'section') {
              sec++
              return (
                <div key={q.id} style={{ marginTop: qi === 0 ? 0 : 22 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
                    <span style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 500, color: accent, fontVariantNumeric: 'tabular-nums' }}>{String(sec).padStart(2, '0')}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: '1.4px', textTransform: 'uppercase', color: NAVY, whiteSpace: 'nowrap' }}>{q.label}</span>
                    <span style={{ flex: 1, height: 1, background: LINE }} />
                  </div>
                  {q.help_text && <p style={{ margin: '10px 0 0 34px', fontSize: 13, color: MUTE, lineHeight: 1.6 }}>{q.help_text}</p>}
                </div>
              )
            }
            const missing = attempted && q.required && !isAnswered(q)
            let ref: React.RefObject<HTMLDivElement> | undefined
            if (missing && !firstMissingAssigned) { ref = firstMissingRef; firstMissingAssigned = true }
            const num = answerable.indexOf(q) + 1
            return (
              <div key={q.id} ref={ref} style={{ background: '#fff', borderRadius: 14, padding: `20px clamp(15px,3.6cqi,24px)`, border: `1px solid ${missing ? '#E7B4AE' : LINE}`, boxShadow: missing ? '0 0 0 3px rgba(178,59,51,0.08)' : '0 1px 2px rgba(16,24,40,0.03)' }}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                  <span style={{ flexShrink: 0, fontFamily: SERIF, fontSize: 15, fontWeight: 500, color: FAINT, fontVariantNumeric: 'tabular-nums', marginTop: 1 }}>{String(num).padStart(2, '0')}</span>
                  <div>
                    <div style={{ fontSize: 15.5, fontWeight: 600, color: INK, lineHeight: 1.5 }}>{q.label}{q.required && <span style={{ color: accent, marginLeft: 5, fontWeight: 600 }}>*</span>}</div>
                    {q.help_text && <div style={{ fontSize: 13, color: MUTE, marginTop: 4, lineHeight: 1.55 }}>{q.help_text}</div>}
                  </div>
                </div>
                {(q.qtype === 'rating' || q.qtype === 'nps') && (
                  <ScalePicker q={q} value={answers[q.id]?.rating} onPick={v => setRating(q.id, v)} accent={accent} nps={q.qtype === 'nps'} />
                )}
                {(q.qtype === 'single_choice' || q.qtype === 'multi_choice') && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {q.options.map(opt => {
                      const on = answers[q.id]?.choices?.includes(opt)
                      const multi = q.qtype === 'multi_choice'
                      return (
                        <button key={opt} onClick={() => toggleChoice(q.id, opt, multi)}
                          style={{ display: 'flex', alignItems: 'center', gap: 11, textAlign: 'left', padding: '11px 14px', borderRadius: 10, cursor: 'pointer', border: `1.5px solid ${on ? accent : LINE}`, background: on ? `${accent}0A` : '#fff', color: on ? INK : BODY, fontSize: 14.5, fontWeight: on ? 600 : 500, transition: 'all 120ms' }}>
                          <span style={{ width: 18, height: 18, flexShrink: 0, borderRadius: multi ? 5 : '50%', border: `1.5px solid ${on ? accent : '#C7CDD9'}`, background: on ? accent : '#fff', display: 'grid', placeItems: 'center' }}>
                            {on && <span className="material-symbols-rounded" style={{ fontSize: 13, color: '#fff' }}>{multi ? 'check' : 'circle'}</span>}
                          </span>
                          {opt}
                        </button>
                      )
                    })}
                  </div>
                )}
                {(q.qtype === 'long_text' || q.qtype === 'short_text') && (
                  <textarea spellCheck value={answers[q.id]?.text ?? ''} onChange={e => setText(q.id, e.target.value)}
                    rows={q.qtype === 'long_text' ? 4 : 2} maxLength={2000} placeholder="Share your thoughts…"
                    onFocus={e => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}14` }}
                    onBlur={e => { e.currentTarget.style.borderColor = LINE; e.currentTarget.style.boxShadow = 'none' }}
                    style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '12px 14px', border: `1.5px solid ${LINE}`, borderRadius: 10, fontSize: 14.5, color: INK, lineHeight: 1.65, outline: 'none', fontFamily: SANS, background: '#fff', transition: 'border-color 120ms, box-shadow 120ms' }} />
                )}
              </div>
            )
          }) })()}
        </div>

        {submitError && (
          <div style={{ marginTop: 18, padding: '13px 16px', background: '#FCF3F2', border: '1px solid #F1C9C4', borderRadius: 10, color: '#9C332B', fontSize: 13.5, fontWeight: 600 }}>{submitError}</div>
        )}

        <button onClick={handleSubmit} disabled={submitting}
          style={{ marginTop: 26, width: '100%', padding: '16px 0', borderRadius: 11, border: 'none', cursor: submitting ? 'wait' : 'pointer', background: NAVY, color: '#fff', fontSize: 14.5, fontWeight: 700, letterSpacing: '0.4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10, boxShadow: '0 8px 22px rgba(14,40,65,0.22)', opacity: submitting ? 0.75 : 1, transition: 'opacity 150ms' }}>
          {submitting ? <><Pulse accent="#fff" small /> Submitting…</> : <>Submit my feedback <span className="material-symbols-rounded" style={{ fontSize: 18 }}>arrow_forward</span></>}
        </button>

        {/* Signature / footer */}
        <div style={{ marginTop: 40, paddingTop: 26, borderTop: `1px solid ${LINE}` }}>
          {survey.signoff_name && (
            <>
              <div style={{ fontSize: 13.5, color: BODY }}>With appreciation,</div>
              <div style={{ fontFamily: SERIF, fontSize: 16.5, color: NAVY, fontWeight: 500, marginTop: 8 }}>{survey.signoff_name}</div>
              <div style={{ fontSize: 13, color: MUTE, marginTop: 1 }}>{survey.signoff_title}</div>
            </>
          )}
          <div style={{ marginTop: 18, fontSize: 12, color: FAINT, lineHeight: 1.7 }}>
            Your responses are confidential and reviewed by our Customer Experience team.<br />
            <span style={{ color: MUTE, fontWeight: 600 }}>O3 Capital Nigeria Limited</span> · <span style={{ fontFamily: SERIF, fontStyle: 'italic', color: accent }}>You deserve more.</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Meta({ icon, text }: { icon: string; text: string }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span className="material-symbols-rounded" style={{ fontSize: 15, color: FAINT }}>{icon}</span>{text}</span>
}

function Wordmark({ accent, center }: { accent: string; center?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, justifyContent: center ? 'center' : undefined }}>
      <img src="/o3-logo.svg" alt="" width={30} height={18} style={{ display: 'block' }} />
      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '1.6px', color: NAVY }}>O3&nbsp;CAPITAL</span>
      <span style={{ width: 1, height: 12, background: accent, opacity: 0.5 }} />
    </span>
  )
}

function ScalePicker({ q, value, onPick, accent, nps }: { q: SurveyQuestion; value?: number; onPick: (v: number) => void; accent: string; nps: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const nums: number[] = []
  for (let i = q.scale_min; i <= q.scale_max; i++) nums.push(i)
  const active = hover ?? value
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${nums.length}, 1fr)`, gap: 5 }}>
        {nums.map(n => {
          const on = value === n
          // Rating: single-accent, with a subtle "filled trail" up to the choice.
          // NPS: three restrained bands, coloured only on the selected value.
          const col = nps ? npsColor(n) : accent
          const trail = !nps && active !== undefined && active !== null && n <= active
          const litHover = nps && hover === n
          return (
            <button key={n} type="button" onClick={() => onPick(n)} onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(null)} aria-label={`${n}`}
              style={{
                aspectRatio: '1 / 1', minHeight: 36, borderRadius: 9, cursor: 'pointer', fontFamily: SANS,
                border: `1.5px solid ${on ? col : trail || litHover ? `${col}66` : '#DCE1EA'}`,
                background: on ? col : trail ? `${col}12` : litHover ? `${col}0E` : '#fff',
                color: on ? '#fff' : trail || litHover ? col : '#8892A0',
                fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                transition: 'all 110ms ease', transform: on ? 'translateY(-1px)' : 'none', boxShadow: on ? `0 5px 12px ${col}44` : 'none',
              }}>{n}</button>
          )
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 9, fontSize: 11.5, color: MUTE, fontWeight: 600 }}>
        <span style={{ maxWidth: '46%' }}>{q.scale_min_label || q.scale_min}</span>
        <span style={{ maxWidth: '46%', textAlign: 'right' }}>{q.scale_max_label || q.scale_max}</span>
      </div>
      {value !== undefined && (
        <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12.5, fontWeight: 700, color: nps ? npsColor(value) : accent }}>
          {nps ? `${npsBand(value)} · ${value}` : `${value} of ${q.scale_max}`}
        </div>
      )}
    </div>
  )
}

export function IconCircle({ bg, fg, icon, big }: { bg: string; fg: string; icon: string; big?: boolean }) {
  const s = big ? 64 : 54
  return <div style={{ width: s, height: s, borderRadius: '50%', background: bg, display: 'grid', placeItems: 'center', margin: '0 auto' }}><span className="material-symbols-rounded" style={{ fontSize: big ? 32 : 26, color: fg }}>{icon}</span></div>
}
export function Pulse({ accent, small }: { accent: string; small?: boolean }) {
  const s = small ? 16 : 30
  return <div style={{ width: s, height: s, borderRadius: '50%', border: `${small ? 2 : 3}px solid ${accent}33`, borderTopColor: accent, animation: 'spin 0.7s linear infinite' }} />
}
export const cardStyle: React.CSSProperties = { background: '#fff', borderRadius: 16, border: `1px solid ${LINE}`, overflow: 'hidden', boxShadow: '0 1px 2px rgba(16,24,40,0.04), 0 10px 30px rgba(16,24,40,0.05)' }
