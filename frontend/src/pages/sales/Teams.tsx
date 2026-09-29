import { useCallback, useEffect, useMemo, useState } from 'react'
import { Page, SectionCard, Button, Modal, Input, Spinner, ErrBanner, Avatar, EmptyState, ConfirmModal } from '../../components/UI'
import { SelectMenu, SelectMenuField } from '../../components/SelectMenu'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { currentUser, isSalesHead, allRoles } from '../../hooks/useAuth'
import { MGMT } from '../../lib/roles'
import { NAVY, GREEN, RED, AMBER, PURPLE, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtNum, fmtKobo } from '../../lib/fmt'

// Sales teams: the head→officers structure that scopes the Leads book.
//
// A team has one head and many member officers; a head may run more than one team, and
// an officer sits on at most one team (uq_sales_team_member_user).
//
// The page shows the STRUCTURE and what the structure is producing, side by side. An
// org chart on its own does not answer the question the page is actually opened for —
// "how is this team doing, and who needs help?" — and a head deciding where to send the
// next batch of leads needs the open/overdue counts next to the names, not on a
// different screen.
//
// Heading a team is what grants a head visibility of it (salesLeadScope), not the
// sales_head role: Team Ozioma and Team Ikechukwu Okoro are both run by officers whose
// role is sales_officer. So the roster here is a permission surface, and moving an
// officer between teams moves what their head can see.

interface Member { user_id: number; full_name: string; role: string; is_active: boolean }
interface Team {
  id: number; name: string; head_user_id: number | null; head_name: string | null
  is_active: boolean; member_count: number; members: Member[]
  open_leads: number; qualified: number; converted_mtd: number; overdue: number; pipeline_kobo: number
}
interface Officer { id: number; full_name: string; role: string; is_active: boolean; already_officer?: boolean }

function canManage(): boolean {
  const u = currentUser()
  return isSalesHead(u) || (!!u && allRoles(u).some(r => MGMT.has(r)))
}

/** Roles rendered in plain words — "sales_officer" is a database value, not a job title. */
const ROLE_LABEL: Record<string, string> = {
  sales_officer: 'Sales Officer',
  sales_head: 'Sales Head',
  account_officer: 'Account Officer',
}
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

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

  // Which team each officer sits on — used to warn before moving someone, and to grey
  // them out in the add-picker so nobody is silently taken off a colleague's team.
  const teamOf = useMemo(() => {
    const m = new Map<number, string>()
    teams.forEach(t => t.members.forEach(mm => m.set(mm.user_id, t.name)))
    return m
  }, [teams])

  const active = teams.filter(t => t.is_active)
  const totalMembers = teams.reduce((s, t) => s + t.member_count, 0)
  const unteamed = officers.filter(o => o.already_officer && o.is_active && !teamOf.has(o.id))
  const totalOverdue = teams.reduce((s, t) => s + (t.overdue || 0), 0)

  return (
    <Page title="Sales Teams"
      loading={loading && teams.length === 0}
      skeletonKpis={4}
      subtitle="Group officers under a head. A head sees and distributes their own team's leads; executives see everyone."
      actions={manage ? <Button variant="primary" icon="group_add" onClick={() => setNewOpen(true)}>New Team</Button> : undefined}>
      {error && <ErrBanner error={error} onRetry={load} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: SP[3], marginBottom: SP[4] }}>
        {[
          { label: 'Active Teams', value: fmtNum(active.length), color: NAVY, icon: 'groups' },
          { label: 'Officers On A Team', value: fmtNum(totalMembers), color: GREEN, icon: 'badge' },
          { label: 'On No Team', value: fmtNum(unteamed.length), color: unteamed.length ? AMBER : 'var(--txt3)', icon: 'person_off' },
          { label: 'Overdue Follow-Ups', value: fmtNum(totalOverdue), color: totalOverdue ? RED : 'var(--txt3)', icon: 'schedule' },
        ].map(c => (
          <div key={c.label} style={{
            background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
            borderRadius: RADIUS.xl, padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span className="material-symbols-rounded" aria-hidden style={{ fontSize: 15, color: c.color }}>{c.icon}</span>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{c.label}</span>
            </div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: c.color, lineHeight: 1 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}><Spinner size={28} /></div>
      ) : teams.length === 0 ? (
        <SectionCard title="No Teams Yet">
          <EmptyState icon="groups" title="No sales teams have been set up"
            description={manage
              ? 'Until a head is given a team they see every lead, which is the safe fallback but not the intent. Create a team to scope a head to their own officers.'
              : 'Ask a manager to set up your team.'}
            action={manage ? { label: 'New Team', icon: 'group_add', onClick: () => setNewOpen(true) } : undefined} />
        </SectionCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {teams.map(t => (
            <TeamCard key={t.id} team={t} officers={officers} teamOf={teamOf} manage={manage} onChanged={load} />
          ))}
        </div>
      )}

      {unteamed.length > 0 && (
        <UnteamedPanel officers={unteamed} teams={active} manage={manage} onChanged={load} />
      )}

      {newOpen && <NewTeamModal officers={officers} onClose={() => setNewOpen(false)} onDone={() => { setNewOpen(false); load() }} />}
    </Page>
  )
}

