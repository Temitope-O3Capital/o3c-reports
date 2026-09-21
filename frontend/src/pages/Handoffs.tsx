// Hand-Offs — the inbox a hand-off never had.
//
// "Hand off to Risk" wrote an activity with target_team='risk' and status='open', and
// nothing in the app ever read it: the receiving team was never told, and the person who
// raised it could not find out what happened. This page is the other end of that action.
// It is deliberately visible to everyone — any team can be handed something — and scoped
// on the server to the viewer's own team, so there is nothing here that isn't yours.

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, ErrBanner } from '../components/UI'
import { apiFetch } from '../lib/api'
import { fmtDatetime } from '../lib/fmt'
import { NAVY, GREEN, RED, AMBER, RADIUS, TEXT, FW, SP, INTER, NUM } from '../lib/design'
import HandoffActions, { HandoffStatusChip, handoffOpen, type HandoffViewer } from '../components/HandoffActions'

interface Handoff {
  id: number
  subject: string | null
  body: string | null
  outcome: string | null
  status: string | null
  target_team: string | null
  actor_name: string | null
  actor_team: string | null
  actor_user_id: number | null
  occurred_at: string
  lead_id: number | null
  contact_id: number | null
  cif: string | null
  application_id: number | null
  about_name: string | null
  about_phone: string | null
  update_count: number | null
  last_update: string | null
}

type Scope = 'inbox' | 'raised'

const titleWords = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())

// How long this has been waiting. A hand-off's age is the whole point of the page —
// "raised 6 days ago" is the thing that makes someone pick it up.
function ageOf(iso: string): { label: string; stale: boolean } {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return { label: `${Math.max(mins, 0)}m ago`, stale: false }
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return { label: `${hrs}h ago`, stale: false }
  const days = Math.floor(hrs / 24)
  return { label: `${days}d ago`, stale: days >= 3 }
}

