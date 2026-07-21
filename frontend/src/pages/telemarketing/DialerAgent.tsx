import { useState, useEffect, useCallback, useRef } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { NAVY, RED, GREEN, AMBER, BLUE, FW, RADIUS, SP, TEXT } from '../../lib/design'
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

interface NextContact {
  id: number
  phone: string
  customer_name: string | null
  cif: string | null
  metadata: Record<string, unknown>
  priority: number
  attempts: number
}

const DISPOSITIONS = [
  { value: 'interested',     label: 'Interested',         color: GREEN },
  { value: 'callback',       label: 'Schedule Callback',  color: BLUE  },
  { value: 'not_interested', label: 'Not Interested',     color: RED   },
  { value: 'wrong_number',   label: 'Wrong Number',       color: AMBER },
  { value: 'busy_callback',  label: 'Busy — Callback',    color: AMBER },
  { value: 'voicemail',      label: 'Left Voicemail',     color: BLUE  },
  { value: 'dnc',            label: 'Do Not Call (DNC)',  color: RED   },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtElapsed(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── Stat Tile ─────────────────────────────────────────────────────────────────

function StatTile({ label, value, colour }: { label: string; value: string | number; colour?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 90, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}`, textAlign: 'center' }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: SP[1], textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: colour ?? NAVY, lineHeight: 1 }}>{value}</div>
    </div>
  )
}

// ── Next Contact Preview ──────────────────────────────────────────────────────

function NextContactCard({
  contact, calling, onCall, onSkip,
}: {
  contact: NextContact
  calling: boolean
  onCall: () => void
  onSkip: () => void
}) {
  const meta = contact.metadata ?? {}
  const metaEntries = Object.entries(meta).slice(0, 4)

  return (
    <div style={{ border: `1.5px solid ${NAVY}20`, borderRadius: RADIUS.xl, padding: SP[5], background: `${NAVY}04` }}>
      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--txt3)', marginBottom: SP[3] }}>
        Next Contact
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: SP[4], flexWrap: 'wrap' }}>
        {/* Identity */}
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)' }}>
            {contact.customer_name ?? 'Unknown'}
          </div>
          <div style={{ fontSize: TEXT.md, color: NAVY, fontFamily: 'monospace', fontWeight: FW.semibold, marginTop: 3 }}>
            {contact.phone}
          </div>
          {contact.cif && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>CIF: {contact.cif}</div>
          )}
          {contact.attempts > 0 && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: SP[2], fontSize: TEXT.xs, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${AMBER}15`, color: AMBER, fontWeight: FW.semibold }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>history</span>
              Attempt {contact.attempts + 1}
            </div>
          )}
        </div>

        {/* Metadata chips */}
        {metaEntries.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1, minWidth: 160 }}>
            {metaEntries.map(([k, v]) => (
              <div key={k} style={{ fontSize: TEXT.xs, padding: '4px 10px', borderRadius: RADIUS.md, background: 'var(--th-bg)', color: 'var(--txt2)' }}>
                <span style={{ color: 'var(--txt3)', fontWeight: FW.semibold }}>{k}: </span>{String(v)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: SP[2], marginTop: SP[4] }}>
        <button onClick={onCall} disabled={calling}
          style={{ flex: 1, padding: '11px 0', borderRadius: RADIUS.md, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.md, fontWeight: FW.bold, cursor: calling ? 'wait' : 'pointer', opacity: calling ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: SP[2] }}>
          {calling ? <Spinner size={16} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl }}>call</span>}
          {calling ? 'Dialing…' : 'Call Now'}
        </button>
        <button onClick={onSkip} disabled={calling}
          style={{ padding: '11px 18px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: calling ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>skip_next</span>
          Skip
        </button>
      </div>
    </div>
  )
}

// ── Active Call Card ──────────────────────────────────────────────────────────

