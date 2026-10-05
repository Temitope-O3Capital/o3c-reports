import { useState, useEffect, useCallback } from 'react'
import { SectionCard, Spinner, ErrBanner, Modal } from '../../components/UI'
import { RecordingModal } from '../../components/RecordingPlayer'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, SORA, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// AI-assisted call QA: an on-demand transcribe-and-score pass over one call's
// recording, run entirely on this box (whisper.cpp + a local Ollama model —
// nothing about the call leaves the building). Deliberately separate from the
// "Quality (QA)" tab's formal evaluator scorecard: that system scores against
// weighted compliance parameters and feeds coaching/pass-fail records: this
// one is a fast triage signal — "here's a specific reason to look" — not a
// verdict. Every flag still needs a human to read the transcript (and listen,
// if the reason isn't self-evident) before it's marked reviewed.

const num = (v: any) => Number(v ?? 0) || 0
const scoreColor = (s: number) => (s >= 4 ? GREEN : s >= 3 ? AMBER : RED)

function Pill({ text, color }: { text: string; color: string }) {
  return <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.full, background: `${color}18`, color, whiteSpace: 'nowrap' }}>{text}</span>
}

const STATUS_COLOR: Record<string, string> = { pending: AMBER, reviewed: NAVY, dismissed: 'var(--txt3)', actioned: GREEN }
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', reviewed: 'Reviewed', dismissed: 'Dismissed', actioned: 'Actioned' }

