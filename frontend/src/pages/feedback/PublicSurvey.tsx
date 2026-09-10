import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SurveyExperience, IconCircle, Pulse, cardStyle } from '../../components/SurveyExperience'
import type { SurveyQuestion, SurveyAnswer } from '../../components/SurveyExperience'

const NAVY = '#0E2841'
const MUTE = '#5B6472'
const CANVAS = '#EEF1F6'

interface SurveyData {
  title: string
  description: string
  intro: string
  thank_you: string
  accent_color: string
  signoff_name: string
  signoff_title: string
  recipient_name: string
  already_done: boolean
  prefill?: Record<string, SurveyAnswer>
  questions: SurveyQuestion[]
}

export default function PublicSurvey() {
  const { token } = useParams<{ token: string }>()
  const [params] = useSearchParams()
  const [data, setData] = useState<SurveyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<number, SurveyAnswer>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    fetch(`/api/surveys/r/${token}`)
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j?.detail || 'unavailable')
        return (j.data ?? j) as SurveyData
      })
      .then(d => {
        setData(d)
        if (d.already_done) setDone(true)
        if (d.prefill) {
          const seed: Record<number, SurveyAnswer> = {}
          for (const [k, v] of Object.entries(d.prefill)) seed[Number(k)] = v
          setAnswers(prev => ({ ...seed, ...prev }))
        }
      })
      .catch((e: any) => setError(e.message === 'unavailable' ? 'This survey link is invalid or has expired.' : e.message))
      .finally(() => setLoading(false))
  }, [token])

  // Carry an answer tapped in the email (?aq=<question>&av=<value>) into the page:
  // prefill it and record it immediately, so the headline answer is captured even
  // if the customer never completes the rest.
  useEffect(() => {
    if (!data || data.already_done) return
    const aq = Number(params.get('aq'))
    const av = Number(params.get('av'))
    if (!aq || Number.isNaN(av)) return
    const q = data.questions.find(x => x.id === aq && (x.qtype === 'rating' || x.qtype === 'nps'))
    if (!q || av < q.scale_min || av > q.scale_max) return
    setAnswers(prev => (prev[aq] ? prev : { ...prev, [aq]: { rating: av } }))
    fetch(`/api/surveys/r/${token}/capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: aq, value: av }),
    }).catch(() => {})
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const accent = data?.accent_color || '#C00000'

  async function submit() {
    if (!data) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const answerable = data.questions.filter(q => q.qtype !== 'section')
      const payload = {
        answers: answerable
          .filter(q => {
            const a = answers[q.id]
            if (!a) return false
            if (q.qtype === 'rating' || q.qtype === 'nps') return a.rating !== undefined
            if (q.qtype === 'single_choice' || q.qtype === 'multi_choice') return !!a.choices?.length
            return !!a.text?.trim()
          })
          .map(q => ({ question_id: q.id, rating: answers[q.id]?.rating, text: answers[q.id]?.text ?? '', choices: answers[q.id]?.choices ?? [] })),
      }
      const res = await fetch(`/api/surveys/r/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.detail || 'Could not submit your response. Please try again.')
      setDone(true)
    } catch (e: any) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const shell: React.CSSProperties = { minHeight: '100vh', background: CANVAS, fontFamily: "var(--font-sans)" }

  if (loading) return <div style={{ ...shell, display: 'grid', placeItems: 'center' }}><Pulse accent={accent} /></div>

  if (error) return (
    <div style={{ ...shell, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ ...cardStyle, maxWidth: 480 }}>
        <div style={{ height: 6, background: NAVY }} />
        <div style={{ padding: '44px 34px', textAlign: 'center' }}>
          <IconCircle bg="#FEE2E2" fg="#DC2626" icon="link_off" />
          <h2 style={{ fontSize: 20, fontWeight: 700, color: NAVY, margin: '18px 0 8px' }}>Survey unavailable</h2>
          <p style={{ color: MUTE, fontSize: 14.5, margin: 0, lineHeight: 1.6 }}>{error}</p>
        </div>
      </div>
    </div>
  )

  if (!data) return null

  return (
    <SurveyExperience
      survey={data}
      questions={data.questions}
      answers={answers}
      onChange={setAnswers}
      onSubmit={submit}
      submitting={submitting}
      submitError={submitError}
      done={done}
    />
  )
}
