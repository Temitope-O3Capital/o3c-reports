// Public page — no auth required. Customers land here from the CSAT link in their ticket-closed email.
// Route: /csat/:token  (configured in App.tsx outside the auth guard)

import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const NAVY = '#0E2841'
const RED  = '#C00000'

type Survey = {
  ticket_ref: string
  subject: string
  already_submitted: boolean
}

const STAR_LABELS = ['', 'Very poor', 'Poor', 'Average', 'Good', 'Excellent']

export default function CSAT() {
  const { token } = useParams<{ token: string }>()
  const [survey, setSurvey]     = useState<Survey | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [rating, setRating]     = useState(0)
  const [hover, setHover]       = useState(0)
  const [comment, setComment]   = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted]   = useState(false)

  useEffect(() => {
    if (!token) return
    fetch(`${API}/api/helpdesk/csat/${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return }
        setSurvey(d)
        if (d.already_submitted) setSubmitted(true)
      })
      .catch(() => setError('Unable to load survey. The link may be expired.'))
      .finally(() => setLoading(false))
  }, [token])

  async function submit() {
    if (rating === 0) return
    setSubmitting(true)
    try {
      const res = await fetch(`${API}/api/helpdesk/csat/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment }),
      })
      if (res.ok) setSubmitted(true)
      else setError('Submission failed. Please try again.')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-4">
      {/* Brand header */}
      <div className="mb-8 text-center">
        <div
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl mb-3"
          style={{ background: NAVY }}
        >
          <span className="material-symbols-rounded text-white text-[20px]">credit_card</span>
          <span className="text-white font-bold text-[15px] tracking-wide">O3 Capital</span>
        </div>
        <p className="text-slate-400 text-[13px]">Customer Support</p>
      </div>

      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border p-8" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        {loading ? (
          <div className="py-12 text-center">
            <div className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-3"
                 style={{ borderColor: `${NAVY}22`, borderTopColor: NAVY }} />
            <p className="text-slate-400 text-[13px]">Loading…</p>
          </div>
        ) : error ? (
          <div className="py-12 text-center">
            <span className="material-symbols-rounded text-[40px] text-slate-300 mb-3 block">error_outline</span>
            <p className="text-slate-600 font-medium mb-1">Link unavailable</p>
            <p className="text-slate-400 text-[13px]">{error}</p>
          </div>
        ) : submitted ? (
          <div className="py-12 text-center">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: '#DCFCE7' }}
            >
              <span className="material-symbols-rounded text-[32px]" style={{ color: '#166534' }}>check_circle</span>
            </div>
            <h2 className="text-[18px] font-semibold text-slate-800 mb-2">Thank you!</h2>
            <p className="text-slate-500 text-[14px]">Your feedback helps us serve you better.</p>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <h2 className="text-[18px] font-semibold text-slate-800 mb-1">How did we do?</h2>
              <p className="text-slate-500 text-[13px]">
                Rate your experience with our support team
                {survey?.ticket_ref && (
                  <span className="ml-1 font-medium text-slate-600">({survey.ticket_ref})</span>
                )}
              </p>
              {survey?.subject && (
                <p className="text-slate-400 text-[12px] mt-1 truncate">{survey.subject}</p>
              )}
            </div>

            {/* Star rating */}
            <div className="flex items-center justify-center gap-2 mb-2">
              {[1, 2, 3, 4, 5].map(s => (
                <button
                  key={s}
                  onMouseEnter={() => setHover(s)}
                  onMouseLeave={() => setHover(0)}
                  onClick={() => setRating(s)}
                  className="transition-transform hover:scale-110 focus:outline-none"
                >
                  <span
                    className="material-symbols-rounded text-[40px]"
                    style={{ color: s <= (hover || rating) ? '#F59E0B' : '#E2E8F0', fontVariationSettings: "'FILL' 1" }}
                  >
                    star
                  </span>
                </button>
              ))}
            </div>
            <p className="text-center text-[13px] font-medium text-slate-500 mb-6 h-5">
              {STAR_LABELS[hover || rating]}
            </p>

            {/* Comment */}
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              rows={3}
              placeholder="Any additional comments? (optional)"
              className="w-full px-3 py-2.5 rounded-xl border text-[13px] text-slate-700 placeholder-slate-300 focus:outline-none resize-none mb-4"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            />

            {error && (
              <p className="text-[12px] text-red-600 mb-3">{error}</p>
            )}

            <button
              onClick={submit}
              disabled={rating === 0 || submitting}
              className="w-full py-3 rounded-xl text-[14px] font-semibold text-white transition-opacity disabled:opacity-40"
              style={{ background: rating === 0 ? '#94A3B8' : NAVY }}
            >
              {submitting ? 'Submitting…' : 'Submit Feedback'}
            </button>
          </>
        )}
      </div>

      <p className="mt-6 text-slate-300 text-[11px]">Powered by O3 Capital · Secure</p>
    </div>
  )
}