export default function Handoffs() {
  const navigate = useNavigate()
  const [scope, setScope] = useState<Scope>('inbox')
  const [showClosed, setShowClosed] = useState(false)
  const [inbox, setInbox] = useState<Handoff[]>([])
  const [raised, setRaised] = useState<Handoff[]>([])
  const [viewer, setViewer] = useState<HandoffViewer | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Both sides are loaded together: the tab counts have to be true before you click,
  // or the page is asking you to go looking for work that may not be there.
  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const q = showClosed ? '&status=all' : ''
    try {
      const [a, b] = await Promise.all([
        apiFetch<{ data: Handoff[]; viewer?: HandoffViewer }>(`/api/activities/handoffs?scope=inbox${q}`),
        apiFetch<{ data: Handoff[]; viewer?: HandoffViewer }>(`/api/activities/handoffs?scope=raised${q}`),
      ])
      setInbox(a?.data ?? []); setRaised(b?.data ?? [])
      setViewer(a?.viewer ?? b?.viewer ?? null)
    } catch (e: any) {
      setErr(e?.message || 'Could not load hand-offs')
    } finally { setLoading(false) }
  }, [showClosed])

  useEffect(() => { load() }, [load])

  const rows = scope === 'inbox' ? inbox : raised
  const openCount = (list: Handoff[]) => list.filter(h => handoffOpen(h.status)).length

  const tab = (v: Scope, label: string, n: number) => {
    const on = scope === v
    return (
      <button key={v} role="tab" aria-selected={on} onClick={() => setScope(v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', minHeight: 34,
          borderRadius: RADIUS.full, border: 'none', cursor: 'pointer', fontFamily: INTER,
          fontSize: TEXT.sm, fontWeight: on ? FW.bold : FW.semibold,
          background: on ? 'var(--card)' : 'transparent', color: on ? 'var(--txt)' : 'var(--txt3)',
          boxShadow: on ? '0 1px 2px rgba(0,0,0,0.10)' : 'none', transition: 'var(--transition-fast)',
        }}>
        {label}
        <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 7px', borderRadius: RADIUS.full,
                       background: n > 0 ? `${AMBER}1A` : 'var(--chip-bg)', color: n > 0 ? AMBER : 'var(--txt3)' }}>{n}</span>
      </button>
    )
  }

  return (
    <Page
      title="Hand-Offs"
      subtitle={viewer?.team ? `Work handed to ${titleWords(viewer.team)} — and what you have handed to others` : 'Work handed between teams'}
      loading={loading && inbox.length === 0 && raised.length === 0}
      actions={
        <button onClick={load}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', minHeight: 36,
                   borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)',
                   color: 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>refresh</span> Refresh
        </button>
      }
    >
      {err && <ErrBanner error={err} onRetry={load} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap', marginBottom: SP[4] }}>
        <div role="tablist" aria-label="Hand-off scope"
          style={{ display: 'inline-flex', gap: 2, padding: 3, background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.full }}>
          {tab('inbox', 'To My Team', openCount(inbox))}
          {tab('raised', 'Raised by Me', openCount(raised))}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.sm, color: 'var(--txt2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)} />
          Show closed
        </label>
      </div>

      {rows.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '56px 20px', textAlign: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 34, color: 'var(--txt3)' }}>inbox</span>
          <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt2)' }}>
            {scope === 'inbox' ? 'Nothing is waiting on your team' : 'You have not handed anything over'}
          </div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', maxWidth: 420 }}>
            {scope === 'inbox'
              ? 'When another team hands a customer to you, it lands here and stays until you resolve or return it.'
              : 'Hand a lead to another team from its detail pane — Log Activity → Hand Off — and track the answer here.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {rows.map(h => {
            const age = ageOf(h.occurred_at)
            const open = handoffOpen(h.status)
            // An open hand-off sitting for days is the thing this page exists to show;
            // a closed one is history and should recede.
            const accent = !open ? 'var(--bdr)' : age.stale ? RED : AMBER
            return (
              <div key={h.id} style={{
                background: 'var(--card)', border: '1px solid var(--bdr)', borderLeft: `3px solid ${accent}`,
                borderRadius: RADIUS.lg, padding: `${SP[4]} ${SP[4]}`, opacity: open ? 1 : 0.75,
              }}>
                <div style={{ display: 'flex', gap: SP[3], alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 3 }}>
                      <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
                        {h.about_name || 'Unnamed'}
                      </span>
                      {h.about_phone && (
                        <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{h.about_phone}</span>
                      )}
                      <HandoffStatusChip status={h.status} />
                      <span style={{ fontSize: TEXT.xs, color: age.stale && open ? RED : 'var(--txt3)', fontWeight: age.stale && open ? FW.semibold : FW.normal }}>
                        {age.label}
                      </span>
                    </div>
                    <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                      {h.subject || 'Handed over'}
                    </div>
                    {h.body && (
                      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.45 }}>{h.body}</div>
                    )}
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 5 }}>
                      {scope === 'inbox'
                        ? <>From {h.actor_name || 'a colleague'}{h.actor_team ? ` · ${titleWords(h.actor_team)}` : ''} · {fmtDatetime(h.occurred_at)}</>
                        : <>To {titleWords(h.target_team || '')} · {fmtDatetime(h.occurred_at)}</>}
                    </div>
                    {/* The last thing that came back, so a resolved hand-off answers
                        itself without opening the customer's whole timeline. */}
                    {!!h.last_update && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 7, padding: '7px 10px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 15, color: GREEN, marginTop: 1 }}>subdirectory_arrow_right</span>
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.45 }}>{h.last_update}</span>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
                    <HandoffActions
                      handoff={{ id: h.id, status: h.status, target_team: h.target_team, actor_user_id: h.actor_user_id }}
                      viewer={viewer}
                      onDone={load}
                    />
                    {h.lead_id != null && (
                      <button onClick={() => navigate(`/call-center/leads?open=${h.lead_id}`)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', minHeight: 30,
                                 borderRadius: RADIUS.md, border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY,
                                 fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span> Open Lead
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Page>
  )
}
