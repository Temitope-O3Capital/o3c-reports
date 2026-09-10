import type { SurveyMeta, SurveyQuestion } from './SurveyExperience'

// Pixel-mirror of the executive invitation the backend sends
// (premiumSurveyEmailHTML in backend-go/handlers/surveys.go). Keep the two in sync.
const SERIF = "Georgia, 'Times New Roman', serif"
const SANS = "'Segoe UI', Arial, sans-serif"
const PREVIEW_URL = 'https://crm.o3cards.pri/s/8f3c1a9e2b'

// Mirror of pickHeadlineQuestions in surveys.go: overall-satisfaction rating
// (by label, else the first rating) and the recommend/NPS question, overall-first.
function pickHeadline(qs: SurveyQuestion[]): SurveyQuestion[] {
  const rq = qs.filter(q => q.qtype === 'rating' || q.qtype === 'nps')
  const nps = rq.find(q => q.qtype === 'nps')
  const overall = rq.find(q => q.qtype === 'rating' && q.label.toLowerCase().includes('overall')) || rq.find(q => q.qtype === 'rating')
  const out: SurveyQuestion[] = []
  if (overall) out.push(overall)
  if (nps) out.push(nps)
  return out
}

export function EmailPreview({ survey, questions = [], recipientName = 'Ada Okafor' }: { survey: SurveyMeta; questions?: SurveyQuestion[]; recipientName?: string }) {
  const accent = survey.accent_color || '#C00000'
  const intro = survey.intro || 'Your experience matters to us. Please take a few minutes to share your feedback — it directly shapes how we serve you.'
  const eyebrow = survey.department ? `${survey.department} · Customer Experience` : 'Customer Experience'
  const headline = pickHeadline(questions)
  const hasHeadline = headline.length > 0
  const ctaLabel = hasHeadline ? 'Open the full survey' : 'Begin the survey'
  const ctaCaption = hasHeadline
    ? 'Prefer to answer everything at once? Open the full survey · about three minutes'
    : 'Takes about three minutes · Your responses are confidential'

  return (
    <div style={{ background: '#EEF0F4', padding: '26px 12px', minHeight: '100%', fontFamily: SANS, containerType: 'inline-size' }}>
      {/* Inbox meta line */}
      <div style={{ maxWidth: 600, margin: '0 auto 12px', display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px' }}>
        <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#0E2841', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0, fontFamily: SERIF }}>O3</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#1B2536' }}>{survey.title}</div>
          <div style={{ fontSize: 12, color: '#8892a0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>O3 Capital &lt;no-reply@o3cards.com&gt; · to you</div>
        </div>
      </div>

      <div style={{ maxWidth: 600, margin: '0 auto', background: '#fff', borderRadius: 6, overflow: 'hidden', boxShadow: '0 4px 24px rgba(14,40,65,.10)' }}>
        {/* Masthead */}
        <div style={{ background: '#0E2841', padding: '30px 24px 26px', textAlign: 'center' }}>
          <img src="/o3-logo-transparent.svg" alt="O3 Capital" width={40} height={22} style={{ display: 'inline-block', verticalAlign: 'middle' }} />
          <span style={{ display: 'inline-block', verticalAlign: 'middle', marginLeft: 10, color: '#fff', fontSize: 15, fontWeight: 600, letterSpacing: '3px' }}>O3&nbsp;CAPITAL</span>
        </div>
        <div style={{ height: 3, background: accent }} />

        {/* Headline */}
        <div style={{ padding: '38px clamp(20px, 8cqi, 44px) 8px' }}>
          <div style={{ fontSize: 11, letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 700, color: accent }}>{eyebrow}</div>
          <h1 style={{ fontFamily: SERIF, fontSize: 26, lineHeight: 1.2, color: '#0E2841', fontWeight: 400, margin: '12px 0 0' }}>{survey.title}</h1>
        </div>

        {/* Body */}
        <div style={{ padding: '20px clamp(20px, 8cqi, 44px) 0' }}>
          <p style={{ fontSize: 15, color: '#1f2635', margin: '0 0 12px', fontWeight: 600 }}>Dear {recipientName},</p>
          <p style={{ fontSize: 14.5, lineHeight: 1.75, color: '#414a5a', margin: 0 }}>{intro}</p>
        </div>

        {/* Answer-in-email headline questions */}
        {hasHeadline && (
          <div style={{ padding: '26px clamp(20px, 8cqi, 44px) 0' }}>
            <div style={{ fontSize: 11, letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 700, color: accent }}>Answer in one tap</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.6, color: '#6e7889', marginTop: 6 }}>
              Rate us right here — tap a number below and it's recorded straight away, then finish the rest on the next page.
            </div>
            {headline.map(q => (
              <div key={q.id} style={{ marginTop: 18 }}>
                <div style={{ fontSize: 14.5, color: '#1f2635', fontWeight: 600, lineHeight: 1.5, marginBottom: 11 }}>{q.label}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {Array.from({ length: q.scale_max - q.scale_min + 1 }, (_, i) => q.scale_min + i).map(n => (
                    <span key={n} style={{ width: 34, height: 34, lineHeight: '34px', textAlign: 'center', border: '1px solid #d7dce5', borderRadius: 8, color: '#0E2841', fontSize: 14, fontWeight: 600, display: 'inline-block' }}>{n}</span>
                  ))}
                </div>
                {(q.scale_min_label || q.scale_max_label) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', maxWidth: 390, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: '#9aa3b2' }}>{q.scale_min_label}</span>
                    <span style={{ fontSize: 11, color: '#9aa3b2' }}>{q.scale_max_label}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* CTA */}
        <div style={{ padding: '28px clamp(20px, 8cqi, 44px) 8px', textAlign: 'center' }}>
          <span style={{ display: 'inline-block', borderRadius: 8, background: '#0E2841', padding: '15px 40px', color: '#fff', fontWeight: 700, fontSize: 14, letterSpacing: '0.5px' }}>{ctaLabel}</span>
        </div>
        <div style={{ padding: '4px clamp(20px, 8cqi, 44px) 0', textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#9aa3b2' }}>{ctaCaption}</div>
        </div>

        {/* Fallback link */}
        <div style={{ padding: '20px clamp(20px, 8cqi, 44px) 0' }}>
          <div style={{ fontSize: 12, color: '#9aa3b2', borderTop: '1px solid #eef0f5', paddingTop: 16 }}>
            If the button doesn't work, paste this link into your browser:<br />
            <span style={{ color: accent, wordBreak: 'break-all' }}>{PREVIEW_URL}</span>
          </div>
        </div>

        {/* Signature */}
        {survey.signoff_name && (
          <div style={{ padding: '8px clamp(20px, 8cqi, 44px) 0' }}>
            <div style={{ fontSize: 14, color: '#414a5a' }}>With appreciation,</div>
            <div style={{ fontFamily: SERIF, fontSize: 17, color: '#0E2841', marginTop: 8 }}>{survey.signoff_name}</div>
            <div style={{ fontSize: 13, color: '#6e7889', marginTop: 1 }}>{survey.signoff_title}</div>
          </div>
        )}

        {/* Company block */}
        <div style={{ padding: '22px clamp(20px, 8cqi, 44px) 34px' }}>
          <div style={{ fontSize: 13, color: '#0E2841', fontWeight: 700 }}>O3 Capital Nigeria Limited</div>
          <div style={{ fontSize: 12, color: '#6e7889', lineHeight: 1.6, marginTop: 3 }}>
            7th Floor, Churchgate Tower 1, Plot 30, Churchgate Street, Victoria Island, Lagos.<br />
            <span style={{ color: accent }}>www.o3cards.com</span> · <span style={{ fontFamily: SERIF, fontStyle: 'italic', color: accent }}>You deserve more.</span>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px clamp(20px, 8cqi, 44px)', background: '#F1F3F7', color: '#9aa3b2', fontSize: 11, lineHeight: 1.6 }}>
          This message was sent from an automated address (no-reply@o3cards.com); please do not reply. It is intended for the named recipient and may contain confidential information.
        </div>
      </div>
    </div>
  )
}
