import { useState, useEffect, useCallback } from 'react'
import { SectionCard, Spinner, EmptyState, ErrBanner, ConfirmModal, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, AMBER, RED, MONO, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'

interface Step {
  id: number; step_no: number; channel: string; template_id?: number | null
  schedule_mode: string; offset_days: number; send_at?: string | null
  status: string; scheduled_for?: string | null; sent_at?: string | null
  sent_count: number; failed_count: number; template_name?: string
}
interface Tpl { id: number; name: string; channel: string }

const CH: Record<string, { c: string; i: string; l: string }> = {
  email:    { c: BLUE,      i: 'mail',       l: 'Email' },
  sms:      { c: PURPLE,    i: 'smartphone', l: 'SMS' },
  whatsapp: { c: '#25D366', i: 'chat',       l: 'WhatsApp' },
}
const STATUS_COLOR: Record<string, string> = { pending: '#8A95A1', sending: BLUE, sent: GREEN, skipped: AMBER }

const fld: React.CSSProperties = {
  padding: '7px 10px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)',
  color: 'var(--txt)', fontSize: TEXT.sm, outline: 'none', boxSizing: 'border-box',
}

export default function SequenceBuilder({ campaignId, canEdit, campaignStatus }: { campaignId: string; canEdit: boolean; campaignStatus: string }) {
  const [steps, setSteps] = useState<Step[]>([])
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [confirmLaunch, setConfirmLaunch] = useState(false)
  const [delTarget, setDelTarget] = useState<Step | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [s, t] = await Promise.all([
        apiFetch<Step[]>(`/api/campaigns/${campaignId}/steps`),
        apiFetch<Tpl[]>('/api/message-templates'),
      ])
      setSteps(Array.isArray(s) ? s : [])
      setTemplates(Array.isArray(t) ? t : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [campaignId])

  useEffect(() => { load() }, [load])

  async function addStep() {
    const step_no = (steps[steps.length - 1]?.step_no ?? 0) + 1
    try {
      await apiPost(`/api/campaigns/${campaignId}/steps`, { step_no, channel: 'email', schedule_mode: 'offset', offset_days: steps.length })
      load()
    } catch (e: any) { toast.error(e.message) }
  }

  async function saveStep(s: Step, patch: Partial<Step>) {
    const next = { ...s, ...patch }
    setSteps(prev => prev.map(x => x.id === s.id ? next : x))  // optimistic
    try {
      await apiPut(`/api/campaigns/${campaignId}/steps/${s.id}`, {
        step_no: next.step_no, channel: next.channel, template_id: next.template_id ?? null,
        schedule_mode: next.schedule_mode, offset_days: Number(next.offset_days) || 0,
        send_at: next.send_at || '',
      })
    } catch (e: any) { toast.error(e.message); load() }
  }

  async function doDelete() {
    if (!delTarget) return
    try { await apiDelete(`/api/campaigns/${campaignId}/steps/${delTarget.id}`); setDelTarget(null); load() }
    catch (e: any) { toast.error(e.message) }
  }

  async function launch() {
    setConfirmLaunch(false); setLaunching(true)
    try {
      await apiPost(`/api/campaigns/${campaignId}/launch-sequence`, {})
      toast.success('Sequence launched — steps will fire on schedule')
      load()
    } catch (e: any) { toast.error(e.message ?? 'Launch failed') }
    finally { setLaunching(false) }
  }

  const isRunning = campaignStatus === 'active'
  const editable = canEdit && !isRunning

  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', background: `${BLUE}0c`, border: `1px solid ${BLUE}25`, borderRadius: RADIUS.md, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: BLUE }}>info</span>
        <span>Build a multi-step schedule — each step sends a saved template on a channel, timed as a number of days after launch or a specific date. The campaign stays active until the last step sends.</span>
      </div>

      <SectionCard title="Steps" badge={steps.length} padding
        actions={editable ? <button onClick={addStep} style={{ ...btnSecondary, gap: 5 }}><span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>Add step</button> : undefined}>
        {steps.length === 0 ? (
          <EmptyState icon="schedule" title="No steps yet"
            description="Add steps to build a scheduled sequence (e.g. Email template on day 0, SMS on day 2)."
            action={editable ? { label: 'Add first step', onClick: addStep, icon: 'add' } : undefined} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {steps.map((s, i) => {
              const meta = CH[s.channel] ?? { c: NAVY, i: 'campaign', l: s.channel }
              const chTemplates = templates.filter(t => t.channel === s.channel)
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${meta.c}18`, color: meta.c, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: FW.bold, fontSize: TEXT.sm, flexShrink: 0, ...( { fontFamily: MONO } ) }}>{i + 1}</div>
                  <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                    {/* Channel */}
                    <div>
                      <label style={lbl}>Channel</label>
                      <select value={s.channel} disabled={!editable} onChange={e => saveStep(s, { channel: e.target.value, template_id: null })} style={{ ...fld, width: '100%', cursor: editable ? 'pointer' : 'default' }}>
                        {Object.entries(CH).map(([k, m]) => <option key={k} value={k}>{m.l}</option>)}
                      </select>
                    </div>
                    {/* Template */}
                    <div>
                      <label style={lbl}>Template</label>
                      <select value={s.template_id ?? ''} disabled={!editable} onChange={e => saveStep(s, { template_id: e.target.value ? Number(e.target.value) : null })} style={{ ...fld, width: '100%', cursor: editable ? 'pointer' : 'default' }}>
                        <option value="">— choose {meta.l} template —</option>
                        {chTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                    {/* Timing */}
                    <div>
                      <label style={lbl}>When</label>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <select value={s.schedule_mode} disabled={!editable} onChange={e => saveStep(s, { schedule_mode: e.target.value })} style={{ ...fld, cursor: editable ? 'pointer' : 'default', flexShrink: 0 }}>
                          <option value="offset">Days after launch</option>
                          <option value="absolute">Specific date</option>
                        </select>
                        {s.schedule_mode === 'absolute' ? (
                          <input type="datetime-local" disabled={!editable} value={toLocalInput(s.send_at)} onChange={e => saveStep(s, { send_at: e.target.value ? new Date(e.target.value).toISOString() : null })} style={{ ...fld, flex: 1 }} />
                        ) : (
                          <input type="number" min={0} disabled={!editable} value={s.offset_days} onChange={e => saveStep(s, { offset_days: Number(e.target.value) })} style={{ ...fld, width: 70 }} title="Day offset" />
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Status / actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0, minWidth: 90 }}>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: STATUS_COLOR[s.status] ?? 'var(--txt3)', textTransform: 'capitalize' }}>{s.status}</span>
                    {s.status === 'sent' && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: MONO }}>{fmtNum(s.sent_count)} sent</span>}
                    {s.status === 'pending' && s.scheduled_for && <span style={{ fontSize: 10.5, color: 'var(--txt3)' }}>{fmtDatetime(s.scheduled_for)}</span>}
                    {editable && (
                      <button onClick={() => setDelTarget(s)} title="Remove step" style={{ background: 'none', border: 'none', color: 'var(--txt3)', cursor: 'pointer', padding: 2 }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 17 }}>delete</span>
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>

      {/* Launch */}
      {steps.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-end' }}>
          {isRunning ? (
            <span style={{ fontSize: TEXT.sm, color: GREEN, fontWeight: FW.semibold, display: 'flex', alignItems: 'center', gap: 5 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 17 }}>play_circle</span>
              Sequence running — {steps.filter(s => s.status === 'sent').length}/{steps.length} steps sent
            </span>
          ) : (
            <>
              {steps.some(s => !s.template_id) && <span style={{ fontSize: TEXT.sm, color: AMBER }}>Every step needs a template.</span>}
              <button onClick={() => setConfirmLaunch(true)} disabled={!editable || launching || steps.some(s => !s.template_id)}
                style={{ ...btnPrimary, opacity: (!editable || launching || steps.some(s => !s.template_id)) ? 0.6 : 1 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 17 }}>rocket_launch</span>
                {launching ? 'Launching…' : 'Launch sequence'}
              </button>
            </>
          )}
        </div>
      )}

      <ConfirmModal open={confirmLaunch} title="Launch sequence?"
        body={`This schedules all ${steps.length} steps to send to the campaign's audience. Steps fire automatically on their day/date. Continue?`}
        confirmLabel="Launch" onConfirm={launch} onClose={() => setConfirmLaunch(false)} />
      <ConfirmModal open={!!delTarget} title="Remove step"
        body="Remove this step from the sequence?" danger onConfirm={doDelete} onClose={() => setDelTarget(null)} />
    </div>
  )
}

const lbl: React.CSSProperties = { fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }

// ISO → value for <input type="datetime-local"> (local time, no seconds).
function toLocalInput(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
