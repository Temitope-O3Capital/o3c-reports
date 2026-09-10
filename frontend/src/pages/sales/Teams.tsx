import { useCallback, useEffect, useState } from 'react'
import { Page, SectionCard, Button, Modal, Input, Select, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { currentUser, isSalesHead, allRoles } from '../../hooks/useAuth'
import { MGMT } from '../../lib/roles'
import { NAVY, GREEN, RED, AMBER, PURPLE, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'

// Sales teams: the flexible head→officers structure that scopes the Leads book.
// A team has one head and many member officers; a head may run more than one team,
// and an officer sits on at most one team. Managed here by sales heads and managers.

interface Member { user_id: number; full_name: string; role: string; is_active: boolean }
interface Team {
  id: number; name: string; head_user_id: number | null; head_name: string | null
  is_active: boolean; member_count: number; members: Member[]
}
interface Officer { id: number; full_name: string; role: string; is_active: boolean; already_officer?: boolean }

function canManage(): boolean {
  const u = currentUser()
  return isSalesHead(u) || (!!u && allRoles(u).some(r => MGMT.has(r)))
}

export default function SalesTeams() {
  const [teams, setTeams]       = useState<Team[]>([])
  const [officers, setOfficers] = useState<Officer[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [newOpen, setNewOpen]   = useState(false)
  const manage = canManage()

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [t, o] = await Promise.all([
        apiFetch<{ data: Team[] } | Team[]>('/api/sales/teams'),
        apiFetch<{ data: Officer[] }>('/api/sales/officers'),
      ])
      setTeams(Array.isArray(t) ? t : (t?.data ?? []))
      setOfficers(o?.data ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // The set of officers already on a team — used to grey them out in add-pickers so
  // an officer isn't silently re-homed by two heads at once.
  const teamOf = new Map<number, string>()
  teams.forEach(t => t.members.forEach(m => teamOf.set(m.user_id, t.name)))

  const totalMembers = teams.reduce((s, t) => s + t.member_count, 0)
  const unteamed = officers.filter(o => o.already_officer && !teamOf.has(o.id))

  return (
    <Page title="Sales Teams"
      loading={loading && teams.length === 0}
      skeletonKpis={3}
      subtitle="Group officers under a head. A head sees and distributes only their team's leads; executives see everyone."
      actions={manage ? <Button variant="primary" icon="group_add" onClick={() => setNewOpen(true)}>New team</Button> : undefined}>
      {error && <ErrBanner error={error} onRetry={load} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: SP[3], marginBottom: 16 }}>
        {[
          { label: 'Teams', value: teams.filter(t => t.is_active).length, color: NAVY },
          { label: 'Officers assigned', value: totalMembers, color: GREEN },
          { label: 'Unassigned officers', value: unteamed.length, color: unteamed.length ? AMBER : 'var(--txt3)' },
        ].map(c => (
          <div key={c.label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>{c.label}</div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: c.color, lineHeight: 1 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}><Spinner size={28} /></div>
      ) : teams.length === 0 ? (
        <SectionCard title="No teams yet">
          <div style={{ color: 'var(--txt2)', fontSize: TEXT.base, lineHeight: 1.6 }}>
            No sales teams have been set up. Until a head is given a team, they see every lead
            (the safe fallback). {manage ? 'Create a team to scope a head to their own officers.' : 'Ask a manager to set up your team.'}
          </div>
        </SectionCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {teams.map(t => (
            <TeamCard key={t.id} team={t} officers={officers} teamOf={teamOf} manage={manage} onChanged={load} />
          ))}
        </div>
      )}

      {unteamed.length > 0 && (
        <div style={{ marginTop: SP[4], padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg, background: `${AMBER}0F`, border: `1px solid ${AMBER}33` }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>
            {unteamed.length} officer{unteamed.length === 1 ? '' : 's'} on no team
          </div>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            {unteamed.map(o => o.full_name).join(', ')} — add them to a team so their leads roll up to a head.
          </div>
        </div>
      )}

      {newOpen && <NewTeamModal officers={officers} onClose={() => setNewOpen(false)} onDone={() => { setNewOpen(false); load() }} />}
    </Page>
  )
}

function TeamCard({ team, officers, teamOf, manage, onChanged }: {
  team: Team; officers: Officer[]; teamOf: Map<number, string>; manage: boolean; onChanged: () => void
}) {
  const [addId, setAddId] = useState('')
  const [busy, setBusy]   = useState(false)

  async function setHead(id: string) {
    try { await apiFetch(`/api/sales/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify({ head_user_id: id ? Number(id) : 0 }) }); toast.success('Head updated'); onChanged() }
    catch (e: any) { toast.error(e.message) }
  }
  async function addMember() {
    if (!addId) return
    setBusy(true)
    try { await apiPost(`/api/sales/teams/${team.id}/members`, { user_id: Number(addId) }); toast.success('Officer added'); setAddId(''); onChanged() }
    catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  async function removeMember(uid: number) {
    try { await apiFetch(`/api/sales/teams/${team.id}/members/${uid}`, { method: 'DELETE' }); onChanged() }
    catch (e: any) { toast.error(e.message) }
  }
  async function del() {
    if (!confirm(`Delete team "${team.name}"? Its officers become unassigned.`)) return
    try { await apiFetch(`/api/sales/teams/${team.id}`, { method: 'DELETE' }); toast.success('Team removed'); onChanged() }
    catch (e: any) { toast.error(e.message) }
  }

  // Candidates for the add-picker: active officers not already on THIS team.
  const memberIds = new Set(team.members.map(m => m.user_id))
  const candidates = officers.filter(o => o.is_active && !memberIds.has(o.id))

  return (
    <SectionCard
      title={team.name}
      subtitle={`${team.member_count} officer${team.member_count === 1 ? '' : 's'}`}
      actions={manage ? (
        <button onClick={del} title="Delete team" style={{ border: 'none', background: 'none', cursor: 'pointer', color: RED, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span> Delete
        </button>
      ) : undefined}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        {/* Head */}
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, minWidth: 44 }}>Head</span>
          {manage ? (
            <select value={team.head_user_id ?? ''} onChange={e => setHead(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, minWidth: 200 }}>
              <option value="">No head</option>
              {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
            </select>
          ) : (
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{team.head_name || '—'}</span>
          )}
        </div>

        {/* Members */}
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Officers</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {team.members.length === 0 && <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No officers yet.</span>}
            {team.members.map(m => (
              <span key={m.user_id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: RADIUS['2xl'], background: `${PURPLE}12`, color: PURPLE, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
                {m.full_name}
                {manage && (
                  <button onClick={() => removeMember(m.user_id)} title="Remove from team"
                    style={{ border: 'none', background: 'none', cursor: 'pointer', color: PURPLE, display: 'inline-flex', padding: 0 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
                  </button>
                )}
              </span>
            ))}
          </div>
          {manage && candidates.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <select value={addId} onChange={e => setAddId(e.target.value)}
                style={{ padding: '7px 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm, minWidth: 220 }}>
                <option value="">Add an officer…</option>
                {candidates.map(o => {
                  const on = teamOf.get(o.id)
                  return <option key={o.id} value={o.id}>{o.full_name}{on ? ` (on ${on})` : ''}</option>
                })}
              </select>
              <Button size="sm" variant="secondary" disabled={!addId || busy} onClick={addMember}>Add</Button>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  )
}

function NewTeamModal({ officers, onClose, onDone }: { officers: Officer[]; onClose: () => void; onDone: () => void }) {
  const [name, setName]   = useState('')
  const [head, setHead]   = useState('')
  const [saving, setSaving] = useState(false)
  async function save() {
    if (!name.trim()) { toast.error('Name the team'); return }
    setSaving(true)
    try { await apiPost('/api/sales/teams', { name: name.trim(), head_user_id: head ? Number(head) : null }); toast.success('Team created'); onDone() }
    catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }
  return (
    <Modal open onClose={onClose} title="New sales team" width={440}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>Create</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label="Team name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Lagos Retail Team" autoFocus />
        <Select label="Head (optional)" value={head} onChange={e => setHead(e.target.value)}>
          <option value="">Choose a head…</option>
          {officers.map(o => <option key={o.id} value={o.id}>{o.full_name}</option>)}
        </Select>
        <p style={{ margin: 0, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
          The head sees and distributes this team's leads. You can add officers after creating the team.
        </p>
      </div>
    </Modal>
  )
}
