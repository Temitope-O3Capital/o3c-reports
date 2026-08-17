import { useEffect, useState, useCallback } from 'react'
import { SectionCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
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

// Rendered inside a modal from the Supervisor view (not a standalone page).
export function AgentMatchingPanel() {
  const [agents, setAgents] = useState<ZAgent[]>([])
  const [users, setUsers] = useState<WUser[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [onlyUnmatched, setOnlyUnmatched] = useState(true)

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
        `${fmtNum(res.calls_relinked)} call${res.calls_relinked === 1 ? '' : 's'}`,
        `${fmtNum(res.tickets_relinked)} ticket${res.tickets_relinked === 1 ? '' : 's'}`,
      ]
      toast.success(o3cUserID === 0 ? 'Mapping cleared' : `Mapped · ${parts.join(' + ')} re-linked`)
      await load()
    } catch (e: any) { toast.error(e?.message || 'Could not save mapping') }
    finally { setSaving(null) }
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
              <strong style={{ color: unmatchedCount > 0 ? RED : GREEN }}>{fmtNum(unmatchedCount)}</strong> unmatched of {fmtNum(agents.length)} Zoho agent{agents.length === 1 ? '' : 's'} seen
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyUnmatched} onChange={e => setOnlyUnmatched(e.target.checked)} />
              Show only unmatched
            </label>
          </div>

          <SectionCard title="Zoho Agents" subtitle="Map each unmatched agent to a workspace user — historical calls re-link automatically">
            {shown.length === 0 ? (
              <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
                {onlyUnmatched ? 'Every Zoho agent is matched. 🎉' : 'No Zoho agents seen yet — they appear after the first sync.'}
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
                          <td style={{ padding: '8px', textAlign: 'right', color: 'var(--txt2)' }}>{fmtNum(a.call_count)}</td>
                          <td style={{ padding: '8px' }}><MethodBadge method={a.match_method} matched={matched} /></td>
                          <td style={{ padding: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <select
                                value={a.o3c_user_id ?? 0}
                                disabled={saving === a.zoho_agent_id}
                                onChange={e => mapAgent(a.zoho_agent_id, Number(e.target.value))}
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
    </div>
  )
}
