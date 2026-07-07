import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'

const NAVY = '#0E2841'
const GREEN = '#16A34A'
const AMBER = '#D97706'
const RED = '#C00000'
const STAR_GOLD = '#F59E0B'

interface SurveyData {
  ticket_ref: string
  subject: string
  customer_name: string | null
  csat_score: number | null
}

function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0)
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 4,
            fontSize: 40,
            lineHeight: 1,
            color: n <= (hover || value) ? STAR_GOLD : '#D1D5DB',
            transition: 'color 100ms',
          }}
          title={['', 'Very poor', 'Poor', 'Average', 'Good', 'Excellent'][n]}
        >
          ★
        </button>
      ))}
    </div>
  )
}

const LABELS = ['', 'Very poor', 'Poor', 'Average', 'Good', 'Excellent']

export default function CSATSurvey() {
  const { token } = useParams<{ token: string }>()

  const [data, setData] = useState<SurveyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [score, setScore] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const scoreParam = new URLSearchParams(window.location.search).get('score')
    if (scoreParam) {
      const n = parseInt(scoreParam, 10)
      if (n >= 1 && n <= 5) setScore(n)
    }

    fetch(`/api/helpdesk/csat/${token}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((d: SurveyData) => {
        setData(d)
        if (d.csat_score) {
          setDone(true)
        }
      })
      .catch(() => setError('This survey link is invalid or has expired.'))
      .finally(() => setLoading(false))
  }, [token])

  async function submit() {
    if (!score) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/helpdesk/csat/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, comment }),
      })
      if (!res.ok) throw new Error(await res.text())
      setDone(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const cardStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: '#F4F6F8',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    fontFamily: "'Sora', 'Inter', sans-serif",
  }

  const boxStyle: React.CSSProperties = {
    background: '#fff',
    borderRadius: 16,
    boxShadow: '0 4px 24px rgba(0,0,0,.08)',
    padding: '40px 36px',
    maxWidth: 480,
    width: '100%',
    textAlign: 'center',
  }

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={boxStyle}>
          <div style={{ color: 'var(--chart-lbl)', fontSize: 14 }}>Loading survey…</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={cardStyle}>
        <div style={boxStyle}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: NAVY, margin: '0 0 8px' }}>Survey unavailable</h2>
          <p style={{ color: '#6B7280', fontSize: 14, margin: 0 }}>{error}</p>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div style={cardStyle}>
        <div style={boxStyle}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: NAVY, margin: '0 0 10px' }}>Thank you!</h2>
          <p style={{ color: '#6B7280', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
            Your feedback has been recorded. We appreciate you taking the time to let us know how we did.
          </p>
          <div style={{ marginTop: 24, padding: '12px 16px', background: '#F0F9FF', borderRadius: 10, fontSize: 13, color: '#0369A1' }}>
            O3 Capital Customer Support
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      <div style={boxStyle}>
        {/* Brand */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          background: NAVY, color: '#fff', borderRadius: 8,
          padding: '6px 14px', fontSize: 13, fontWeight: 700, marginBottom: 28,
        }}>
          O3 Capital
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 700, color: NAVY, margin: '0 0 6px' }}>
          How did we do?
        </h1>

        {data && (
          <p style={{ fontSize: 13, color: '#6B7280', margin: '0 0 6px' }}>
            {data.customer_name ? `Hi ${data.customer_name},` : 'Hi there,'} your request{' '}
            <strong style={{ color: NAVY }}>#{data.ticket_ref}</strong> has been resolved.
          </p>
        )}
        {data?.subject && (
          <p style={{ fontSize: 12, color: 'var(--chart-lbl)', margin: '0 0 28px', fontStyle: 'italic' }}>
            "{data.subject}"
          </p>
        )}

        <p style={{ fontSize: 14, color: '#374151', fontWeight: 600, marginBottom: 16 }}>
          Rate your experience (1 = Poor, 5 = Excellent)
        </p>

        <StarRating value={score} onChange={setScore} />

        {score > 0 && (
          <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: score >= 4 ? GREEN : score === 3 ? AMBER : RED }}>
            {LABELS[score]}
          </div>
        )}

        <div style={{ marginTop: 24, textAlign: 'left' }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: '#6B7280', display: 'block', marginBottom: 6 }}>
            Additional comments (optional)
          </label>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            maxLength={500}
            rows={4}
            placeholder="Tell us more about your experience…"
            style={{
              width: '100%', resize: 'vertical', padding: '10px 12px',
              border: '1px solid #D1D5DB', borderRadius: 8, fontSize: 13,
              color: '#374151', lineHeight: 1.5, outline: 'none',
              boxSizing: 'border-box', fontFamily: 'inherit',
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--chart-lbl)', textAlign: 'right', marginTop: 2 }}>
            {comment.length}/500
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: `${RED}10`, borderRadius: 8, color: RED, fontSize: 13 }}>
            {error}
          </div>
        )}

        <button
          onClick={submit}
          disabled={!score || submitting}
          style={{
            marginTop: 20, width: '100%', padding: '12px 0',
            background: score ? NAVY : '#D1D5DB',
            color: score ? '#fff' : 'var(--chart-lbl)',
            border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700,
            cursor: score && !submitting ? 'pointer' : 'not-allowed',
            transition: 'background 150ms',
          }}
        >
          {submitting ? 'Submitting…' : 'Submit Feedback'}
        </button>

        <p style={{ marginTop: 20, fontSize: 11, color: 'var(--chart-lbl)' }}>
          O3 Capital · Customer Support Survey
        </p>
      </div>
    </div>
  )
}
