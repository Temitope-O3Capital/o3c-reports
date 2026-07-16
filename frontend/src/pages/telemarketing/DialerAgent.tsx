import { useState, useEffect, useCallback, useRef } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { NAVY, RED, GREEN, AMBER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number
  name: string
  status: string
}

interface AgentSession {
  id: number
  campaign_id: number | null
  campaign_name: string | null
  status: string
  calls_made: number
  calls_answered: number
  joined_at: string
  active_call_id: number | null
  active_call_phone: string | null
}

interface CallDisposition {
  callLogId: number
  phone: string
}

const DISPOSITIONS = [
  { value: 'interested',      label: 'Interested' },
  { value: 'callback',        label: 'Schedule Callback' },
  { value: 'not_interested',  label: 'Not Interested' },
  { value: 'wrong_number',    label: 'Wrong Number' },
  { value: 'busy_callback',   label: 'Busy — Callback' },
  { value: 'voicemail',       label: 'Left Voicemail' },
  { value: 'dnc',             label: 'Do Not Call (DNC)' },
]

// ── Stat Tile ─────────────────────────────────────────────────────────────────

function StatTile({ label, value, colour }: { label: string; value: string | number; colour?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 90, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}`, textAlign: 'center' }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: SP[1] }}>{label}</div>
      <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: colour ?? NAVY, lineHeight: 1 }}>{value}</div>
    </div>
  )
}

// ── Call State Card ───────────────────────────────────────────────────────────

function CallCard({
  phone, state, elapsed, onDispose
}: {
  phone: string; state: 'dialing' | 'connected'; elapsed: number
  onDispose: (disp: string, notes: string) => void
}) {
  const [disposition, setDisposition] = useState('interested')
  const [notes, setNotes] = useState('')
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timer = `${mins}:${secs.toString().padStart(2, '0')}`

  const stateColour = state === 'connected' ? GREEN : AMBER
  const stateLabel  = state === 'connected' ? 'Connected' : 'Dialing…'

  return (
    <div style={{ border: `2px solid ${stateColour}`, borderRadius: RADIUS.xl, padding: SP[6], background: `${stateColour}08`, maxWidth: 440, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: SP[4] }}>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: stateColour, animation: state === 'dialing' ? 'pulse 1.2s infinite' : undefined }}>call</span>
        <div>
          <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)' }}>{phone}</div>
          <div style={{ fontSize: TEXT.sm, color: stateColour, fontWeight: FW.semibold }}>{stateLabel} · {timer}</div>
        </div>
      </div>

      {state === 'connected' && (
        <div style={{ marginTop: SP[2] }}>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 10 }}>
            Call Disposition
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: SP[3] }}>
            {DISPOSITIONS.map(d => (
              <button key={d.value} onClick={() => setDisposition(d.value)}
                style={{
                  padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                  border: `1.5px solid ${disposition === d.value ? NAVY : 'var(--bdr)'}`,
                  background: disposition === d.value ? NAVY : 'var(--card)',
                  color: disposition === d.value ? '#fff' : 'var(--txt)',
                }}>
                {d.label}
              </button>
            ))}
          </div>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Optional notes about this call…"
            rows={2}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <button onClick={() => onDispose(disposition, notes)}
            style={{ marginTop: SP[3], width: '100%', padding: '10px 0', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer' }}>
            End Call &amp; Submit Disposition
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DialerAgent() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [session, setSession] = useState<AgentSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState<number>(0)

  // Active call tracking
  const [activeCall, setActiveCall] = useState<{ id: number; phone: string; state: 'dialing' | 'connected' } | null>(null)
  const [callElapsed, setCallElapsed] = useState(0)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSession = useCallback(async () => {
    try {
      const s = await apiFetch<AgentSession | null>('/api/dialer/sessions/me')
      setSession(s)
      if (s?.active_call_id) {
        setActiveCall({ id: s.active_call_id, phone: s.active_call_phone ?? '', state: 'dialing' })
      } else {
        setActiveCall(null)
      }
    } catch { setSession(null) }
  }, [])

  useEffect(() => {
    async function init() {
      setLoading(true)
      try {
        const [camps] = await Promise.all([
          apiFetch<Campaign[]>('/api/dialer/campaigns'),
          loadSession(),
        ])
        setCampaigns(Array.isArray(camps) ? camps.filter(c => c.status === 'active') : [])
      } catch (e: any) { setError(e.message) }
      finally { setLoading(false) }
    }
    init()
  }, [loadSession])

  // Poll session every 8s while active
  useEffect(() => {
    if (!session) return
    const iv = setInterval(loadSession, 8_000)
    return () => clearInterval(iv)
  }, [session, loadSession])

  // Call elapsed timer
  useEffect(() => {
    if (activeCall) {
      setCallElapsed(0)
      elapsedRef.current = setInterval(() => setCallElapsed(p => p + 1), 1000)
    } else {
      if (elapsedRef.current) clearInterval(elapsedRef.current)
      setCallElapsed(0)
    }
    return () => { if (elapsedRef.current) clearInterval(elapsedRef.current) }
  }, [activeCall?.id])

  async function handleJoin() {
    setJoining(true)
    try {
      await apiPost('/api/dialer/sessions', { campaign_id: selectedCampaign })
      toast.success('Joined dialer session — ready for calls')
      loadSession()
    } catch (e: any) { toast.error(e.message) }
    finally { setJoining(false) }
  }

  async function handleLeave() {
    try {
      await apiFetch('/api/dialer/sessions', { method: 'DELETE' })
      setSession(null)
      setActiveCall(null)
      toast.success('Left dialer session')
    } catch (e: any) { toast.error(e.message) }
  }

  async function handleSetStatus(status: 'ready' | 'paused') {
    try {
      await apiPut('/api/dialer/sessions/status', { status })
      loadSession()
    } catch (e: any) { toast.error(e.message) }
  }

  async function handleDispose(disposition: string, notes: string) {
    if (!activeCall) return
    try {
      await apiPost(`/api/dialer/calls/${activeCall.id}/disposition`, { disposition, notes })
      setActiveCall(null)
      toast.success('Disposition saved — ready for next call')
      loadSession()
    } catch (e: any) { toast.error(e.message) }
  }

  if (loading) return <Page title="Dialer Agent"><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>

  return (
    <Page title="Dialer Agent" subtitle="Your personal predictive dialer station">
      <ErrBanner error={error} onRetry={loadSession} />

      {!session ? (
        // ── Join screen ──────────────────────────────────────────────────────
        <SectionCard title="Join a Dialer Session">
          <div style={{ maxWidth: 400, margin: '0 auto', textAlign: 'center', padding: '24px 0' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 48, color: NAVY, marginBottom: SP[3], display: 'block' }}>phone_forwarded</span>
            <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[5] }}>
              Select an active campaign to join. The dialer engine will automatically route calls to you when you're ready.
            </p>

            {campaigns.length === 0 ? (
              <div style={{ fontSize: TEXT.base, color: 'var(--txt3)', padding: '20px 0' }}>
                No active campaigns right now. Ask a supervisor to start one.
              </div>
            ) : (
              <>
                <select value={selectedCampaign} onChange={e => setSelectedCampaign(Number(e.target.value))}
                  style={{ width: '100%', height: 40, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', marginBottom: 14 }}>
                  <option value={0}>Any active campaign</option>
                  {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button onClick={handleJoin} disabled={joining}
                  style={{ width: '100%', padding: '12px 0', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.md, fontWeight: FW.bold, cursor: joining ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: SP[2] }}>
                  {joining ? <Spinner size={16} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl }}>call</span>}
                  {joining ? 'Joining…' : 'Go Ready'}
                </button>
              </>
            )}
          </div>
        </SectionCard>
      ) : (
        <>
          {/* ── Session stats ───────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 10, marginBottom: SP[4], flexWrap: 'wrap' }}>
            <StatTile label="Status" value={session.status.toUpperCase()} colour={session.status === 'ready' ? GREEN : session.status === 'on_call' ? AMBER : '#6B7280'} />
            <StatTile label="Calls Made" value={session.calls_made} />
            <StatTile label="Calls Answered" value={session.calls_answered} />
            <StatTile label="Campaign" value={session.campaign_name ?? 'Any'} />
          </div>

          {/* ── Active call or ready state ──────────────────────────────────── */}
          <SectionCard title={activeCall ? 'Active Call' : 'Waiting for Call'}>
            {activeCall ? (
              <CallCard
                phone={activeCall.phone}
                state={activeCall.state}
                elapsed={callElapsed}
                onDispose={handleDispose}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--txt3)' }}>
                {session.status === 'ready' ? (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: SP[3] }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 40, color: GREEN }}>phone_in_talk</span>
                    </div>
                    <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: GREEN }}>Ready — waiting for next call…</div>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', marginTop: 6 }}>The dialer will connect you automatically when a contact answers.</div>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-rounded" style={{ fontSize: 40, color: AMBER }}>pause_circle</span>
                    <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: AMBER, marginTop: SP[2] }}>Paused — not receiving calls</div>
                  </>
                )}
              </div>
            )}
          </SectionCard>

          {/* ── Controls ────────────────────────────────────────────────────── */}
          <SectionCard title="Controls">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {session.status === 'paused' ? (
                <button onClick={() => handleSetStatus('ready')}
                  style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>play_arrow</span> Resume
                </button>
              ) : (
                <button onClick={() => handleSetStatus('paused')} disabled={!!activeCall}
                  style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: 'none', background: AMBER, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: activeCall ? 'not-allowed' : 'pointer', opacity: activeCall ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>pause</span> Pause
                </button>
              )}
              <button onClick={handleLeave} disabled={!!activeCall}
                style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: `1.5px solid ${RED}50`, background: `${RED}10`, color: RED, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: activeCall ? 'not-allowed' : 'pointer', opacity: activeCall ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>logout</span> Leave Session
              </button>
            </div>
          </SectionCard>
        </>
      )}
    </Page>
  )
}