// ── Run QA on a call ─────────────────────────────────────────────────────────
function RunQA({ onDone }: { onDone: () => void }) {
  const [callId, setCallId] = useState('')
  const [running, setRunning] = useState(false)

  async function run() {
    const id = callId.trim()
    if (!id) return
    setRunning(true)
    try {
      await apiFetch(`/api/helpdesk/calls/${id}/qa-run`, { method: 'POST', timeoutMs: 9 * 60_000 })
      toast.success('QA scored — see the result below')
      setCallId('')
      onDone()
    } catch (e: any) { toast.error(e.message) } finally { setRunning(false) }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input value={callId} onChange={e => setCallId(e.target.value)} placeholder="Call ID" disabled={running}
        onKeyDown={e => { if (e.key === 'Enter') run() }}
        style={{ width: 110, height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)' }} />
      <button onClick={run} disabled={running || !callId.trim()}
        style={{ height: 32, padding: '0 14px', borderRadius: RADIUS.md, border: 'none', cursor: running ? 'default' : 'pointer', fontFamily: SORA, fontSize: TEXT.sm, fontWeight: FW.semibold, background: NAVY, color: '#fff', opacity: running || !callId.trim() ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {running && <Spinner size={13} />}{running ? 'Transcribing…' : 'Run QA'}
      </button>
    </div>
  )
}

// ── Flag detail modal ────────────────────────────────────────────────────────
function FlagDetail({ flag, onClose, onUpdated }: { flag: any; onClose: () => void; onUpdated: () => void }) {
  const [notes, setNotes] = useState(flag.review_notes ?? '')
  const [saving, setSaving] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const errors: string[] = Array.isArray(flag.errors_noted) ? flag.errors_noted : []

  async function setStatus(status: 'reviewed' | 'dismissed' | 'actioned') {
    setSaving(status)
    try {
      await apiFetch(`/api/helpdesk/qa/flags/${flag.id}/review`, { method: 'POST', body: JSON.stringify({ status, notes }) })
      toast.success(`Marked ${STATUS_LABEL[status].toLowerCase()}`)
      onUpdated(); onClose()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(null) }
  }

  return (
    <Modal open onClose={onClose} title="Call QA Flag" width={640} maxHeight="88vh">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SORA }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ ...NUM, fontSize: 22, fontWeight: FW.extrabold, color: scoreColor(num(flag.professionalism_score)) }}>{flag.professionalism_score}/5</div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Professionalism</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ ...NUM, fontSize: 22, fontWeight: FW.extrabold, color: scoreColor(num(flag.clarity_score)) }}>{flag.clarity_score}/5</div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Clarity</div>
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right', fontSize: TEXT.xs, color: 'var(--txt2)' }}>
            <div><b>{flag.agent_name || '—'}</b></div>
            <div>{flag.customer_name || 'Unknown'} · {fmtDatetime(flag.started_at)}</div>
            <button onClick={() => setPlaying(true)} style={{ marginTop: 4, fontSize: TEXT.xs, color: NAVY, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Listen to recording</button>
          </div>
        </div>

        {flag.flag_for_review && (
          <div style={{ padding: 10, background: `${AMBER}10`, border: `1px solid ${AMBER}40`, borderRadius: RADIUS.md, fontSize: TEXT.sm }}>
            <b style={{ color: AMBER }}>Why flagged:</b> {flag.reason}
          </div>
        )}

        {errors.length > 0 && (
          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Errors Noted</div>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {errors.map((e, i) => <li key={i} style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{e}</li>)}
            </ul>
          </div>
        )}

        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Transcript (auto-generated, may contain mishearing errors)</div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5, maxHeight: 220, overflowY: 'auto', padding: 10, background: 'var(--th-bg)', borderRadius: RADIUS.md, whiteSpace: 'pre-wrap' }}>{flag.transcript}</div>
        </div>

        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>Review</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Pill text={STATUS_LABEL[flag.review_status] ?? flag.review_status} color={STATUS_COLOR[flag.review_status] ?? NAVY} />
            {flag.reviewed_at && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(flag.reviewed_at)}</span>}
          </div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (what you heard, what you did about it)…" rows={3}
            style={{ width: '100%', padding: 10, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: 'inherit', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {(['reviewed', 'dismissed', 'actioned'] as const).map(s => (
              <button key={s} onClick={() => setStatus(s)} disabled={saving !== null}
                style={{ flex: 1, height: 32, borderRadius: RADIUS.md, cursor: saving ? 'default' : 'pointer', fontFamily: SORA, fontSize: TEXT.sm, fontWeight: FW.semibold,
                  border: `1px solid ${STATUS_COLOR[s]}50`, background: `${STATUS_COLOR[s]}12`, color: STATUS_COLOR[s], opacity: saving && saving !== s ? 0.5 : 1 }}>
                {saving === s ? <Spinner size={13} /> : STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {playing && <RecordingModal callId={flag.call_id} title={`Recording · ${flag.customer_name || flag.agent_name || 'Call'}`} onClose={() => setPlaying(false)} />}
    </Modal>
  )
}

// ── Main list ────────────────────────────────────────────────────────────────
export default function CallQAFlags() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [agent, setAgent] = useState('')
  const [status, setStatus] = useState('')
  const [flaggedOnly, setFlaggedOnly] = useState(true)
  const [openFlag, setOpenFlag] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (agent.trim()) p.set('agent', agent.trim())
      if (status) p.set('status', status)
      if (flaggedOnly) p.set('flagged_only', 'true')
      setRows(await apiFetch<any[]>(`/api/helpdesk/qa/flags?${p}`))
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [agent, status, flaggedOnly])
  useEffect(() => { load() }, [load])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <SectionCard title="Run QA on a Call" subtitle="Transcribes and scores one call's recording against the QA rubric — takes 1-3 minutes">
        <RunQA onDone={load} />
      </SectionCard>

      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="Call QA Flags" subtitle="A flag is a reason to look, not a verdict — read the transcript before acting on it" badge={rows.length} padding={false}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input value={agent} onChange={e => setAgent(e.target.value)} placeholder="Agent name…"
              style={{ width: 140, height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)' }} />
            <select value={status} onChange={e => setStatus(e.target.value)} style={{ height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)', cursor: 'pointer' }}>
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="reviewed">Reviewed</option>
              <option value="dismissed">Dismissed</option>
              <option value="actioned">Actioned</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={flaggedOnly} onChange={e => setFlaggedOnly(e.target.checked)} />Flagged only
            </label>
          </div>
        }>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Call Time', 'Agent', 'Customer', 'Prof', 'Clarity', 'Flag', 'Status', ''].map((h, i) => (
              <th key={i} style={{ textAlign: i === 3 || i === 4 || i === 5 ? 'center' : 'left', padding: '9px 16px', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40 }}><Spinner size={18} /></td></tr>
                : rows.length === 0 ? <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--txt2)' }}>No QA Flags Yet — Run QA On A Call Above</td></tr>
                : rows.map(r => (
                  <tr key={r.id} onClick={() => setOpenFlag(r)} style={{ cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ padding: '10px 16px', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{fmtDatetime(r.started_at)}</td>
                    <td style={{ padding: '10px 16px', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)' }}>{r.agent_name || '—'}</td>
                    <td style={{ padding: '10px 16px', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{r.customer_name || 'Unknown'}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'center', borderBottom: '1px solid var(--bdr)' }}><span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(num(r.professionalism_score)) }}>{r.professionalism_score}</span></td>
                    <td style={{ padding: '10px 16px', textAlign: 'center', borderBottom: '1px solid var(--bdr)' }}><span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(num(r.clarity_score)) }}>{r.clarity_score}</span></td>
                    <td style={{ padding: '10px 16px', textAlign: 'center', borderBottom: '1px solid var(--bdr)' }}>{r.flag_for_review ? <Pill text="Flagged" color={RED} /> : <Pill text="Clean" color={GREEN} />}</td>
                    <td style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }}><Pill text={STATUS_LABEL[r.review_status] ?? r.review_status} color={STATUS_COLOR[r.review_status] ?? NAVY} /></td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}><span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)' }}>chevron_right</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {openFlag && <FlagDetail flag={openFlag} onClose={() => setOpenFlag(null)} onUpdated={load} />}
    </div>
  )
}
