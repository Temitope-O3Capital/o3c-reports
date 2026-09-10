import { useState, useEffect } from 'react'
import { SurveyExperience } from './SurveyExperience'
import type { SurveyMeta, SurveyQuestion, SurveyAnswer } from './SurveyExperience'
import { EmailPreview } from './EmailPreview'
import { TEXT, FW, RADIUS, NAVY } from '../lib/design'

type Mode = 'survey' | 'email'
type Device = 'desktop' | 'tablet' | 'mobile'

// A full-screen preview studio: switch between the email invitation and the live
// survey, across desktop / tablet / mobile frames. Renders from the same components
// the customer sees, so it's a true preview, not an approximation.
export function PreviewStudio({ open, onClose, survey, questions }: {
  open: boolean
  onClose: () => void
  survey: SurveyMeta
  questions: SurveyQuestion[]
}) {
  const [mode, setMode] = useState<Mode>('survey')
  const [device, setDevice] = useState<Device>('desktop')
  const [answers, setAnswers] = useState<Record<number, SurveyAnswer>>({})
  const [done, setDone] = useState(false)
  const [nonce, setNonce] = useState(0) // remount survey to reset interaction

  useEffect(() => {
    if (open) { setAnswers({}); setDone(false); setNonce(n => n + 1) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const viewportH = 'min(74vh, 720px)'
  const previewName = survey.recipient_name || 'Ada Okafor'

  const content = mode === 'email'
    ? <EmailPreview survey={survey} questions={questions} recipientName={previewName} />
    : <SurveyExperience key={nonce} embedded survey={{ ...survey, recipient_name: previewName }} questions={questions} answers={answers} onChange={setAnswers} onSubmit={() => setDone(true)} done={done} />

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(6,12,24,0.66)', backdropFilter: 'blur(2px)', display: 'flex', flexDirection: 'column' }}>
      {/* Top toolbar */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', background: 'var(--card)', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>visibility</span>
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Preview</span>
        </div>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 14, flexWrap: 'wrap' }}>
          <Segmented value={mode} onChange={v => setMode(v as Mode)} options={[
            { value: 'survey', label: 'Survey', icon: 'quiz' },
            { value: 'email', label: 'Email', icon: 'mail' },
          ]} />
          <Segmented value={device} onChange={v => setDevice(v as Device)} iconsOnly options={[
            { value: 'desktop', label: 'Desktop', icon: 'computer' },
            { value: 'tablet', label: 'Tablet', icon: 'tablet_mac' },
            { value: 'mobile', label: 'Mobile', icon: 'smartphone' },
          ]} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {mode === 'survey' && (
            <button onClick={() => { setAnswers({}); setDone(false); setNonce(n => n + 1) }} title="Reset preview"
              style={iconBtn}><span className="material-symbols-rounded" style={{ fontSize: 18 }}>restart_alt</span></button>
          )}
          <button onClick={onClose} title="Close" style={iconBtn}><span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span></button>
        </div>
      </div>

      {/* Stage */}
      <div style={{ flex: 1, overflow: 'auto', padding: '26px 18px', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
        <DeviceFrame device={device} mode={mode} viewportH={viewportH}>{content}</DeviceFrame>
      </div>
    </div>
  )
}

function DeviceFrame({ device, mode, viewportH, children }: { device: Device; mode: Mode; viewportH: string; children: React.ReactNode }) {
  const url = mode === 'email' ? 'no-reply@o3cards.com' : 'crm.o3cards.pri/s/preview'
  if (device === 'desktop') {
    return (
      <div style={{ width: '100%', maxWidth: 980, borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 24px 60px rgba(0,0,0,0.45)', background: '#fff' }}>
        <div style={{ height: 36, background: '#e9edf3', display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', borderBottom: '1px solid #dfe4ec' }}>
          <Dot c="#ff5f57" /><Dot c="#febc2e" /><Dot c="#28c840" />
          <div style={{ marginLeft: 10, flex: 1, maxWidth: 440, height: 21, background: '#fff', borderRadius: 6, fontSize: 11, color: '#8a93a3', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{mode === 'email' ? 'mail' : 'lock'}</span>{url}
          </div>
        </div>
        <div style={{ height: viewportH, overflow: 'auto' }}>{children}</div>
      </div>
    )
  }
  const w = device === 'mobile' ? 392 : 744
  return (
    <div style={{ width: w, maxWidth: '100%', borderRadius: device === 'mobile' ? 40 : 28, padding: device === 'mobile' ? '12px 10px' : '16px 14px', background: '#0b111f', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <div style={{ width: device === 'mobile' ? 52 : 70, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.22)' }} />
      </div>
      <div style={{ borderRadius: device === 'mobile' ? 28 : 16, overflow: 'hidden', background: '#fff', height: viewportH }}>
        <div style={{ height: '100%', overflow: 'auto' }}>{children}</div>
      </div>
    </div>
  )
}

function Dot({ c }: { c: string }) { return <span style={{ width: 11, height: 11, borderRadius: '50%', background: c, display: 'inline-block' }} /> }

function Segmented({ value, onChange, options, iconsOnly }: {
  value: string; onChange: (v: string) => void; iconsOnly?: boolean
  options: { value: string; label: string; icon: string }[]
}) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--th-bg)', borderRadius: RADIUS.lg, padding: 3, gap: 2 }}>
      {options.map(o => {
        const on = value === o.value
        return (
          <button key={o.value} onClick={() => onChange(o.value)} title={o.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: iconsOnly ? '6px 10px' : '6px 14px', borderRadius: RADIUS.md, border: 'none', cursor: 'pointer',
              background: on ? 'var(--card)' : 'transparent', color: on ? NAVY : 'var(--txt2)', fontWeight: on ? FW.bold : FW.medium, fontSize: TEXT.sm, boxShadow: on ? '0 1px 3px rgba(0,0,0,0.12)' : 'none' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{o.icon}</span>
            {!iconsOnly && o.label}
          </button>
        )
      })}
    </div>
  )
}

const iconBtn: React.CSSProperties = { width: 34, height: 34, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer', display: 'grid', placeItems: 'center' }
