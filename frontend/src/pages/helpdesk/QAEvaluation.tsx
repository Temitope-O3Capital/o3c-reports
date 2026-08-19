import { useState, useEffect, useMemo } from 'react'
import { Modal, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost, API } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, BLUE, MONO, SORA, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { QAConfig, QAScores, qaCompute, RATING_META, BAND_COLOR } from '../../lib/qa'
import { toast } from 'sonner'

export interface QACall {
  id: number
  agent_name?: string
  customer_name?: string | null
  phone?: string
  direction?: string
  called_at?: string
  duration_seconds?: number
  /** Drives the in-drawer player — a supervisor scores while listening. */
  has_recording?: boolean
}

const RATING_BTNS = [5, 4, 3, 2, 1, 0]

export default function QAEvaluation({ call, onClose, onSaved }: { call: QACall; onClose: () => void; onSaved?: () => void }) {
  const [cfg, setCfg] = useState<QAConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [scores, setScores] = useState<QAScores>({})
  const [critical, setCritical] = useState(false)
  const [strengths, setStrengths] = useState('')
  const [improvements, setImprovements] = useState('')
  const [coaching, setCoaching] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiFetch<QAConfig>('/api/qa/config')
      // Go marshals an empty section list as JSON null (nil slice), which would
      // crash cfg.sections.map / qaCompute — coerce to an array on the way in.
      .then(c => setCfg(c ? { ...c, sections: Array.isArray(c.sections) ? c.sections : [] } : c))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  const setRating = (key: string, rating: number) => setScores(s => ({ ...s, [key]: { ...s[key], rating, na: false } }))
  const setNA = (key: string) => setScores(s => ({ ...s, [key]: { rating: null, na: true } }))
  const setComment = (key: string, comment: string) => setScores(s => ({ ...s, [key]: { ...(s[key] ?? { rating: null }), comment } }))

  const result = useMemo(() => {
    if (!cfg) return { total: 0, band: 'Needs Improvement', passed: false, rated: 0, totalParams: 0 }
    return qaCompute(cfg.sections, scores, cfg.settings.pass_threshold, cfg.settings.critical_error_auto_fail, critical)
  }, [cfg, scores, critical])

  const bandColor = BAND_COLOR[result.band] ?? NAVY

  async function save() {
    if (!cfg) return
    if (result.rated === 0) { toast.error('Rate at least one parameter'); return }
    setSaving(true)
    try {
      const res = await apiPost<{ total_score: number; rating_band: string; passed: boolean }>('/api/qa/evaluations', {
        call_id: call.id, scores, critical_error: critical,
        strengths, improvements, coaching_notes: coaching,
      })
      toast.success(`Evaluation saved: ${res.total_score}% (${res.rating_band}), ${res.passed ? 'Pass' : 'Fail'}`)
      onSaved?.()
      onClose()
    } catch (e: any) { toast.error(e.message ?? 'Could not save evaluation') }
    finally { setSaving(false) }
  }

  const field: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: SORA, outline: 'none', boxSizing: 'border-box', resize: 'vertical',
  }
  const label: React.CSSProperties = { fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5, display: 'block' }

  return (
    <Modal open onClose={onClose} title="QA Evaluation" width={600} maxHeight="82vh"
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
          {/* live score */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...({ fontFamily: MONO } as any), fontSize: 24, fontWeight: FW.extrabold, color: bandColor }}>{result.total}%</span>
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: bandColor }}>{result.band}</span>
              <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: result.passed ? GREEN : RED }}>{result.passed ? 'PASS' : 'FAIL'}{critical ? ' · Critical error' : ''}</span>
            </span>
            <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{result.rated}/{result.totalParams} rated</span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer', fontFamily: SORA }}>Cancel</button>
            <button onClick={save} disabled={saving || !cfg} style={{ padding: '8px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SORA }}>
              {saving && <Spinner size={13} color="#fff" />}Save Evaluation
            </button>
          </div>
        </div>
      }>
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 50 }}><Spinner size={26} /></div>
      ) : err || !cfg ? (
        <ErrBanner error={err ?? 'Could not load QA form'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: SORA }}>
          {/* Call context */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, padding: '10px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md, fontSize: TEXT.sm }}>
            <span><span style={{ color: 'var(--txt3)' }}>Agent:</span> <b>{call.agent_name || '—'}</b></span>
            <span><span style={{ color: 'var(--txt3)' }}>Customer:</span> {call.customer_name || 'Unknown'}</span>
            <span><span style={{ color: 'var(--txt3)' }}>Direction:</span> {call.direction || '—'}</span>
            {call.called_at && <span><span style={{ color: 'var(--txt3)' }}>Time:</span> {fmtDatetime(call.called_at)}</span>}
          </div>

          {/* The recording, alongside the rubric.
              A supervisor used to listen through one row action and score through
              another, so they graded from memory. The player is sticky so it stays
              reachable while they scroll the criteria, and it remembers where they
              were — scrubbing back to re-hear a moment is the whole job. */}
          {call.has_recording && (
            <div style={{
              position: 'sticky', top: 0, zIndex: 2,
              display: 'flex', alignItems: 'center', gap: SP[3],
              padding: '10px 14px', borderRadius: RADIUS.md,
              background: 'var(--card)', border: `1px solid ${NAVY}33`,
              boxShadow: '0 2px 8px rgba(0,0,0,.06)',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY, flexShrink: 0 }}>graphic_eq</span>
              <audio
                controls
                preload="metadata"
                src={`${API}/api/helpdesk/calls/${call.id}/recording`}
                style={{ flex: 1, minWidth: 0, height: 34 }}
              >
                Your browser cannot play this recording.
              </audio>
            </div>
          )}

          {/* Sections */}
          {cfg.sections.map(sec => (
            <div key={sec.key} style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', background: `${NAVY}08`, borderBottom: '1px solid var(--bdr)' }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{sec.label}</span>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: `${NAVY}12`, padding: '2px 9px', borderRadius: RADIUS.full }}>{sec.weight}%</span>
              </div>
              <div style={{ padding: '4px 14px' }}>
                {sec.params.map((p, i) => {
                  const sc = scores[p.param_key]
                  return (
                    <div key={p.param_key} style={{ padding: '10px 0', borderBottom: i < sec.params.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>
                          {p.param_label}<span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}> · {p.max_points} pts</span>
                        </span>
                        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                          {RATING_BTNS.map(v => {
                            const on = sc?.rating === v && !sc?.na
                            const c = RATING_META[v].color
                            return (
                              <button key={v} onClick={() => setRating(p.param_key, v)} title={RATING_META[v].label}
                                style={{ width: 30, height: 30, borderRadius: 7, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.bold, fontFamily: MONO,
                                  border: `1.5px solid ${on ? c : 'var(--bdr)'}`, background: on ? c : 'transparent', color: on ? '#fff' : 'var(--txt2)' }}>{v}</button>
                            )
                          })}
                          <button onClick={() => setNA(p.param_key)} title="Not Applicable"
                            style={{ height: 30, padding: '0 9px', borderRadius: 7, cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: SORA,
                              border: `1.5px solid ${sc?.na ? 'var(--txt3)' : 'var(--bdr)'}`, background: sc?.na ? 'var(--chip-bg)' : 'transparent', color: sc?.na ? 'var(--txt)' : 'var(--txt3)' }}>N/A</button>
                        </div>
                      </div>
                      {(sc?.rating != null || sc?.na) && (
                        <input value={sc?.comment ?? ''} onChange={e => setComment(p.param_key, e.target.value)} placeholder="Comment (optional)…"
                          style={{ ...field, marginTop: 6, height: 30, padding: '4px 9px', fontSize: TEXT.xs }} />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

          {/* Supervisor inputs */}
          <div style={{ border: `1px solid ${AMBER}40`, borderRadius: RADIUS.lg, padding: 14, background: `${AMBER}06`, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>Critical Error?</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {[{ v: true, l: 'Yes', c: RED }, { v: false, l: 'No', c: GREEN }].map(o => (
                  <button key={o.l} onClick={() => setCritical(o.v)}
                    style={{ padding: '4px 14px', borderRadius: RADIUS.md, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: SORA,
                      border: `1.5px solid ${critical === o.v ? o.c : 'var(--bdr)'}`, background: critical === o.v ? `${o.c}15` : 'transparent', color: critical === o.v ? o.c : 'var(--txt2)' }}>{o.l}</button>
                ))}
              </div>
              {critical && cfg.settings.critical_error_auto_fail && <span style={{ fontSize: TEXT.xs, color: RED, fontWeight: FW.semibold }}>Auto-fails this evaluation</span>}
            </div>
            <div><label style={label}>Strengths</label><textarea rows={2} value={strengths} onChange={e => setStrengths(e.target.value)} placeholder="What the agent did well…" style={field} /></div>
            <div><label style={label}>Areas for Improvement</label><textarea rows={2} value={improvements} onChange={e => setImprovements(e.target.value)} placeholder="What to work on…" style={field} /></div>
            <div><label style={label}>Coaching Plan / Notes</label><textarea rows={2} value={coaching} onChange={e => setCoaching(e.target.value)} placeholder="Coaching actions & follow-up…" style={field} /></div>
          </div>
        </div>
      )}
    </Modal>
  )
}