function CallCard({
  callId, phone, elapsed, onDispose,
}: {
  callId: number; phone: string; elapsed: number
  onDispose: (disp: string, notes: string) => void
}) {
  const [disposition, setDisposition] = useState('interested')
  const [notes, setNotes] = useState('')
  const timer = fmtElapsed(elapsed)

  return (
    <div style={{ border: `2px solid ${GREEN}`, borderRadius: RADIUS.xl, padding: SP[6], background: `${GREEN}06`, maxWidth: 480, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: SP[5] }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: GREEN, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT['2xl'], color: '#fff' }}>call</span>
        </div>
        <div>
          <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: 'monospace' }}>{phone}</div>
          <div style={{ fontSize: TEXT.sm, color: GREEN, fontWeight: FW.semibold, marginTop: 2 }}>Connected · {timer}</div>
        </div>
      </div>

      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--txt3)', marginBottom: 10 }}>
        Call Disposition
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: SP[3] }}>
        {DISPOSITIONS.map(d => (
          <button key={d.value} onClick={() => setDisposition(d.value)}
            style={{
              padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
              border: `1.5px solid ${disposition === d.value ? d.color : 'var(--bdr)'}`,
              background: disposition === d.value ? d.color + '18' : 'var(--card)',
              color: disposition === d.value ? d.color : 'var(--txt)',
            }}>
            {d.label}
          </button>
        ))}
      </div>
      <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Notes about this call…" rows={2}
        style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
      />
      <button onClick={() => onDispose(disposition, notes)}
        style={{ marginTop: SP[3], width: '100%', padding: '11px 0', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer' }}>
        End &amp; Submit Disposition
      </button>
      <div style={{ marginTop: SP[2], fontSize: TEXT.xs, color: 'var(--txt3)', textAlign: 'center' }}>
        Call ID #{callId} — submit after the call ends
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DialerAgent() {
  const [campaigns, setCampaigns]         = useState<Campaign[]>([])
  const [session, setSession]             = useState<AgentSession | null>(null)
  const [nextContact, setNextContact]     = useState<NextContact | null>(null)
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [joining, setJoining]             = useState(false)
  const [calling, setCalling]             = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState<number>(0)

  const [activeCall, setActiveCall] = useState<{ id: number; phone: string } | null>(null)
  const [callElapsed, setCallElapsed] = useState(0)
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSession = useCallback(async () => {
    try {
      const s = await apiFetch<AgentSession | null>('/api/dialer/sessions/me')
      setSession(s)
      if (s?.active_call_id) {
        setActiveCall({ id: s.active_call_id, phone: s.active_call_phone ?? '' })
      } else {
        setActiveCall(null)
      }
    } catch { setSession(null) }
  }, [])

  const loadNextContact = useCallback(async () => {
    try {
      const res = await apiFetch<{ contact: NextContact | null }>('/api/dialer/sessions/me/next-contact')
      setNextContact(res?.contact ?? null)
    } catch { setNextContact(null) }
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

  // Poll session + next contact every 6s while in session
  useEffect(() => {
    if (!session) return
    loadNextContact()
    const iv = setInterval(() => { loadSession(); loadNextContact() }, 6_000)
    return () => clearInterval(iv)
  }, [session, loadSession, loadNextContact])

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
      toast.success('Joined dialer session')
      await loadSession()
      await loadNextContact()
    } catch (e: any) { toast.error(e.message) }
    finally { setJoining(false) }
  }

  async function handleLeave() {
    try {
      await apiFetch('/api/dialer/sessions', { method: 'DELETE' })
      setSession(null); setActiveCall(null); setNextContact(null)
      toast.success('Left dialer session')
    } catch (e: any) { toast.error(e.message) }
  }

  async function handleSetStatus(status: 'ready' | 'paused') {
    try {
      await apiPut('/api/dialer/sessions/status', { status })
      loadSession()
    } catch (e: any) { toast.error(e.message) }
  }

  async function handleCallNow() {
    if (!nextContact) return
    setCalling(true)
    try {
      const res = await apiPost<{ call_log_id: number }>(
        '/api/dialer/calls/manual',
        { queue_entry_id: nextContact.id, phone: nextContact.phone }
      )
      setActiveCall({ id: res.call_log_id, phone: nextContact.phone })
      setNextContact(null)
      toast.success(`Dialing ${nextContact.phone} — your Zoho phone will ring shortly`)
    } catch (e: any) {
      toast.error(e.message ?? 'Call failed')
    } finally { setCalling(false) }
  }

  async function handleSkip() {
    if (!nextContact) return
    // Mark as pending again (skipping just refreshes next contact)
    setNextContact(null)
    await loadNextContact()
    toast.info('Skipped — loaded next contact')
  }

  async function handleDispose(disposition: string, notes: string) {
    if (!activeCall) return
    try {
      await apiPost(`/api/dialer/calls/${activeCall.id}/disposition`, { disposition, notes })
      setActiveCall(null)
      toast.success('Disposition saved')
      await loadSession()
      await loadNextContact()
    } catch (e: any) { toast.error(e.message) }
  }

  if (loading) return <Page title="Dialer Agent"><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>

  const sessionStatus = session?.status ?? ''
  const statusColor = sessionStatus === 'ready' ? GREEN : sessionStatus === 'on_call' ? AMBER : '#6B7280'

  return (
    <Page title="Dialer Agent" subtitle="Zoho Voice progressive dialer station">
      <ErrBanner error={error} onRetry={loadSession} />

      {!session ? (
        // ── Join screen ──────────────────────────────────────────────────────
        <SectionCard title="Join a Dialer Session">
          <div style={{ maxWidth: 420, margin: '0 auto', textAlign: 'center', padding: '24px 0' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 52, color: NAVY, marginBottom: SP[3], display: 'block' }}>phone_forwarded</span>
            <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[5], lineHeight: 1.65 }}>
              Select an active campaign and join. The dialer will show you each contact's details before calling —
              your registered Zoho phone rings when the contact answers.
            </p>

            {campaigns.length === 0 ? (
              <div style={{ fontSize: TEXT.base, color: 'var(--txt3)', padding: '20px 0' }}>
                No active campaigns. Ask a supervisor to start one in <strong>Dialer Campaigns</strong>.
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
            <StatTile label="Status" value={sessionStatus.toUpperCase()} colour={statusColor} />
            <StatTile label="Calls Made" value={session.calls_made} />
            <StatTile label="Answered" value={session.calls_answered} />
            <StatTile label="Campaign" value={session.campaign_name ?? 'Any'} />
          </div>

          {/* ── Active call ─────────────────────────────────────────────────── */}
          {activeCall && (
            <div style={{ marginBottom: SP[4] }}>
              <CallCard
                callId={activeCall.id}
                phone={activeCall.phone}
                elapsed={callElapsed}
                onDispose={handleDispose}
              />
            </div>
          )}

          {/* ── Next contact preview (shown when ready and not on a call) ──── */}
          {!activeCall && sessionStatus === 'ready' && (
            <div style={{ marginBottom: SP[4] }}>
              {nextContact ? (
                <NextContactCard
                  contact={nextContact}
                  calling={calling}
                  onCall={handleCallNow}
                  onSkip={handleSkip}
                />
              ) : (
                <SectionCard>
                  <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--txt3)' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 40, color: GREEN, display: 'block', marginBottom: SP[2] }}>check_circle</span>
                    <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: GREEN }}>Ready — no pending contacts</div>
                    <div style={{ fontSize: TEXT.sm, marginTop: 6 }}>The queue is empty or all contacts are scheduled for retry.</div>
                  </div>
                </SectionCard>
              )}
            </div>
          )}

          {/* ── Paused state ────────────────────────────────────────────────── */}
          {!activeCall && sessionStatus === 'paused' && (
            <SectionCard>
              <div style={{ textAlign: 'center', padding: '28px 0' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 40, color: AMBER, display: 'block', marginBottom: SP[2] }}>pause_circle</span>
                <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: AMBER }}>Paused — not receiving calls</div>
              </div>
            </SectionCard>
          )}

          {/* ── Controls ────────────────────────────────────────────────────── */}
          <SectionCard title="Controls">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {sessionStatus === 'paused' ? (
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
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: SP[2], fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: GREEN }}>fiber_manual_record</span>
                Calls via Zoho Voice · your registered phone rings
              </div>
            </div>
          </SectionCard>
        </>
      )}
    </Page>
  )
}