// ── One team ──────────────────────────────────────────────────────────────────

function TeamCard({ team, officers, teamOf, manage, onChanged }: {
  team: Team; officers: Officer[]; teamOf: Map<number, string>; manage: boolean; onChanged: () => void
}) {
  const [addId, setAddId]   = useState('')
  const [busy, setBusy]     = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function setHead(id: string) {
    try {
      await apiFetch(`/api/sales/teams/${team.id}`, { method: 'PATCH', body: JSON.stringify({ head_user_id: id ? Number(id) : 0 }) })
      toast.success(id ? 'Head updated' : 'Head removed')
      onChanged()
    } catch (e: any) { toast.error(e.message) }
  }
  async function addMember(uid?: string) {
    const id = uid ?? addId
    if (!id) return
    setBusy(true)
    try {
      await apiPost(`/api/sales/teams/${team.id}/members`, { user_id: Number(id) })
      toast.success('Officer added'); setAddId(''); onChanged()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }
  async function removeMember(uid: number, name: string) {
    try {
      await apiFetch(`/api/sales/teams/${team.id}/members/${uid}`, { method: 'DELETE' })
      toast.success(`${name} removed from ${team.name}`)
      onChanged()
    } catch (e: any) { toast.error(e.message) }
  }
  async function del() {
    setDeleting(true)
    try {
      await apiFetch(`/api/sales/teams/${team.id}`, { method: 'DELETE' })
      toast.success('Team removed'); setConfirmDel(false); onChanged()
    } catch (e: any) { toast.error(e.message) } finally { setDeleting(false) }
  }

  // Candidates for the add-picker: active officers not already on THIS team. Someone on
  // another team stays selectable but is labelled with where they are, because moving an
  // officer is a legitimate action — it should just never happen by accident.
  const memberIds = new Set(team.members.map(m => m.user_id))
  const candidates = officers
    .filter(o => o.is_active && !memberIds.has(o.id))
    .map(o => {
      const on = teamOf.get(o.id)
      return { value: String(o.id), label: o.full_name, hint: on ? `Currently on ${on}` : roleLabel(o.role) }
    })

  const headOptions = officers
    .filter(o => o.is_active)
    .map(o => ({ value: String(o.id), label: o.full_name, hint: roleLabel(o.role) }))

  const stats = [
    { label: 'Open Leads', value: fmtNum(team.open_leads), color: NAVY },
    { label: 'Qualified', value: fmtNum(team.qualified), color: PURPLE },
    { label: 'Converted (MTD)', value: fmtNum(team.converted_mtd), color: GREEN },
    { label: 'Overdue', value: fmtNum(team.overdue), color: team.overdue ? RED : 'var(--txt3)' },
    { label: 'Pipeline', value: fmtKobo(team.pipeline_kobo), color: 'var(--txt)' },
  ]

  return (
    <SectionCard
      title={team.name}
      subtitle={`${team.member_count} officer${team.member_count === 1 ? '' : 's'}${team.head_name ? ` · led by ${team.head_name}` : ' · no head yet'}`}
      actions={manage ? (
        <button onClick={() => setConfirmDel(true)} title="Delete team" style={{
          border: 'none', background: 'none', cursor: 'pointer', color: RED,
          display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.sm, fontWeight: FW.semibold,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>delete</span> Delete
        </button>
      ) : undefined}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        {/* What this team is producing */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: SP[3],
          padding: SP[3], background: 'var(--bg)', borderRadius: RADIUS.lg,
        }}>
          {stats.map(s => (
            <div key={s.label}>
              <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>{s.label}</div>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Head */}
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, minWidth: 44 }}>Head</span>
          {manage ? (
            <div style={{ minWidth: 240 }}>
              <SelectMenu value={team.head_user_id ? String(team.head_user_id) : ''} onChange={setHead}
                options={headOptions} clearLabel="No head" placeholder="Choose a head…"
                ariaLabel={`Head of ${team.name}`} leadingIcon="shield_person" />
            </div>
          ) : (
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{team.head_name || '—'}</span>
          )}
        </div>

        {/* Members */}
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Officers</div>
          {team.members.length === 0 ? (
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', marginBottom: 8 }}>
              No officers yet — this team's head sees only their own leads until someone is added.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {team.members.map(m => (
                <span key={m.user_id} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 8px 5px 5px',
                  borderRadius: RADIUS['2xl'], background: 'var(--bg)', border: '1px solid var(--bdr)',
                  fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)',
                  opacity: m.is_active ? 1 : 0.55,
                }}>
                  <Avatar name={m.full_name} size={22} />
                  <span>{m.full_name}</span>
                  {!m.is_active && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>inactive</span>}
                  {manage && (
                    <button onClick={() => removeMember(m.user_id, m.full_name)} title={`Remove ${m.full_name} from ${team.name}`}
                      style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', display: 'inline-flex', padding: 0 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          {manage && candidates.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 260, flex: '0 1 320px' }}>
                <SelectMenu value={addId} onChange={setAddId} options={candidates}
                  placeholder="Add an officer…" ariaLabel={`Add an officer to ${team.name}`} leadingIcon="person_add" />
              </div>
              <Button size="sm" variant="secondary" disabled={!addId || busy} onClick={() => addMember()}>Add</Button>
              {addId && teamOf.get(Number(addId)) && (
                <span style={{ fontSize: TEXT.xs, color: AMBER }}>
                  Moves them off {teamOf.get(Number(addId))}.
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmModal open={confirmDel} title={`Delete ${team.name}?`} danger loading={deleting}
        confirmLabel="Delete team" onConfirm={del} onClose={() => setConfirmDel(false)}
        body={`Its ${team.member_count} officer${team.member_count === 1 ? '' : 's'} become unassigned and keep their own leads. The head loses sight of the team's book.`} />
    </SectionCard>
  )
}

// ── Officers on no team ───────────────────────────────────────────────────────
//
// Its own panel rather than a line of text, because "who is unassigned?" is only half
// the question — the other half is "put them somewhere", and making that one click from
// here is the difference between a warning and a workflow.

function UnteamedPanel({ officers, teams, manage, onChanged }: {
  officers: Officer[]; teams: Team[]; manage: boolean; onChanged: () => void
}) {
  const [pending, setPending] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)

  async function assign(uid: number, name: string) {
    const teamId = pending[uid]
    if (!teamId) return
    setBusy(uid)
    try {
      await apiPost(`/api/sales/teams/${teamId}/members`, { user_id: uid })
      toast.success(`${name} added to ${teams.find(t => String(t.id) === teamId)?.name ?? 'the team'}`)
      onChanged()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(null) }
  }

  const teamOptions = teams.map(t => ({
    value: String(t.id), label: t.name,
    hint: `${t.member_count} officer${t.member_count === 1 ? '' : 's'}${t.head_name ? ` · ${t.head_name}` : ''}`,
  }))

  return (
    <SectionCard title="Officers On No Team"
      subtitle="Their leads roll up to nobody — no head sees them, and they are invisible to Team Performance."
      style={{ marginTop: SP[4] }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        {officers.map(o => (
          <div key={o.id} style={{
            display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap',
            padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.lg,
            background: `${AMBER}0A`, border: `1px solid ${AMBER}2E`,
          }}>
            <Avatar name={o.full_name} size={26} />
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{o.full_name}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{roleLabel(o.role)}</div>
            </div>
            {manage && teams.length > 0 && (
              <>
                <div style={{ width: 220 }}>
                  <SelectMenu value={pending[o.id] ?? ''} onChange={v => setPending(p => ({ ...p, [o.id]: v }))}
                    options={teamOptions} placeholder="Choose a team…" ariaLabel={`Team for ${o.full_name}`} />
                </div>
                <Button size="sm" variant="secondary" disabled={!pending[o.id] || busy === o.id}
                  onClick={() => assign(o.id, o.full_name)}>Add</Button>
              </>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

// ── New team ──────────────────────────────────────────────────────────────────

function NewTeamModal({ officers, onClose, onDone }: { officers: Officer[]; onClose: () => void; onDone: () => void }) {
  const [name, setName]     = useState('')
  const [head, setHead]     = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) { toast.error('Name the team'); return }
    setSaving(true)
    try {
      await apiPost('/api/sales/teams', { name: name.trim(), head_user_id: head ? Number(head) : null })
      toast.success('Team created'); onDone()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  const headOptions = officers.filter(o => o.is_active)
    .map(o => ({ value: String(o.id), label: o.full_name, hint: roleLabel(o.role) }))

  return (
    <Modal open onClose={onClose} title="New Sales Team" width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>Create</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Team Name" value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. Team Ozioma" autoFocus />
        <SelectMenuField label="Head (Optional)" value={head} onChange={setHead}
          options={headOptions} clearLabel="No head yet" placeholder="Choose a head…"
          hint="Naming a head is what lets them see this team's leads — no role change needed." />
        <p style={{ margin: 0, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
          You can add officers once the team exists.
        </p>
      </div>
    </Modal>
  )
}
