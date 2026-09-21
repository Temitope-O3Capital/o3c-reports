import { useEffect, useState, useCallback } from 'react'
import { SectionCard, Spinner, ErrBanner, ConfirmModal } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtCount } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// Agent Matching — reconcile Zoho agents to workspace users. Zoho call/ticket
// attribution is resolved through the durable crosswalk (zoho_agent_map); anything
// that couldn't be matched automatically shows here for one-click mapping. Mapping
// an agent back-fills every historical call already imported under that Zoho id.

interface ZAgent {
  zoho_agent_id: string
  zoho_email?: string
  zoho_name?: string
  match_method: string
  call_count: number
  o3c_user_id?: number | null
  o3c_name?: string | null
  o3c_email?: string | null
}
interface WUser { id: number; full_name: string; email?: string }

const METHOD_STYLE: Record<string, { label: string; color: string }> = {
  manual:    { label: 'Manual',    color: NAVY },
  email:     { label: 'Email',     color: GREEN },
  name:      { label: 'Name',      color: AMBER },
  unmatched: { label: 'Unmatched', color: RED },
}

function MethodBadge({ method, matched }: { method: string; matched: boolean }) {
  const s = METHOD_STYLE[matched ? method : 'unmatched'] || METHOD_STYLE.unmatched
  return (
    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: s.color, background: `${s.color}18`, padding: '2px 8px', borderRadius: RADIUS.full, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
      {s.label}
    </span>
  )
}

// What the confirmation says before a re-link commits. Naming the agent AND the exact
// number of calls is the whole point: mapping back-fills every historical call already
// imported under that Zoho id, and there is no undo.
function remapWarning(agent: ZAgent, userId: number, users: WUser[]): string {
  const who   = agent.zoho_name || agent.zoho_email || agent.zoho_agent_id
  const calls = `${fmtCount(agent.call_count)} call${agent.call_count === 1 ? '' : 's'}`
  if (userId === 0) {
    return `Clear the mapping for ${who}? ${calls} imported under this Zoho id will stop being attributed to a workspace user.`
  }
  const target = users.find(u => u.id === userId)
  return `Attribute ${who} to ${target?.full_name ?? 'this user'}? This re-links ${calls} already imported under that Zoho id, including every historical call. There is no undo.`
}

// Rendered inside a modal from the Supervisor view (not a standalone page).
export function AgentMatchingPanel() {
  const [agents, setAgents] = useState<ZAgent[]>([])
  const [users, setUsers] = useState<WUser[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [onlyUnmatched, setOnlyUnmatched] = useState(true)
  // A staged re-link, waiting on an explicit confirmation. Nothing commits from the
  // select's own onChange.
  const [pending, setPending] = useState<{ agent: ZAgent; userId: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await apiFetch<any>('/api/zoho/unmatched-agents')
      const d = (r?.data ?? r) as { agents: ZAgent[]; users: WUser[] }
      setAgents(d.agents ?? [])
      setUsers(d.users ?? [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function mapAgent(zohoAgentID: string, o3cUserID: number) {
    setSaving(zohoAgentID)
    try {
      const r = await apiPost<any>('/api/zoho/map-agent', { zoho_agent_id: zohoAgentID, o3c_user_id: o3cUserID })
      const res = (r?.data ?? r) as { calls_relinked: number; tickets_relinked: number }
      const parts = [
        `${fmtCount(res.calls_relinked)} call${res.calls_relinked === 1 ? '' : 's'}`,
        `${fmtCount(res.tickets_relinked)} ticket${res.tickets_relinked === 1 ? '' : 's'}`,
      ]
      toast.success(o3cUserID === 0 ? 'Mapping cleared' : `Mapped · ${parts.join(' + ')} re-linked`)
      await load()
    } catch (e: any) { toast.error(e?.message || 'Could not save mapping') }
    finally { setSaving(null); setPending(null) }
  }

  const unmatchedCount = agents.filter(a => !a.o3c_user_id).length
  const shown = onlyUnmatched ? agents.filter(a => !a.o3c_user_id) : agents

  return (
    <div>
      <ErrBanner error={err} onRetry={load} />

      {loading && agents.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[3] }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              <strong style={{ color: unmatchedCount > 0 ? RED : GREEN }}>{fmtCount(unmatchedCount)}</strong> unmatched of {fmtCount(agents.length)} Zoho agent{agents.length === 1 ? '' : 's'} seen
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyUnmatched} onChange={e => setOnlyUnmatched(e.target.checked)} />
              Show Only Unmatched
            </label>
          </div>

          <SectionCard title="Zoho Agents" subtitle="Map each unmatched agent to a workspace user: historical calls re-link automatically">
            {shown.length === 0 ? (
              <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
                {onlyUnmatched ? 'Every Zoho agent is matched.' : 'No Zoho agents seen yet. They appear after the first sync.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--txt3)', fontSize: TEXT.xs }}>
                      <th style={{ padding: '7px 8px', fontWeight: FW.semibold }}>Zoho Agent</th>
                      <th style={{ padding: '7px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Activity</th>
                      <th style={{ padding: '7px 8px', fontWeight: FW.semibold }}>Match</th>
                      <th style={{ padding: '7px 8px', fontWeight: FW.semibold }}>Workspace User</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(a => {
                      const matched = !!a.o3c_user_id
                      return (
                        <tr key={a.zoho_agent_id} style={{ borderTop: '1px solid var(--bdr)' }}>
                          <td style={{ padding: '8px' }}>
                            <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{a.zoho_name || '(no name)'}</div>
                            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{a.zoho_email || a.zoho_agent_id}</div>
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right', color: 'var(--txt2)' }}>{fmtCount(a.call_count)}</td>
                          <td style={{ padding: '8px' }}><MethodBadge method={a.match_method} matched={matched} /></td>
                          <td style={{ padding: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <select
                                value={a.o3c_user_id ?? 0}
                                disabled={saving === a.zoho_agent_id}
                                aria-label={`Workspace user for ${a.zoho_name || a.zoho_agent_id}`}
                                onChange={e => {
                                  // Arrowing through a native select fires change on every
                                  // option in most browsers. Committing here silently
                                  // re-attributed thousands of calls per keypress — stage the
                                  // choice and make the user confirm it instead.
                                  const next = Number(e.target.value)
                                  if (next !== (a.o3c_user_id ?? 0)) setPending({ agent: a, userId: next })
                                }}
                                style={{ flex: 1, maxWidth: 320, padding: '6px 8px', borderRadius: RADIUS.sm, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm }}>
                                <option value={0}>— Unmatched —</option>
                                {users.map(u => (
                                  <option key={u.id} value={u.id}>{u.full_name}{u.email ? ` · ${u.email}` : ''}</option>
                                ))}
                              </select>
                              {saving === a.zoho_agent_id && <Spinner size={14} />}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}

      <ConfirmModal
        open={!!pending}
        title={pending?.userId === 0 ? 'Clear This Mapping' : 'Re-Link This Agent'}
        body={pending ? remapWarning(pending.agent, pending.userId, users) : ''}
        confirmLabel={pending?.userId === 0 ? 'Clear Mapping' : 'Re-Link Calls'}
        danger
        loading={saving !== null}
        onConfirm={() => { if (pending) mapAgent(pending.agent.zoho_agent_id, pending.userId) }}
        onClose={() => setPending(null)}
      />
    </div>
  )
}
