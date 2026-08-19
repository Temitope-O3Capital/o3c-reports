import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, DataTable, ErrBanner, Spinner, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton, LiveBadge, relTime } from '../../components/MyWorkspace'
import NewApplicationModal, { type DraftApp } from '../../components/NewApplicationModal'
import { productLabel } from '../../lib/products'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PipelineStage { stage: string; count: number; value_kobo: number }

interface Lead {
  id: number; company_name: string; contact_name: string
  stage: string; potential_value_kobo: number; updated_at: string; lead_score: number
}

interface FollowUp {
  id: number; name: string | null; next_action_at: string
  lead_stage: string; phone: string | null; estimated_value_kobo: number
}

interface Activity {
  id: number; type: string; subject: string | null; outcome: string | null
  created_at: string; contact_id: number; contact_name: string | null
}

interface SalesAgentDash {
  my_leads: number; won_mtd: number; conversion_rate_pct: number
  target_kobo: number; achieved_kobo: number; target_pct: number
  commission_kobo: number
  pipeline: PipelineStage[]
  recent_leads: Lead[]
  monthly_trend: { month: string; leads: number; won: number }[]
  // Phase 2 station fields.
  rank_mtd: number; team_size: number
  followups_due: number; followups_overdue: number; stalled_leads: number
  next_followups: FollowUp[]
  recent_activity: Activity[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  Prospect: BLUE, Qualified: AMBER, Proposal: NAVY, Negotiation: PURPLE, Won: GREEN,
}
function stageColor(s: string) { return STAGE_COLORS[s] ?? NAVY }
function targetColor(pct: number) { return pct >= 100 ? GREEN : pct >= 70 ? AMBER : RED }

const ACT_ICON: Record<string, string> = {
  call: 'call', meeting: 'groups', email: 'mail', note: 'sticky_note_2',
  visit: 'location_on', sms: 'sms', whatsapp: 'chat',
}
function actIcon(t: string) { return ACT_ICON[t?.toLowerCase()] ?? 'bolt' }

// Follow-up dates need a three-state read at a glance: overdue, due today, or a
// future date. relTime alone can't express "today" cleanly, so classify here.
function dueMeta(iso: string): { label: string; color: string } {
  const d = new Date(iso); const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  if (day(d) < day(now)) return { label: 'Overdue', color: RED }
  if (day(d) === day(now)) return { label: 'Today', color: AMBER }
  return { label: fmtDate(iso), color: 'var(--txt2)' }
}

// Charts sit on white cards, so keep the light tooltip variant here.
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm }}>
      <p style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color, marginBottom: 2 }}>{p.name}: {p.value}</p>
      ))}
    </div>
  )
}

// ── Log-activity quick action ───────────────────────────────────────────────
//
// The call-centre station's per-row "Log" button is the interaction that keeps its
// data alive. This is the sales equivalent: log a touch against a lead and, because
// the backend syncs last_activity_at / next_action_at, the follow-up worklist and
// the "stalled" counters update the moment it saves.

function LogActivityModal({ lead, onClose, onSaved }: {
  lead: { id: number; name: string | null }; onClose: () => void; onSaved: () => void
}) {
  const [type, setType] = useState('call')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [outcome, setOutcome] = useState('')
  const [nextFollow, setNextFollow] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await apiPost('/api/crm/activities', {
        contact_id: lead.id, type,
        subject: subject || null, body: body || null, outcome: outcome || null,
        next_follow_up: nextFollow ? new Date(nextFollow).toISOString() : null,
        completed: true,
      })
      toast.success('Activity logged')
      onSaved()
    } catch (e: any) { toast.error(e.message ?? 'Could not log activity') }
    finally { setSaving(false) }
  }

  const field: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base,
    border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)',
  }
  const lbl: React.CSSProperties = { fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4, display: 'block' }

  return (
    <Modal open onClose={onClose} title={`Log activity: ${lead.name ?? 'lead'}`} width={480}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: 'none', background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Log activity'}</button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>Type</label>
            <select value={type} onChange={e => setType(e.target.value)} style={field}>
              <option value="call">Call</option>
              <option value="meeting">Meeting</option>
              <option value="email">Email</option>
              <option value="visit">Visit</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="note">Note</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Next follow-up</label>
            <input type="date" value={nextFollow} onChange={e => setNextFollow(e.target.value)} style={field} />
          </div>
        </div>
        <div>
          <label style={lbl}>Subject</label>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Discussed loan top-up" style={field} />
        </div>
        <div>
          <label style={lbl}>Notes</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={3} placeholder="What happened?" style={{ ...field, resize: 'vertical' }} />
        </div>
        <div>
          <label style={lbl}>Outcome</label>
          <input value={outcome} onChange={e => setOutcome(e.target.value)} placeholder="e.g. Interested, callback booked" style={field} />
        </div>
      </div>
    </Modal>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SalesMyDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<SalesAgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logLead, setLogLead] = useState<{ id: number; name: string | null } | null>(null)
  const [appOpen, setAppOpen] = useState(false)
  const [editDraft, setEditDraft] = useState<DraftApp | null>(null)
  const [drafts, setDrafts] = useState<DraftApp[]>([])
  const [taskOpen, setTaskOpen] = useState(false)
  const [tTitle, setTTitle] = useState('')
  const [tPriority, setTPriority] = useState('medium')
  const [tDue, setTDue] = useState('')
  const [tSaving, setTSaving] = useState(false)

  async function saveTask() {
    if (!tTitle.trim()) { toast.error('Enter a task title'); return }
    setTSaving(true)
    try {
      const body: any = { title: tTitle.trim(), priority: tPriority }
      if (tDue) body.due_date = tDue
      await apiPost('/api/crm/tasks', body)
      toast.success('Task created')
      setTaskOpen(false); setTTitle(''); setTPriority('medium'); setTDue('')
    } catch (e: any) { toast.error(e.message) }
    finally { setTSaving(false) }
  }

  const loadDrafts = useCallback(async () => {
    try {
      const r = await apiFetch<{ data: any[] }>('/api/sales/applications?limit=100')
      const rows = (r?.data ?? []) as any[]
      setDrafts(rows.filter(a => a.status === 'draft'))
    } catch { /* non-fatal */ }
  }, [])

  const load = useCallback(async (silent = false) => {
    setError(null)
    try {
      loadDrafts()
      const r = await apiFetch<{ data: SalesAgentDash }>('/api/sales/my-dashboard')
      // Normalise arrays so a missing field can never throw on .length/.map — the
      // exact failure class that white-screened this page before Phase 0.
      setData({
        ...r.data,
        pipeline: r.data.pipeline ?? [],
        recent_leads: r.data.recent_leads ?? [],
        monthly_trend: r.data.monthly_trend ?? [],
        next_followups: r.data.next_followups ?? [],
        recent_activity: r.data.recent_activity ?? [],
      })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [loadDrafts])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals', 'crm'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !data) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !data) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!data) return null

  const tColor = targetColor(data.target_pct)
  const achievedPct = Math.min(100, data.target_pct)
  const remaining = Math.max(0, data.target_kobo - data.achieved_kobo)
  const stageCount = (name: string) => data.pipeline.find(p => p.stage.toLowerCase() === name)?.count ?? 0
  const openPipelineValue = data.pipeline.filter(p => p.stage.toLowerCase() !== 'won').reduce((s, p) => s + Number(p.value_kobo), 0)
  const ranked = data.team_size > 1 && data.rank_mtd > 0

  const leadCols: TableCol<Lead>[] = [
    { key: 'company_name', label: 'Company', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.company_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{r.contact_name}</div>
      </div>
    )},
    { key: 'stage', label: 'Stage', render: r => <StatusPill label={r.stage} color={stageColor(r.stage)} /> },
    { key: 'potential_value_kobo', label: 'Est. Value', render: r => <span style={NUM}>{fmtKobo(r.potential_value_kobo)}</span> },
    { key: 'updated_at', label: 'Last Updated', render: r => fmtDate(r.updated_at) },
    { key: 'id', label: '', render: r => (
      <button onClick={e => { e.stopPropagation(); setLogLead({ id: r.id, name: r.contact_name || r.company_name }) }}
        style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: RED, background: 'none', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '3px 10px', cursor: 'pointer' }}>Log</button>
    )},
  ]

  return (
    <Page title="My Workspace" subtitle="Your sales station: pipeline, targets and leads">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={data.target_pct >= 100
          ? <>Target smashed: <strong style={{ color: '#fff' }}>{fmtPct(data.target_pct)}</strong> of your monthly goal</>
          : ranked
            ? <>You're <strong style={{ color: '#fff' }}>#{data.rank_mtd}</strong> of {data.team_size} this month · <strong style={{ color: '#fff' }}>{fmtPct(data.target_pct)}</strong> to target · {fmtKobo(remaining)} to go</>
            : <>You're at <strong style={{ color: '#fff' }}>{fmtPct(data.target_pct)}</strong> of your monthly target · {fmtKobo(remaining)} to go</>}
        ring={{ value: Math.round(data.target_pct), max: 100, unit: '% target' }}
        stats={[
          { label: 'Won MTD', value: fmtNum(data.won_mtd), color: '#4ADE80' },
          { label: 'My Leads', value: fmtNum(data.my_leads) },
          { label: 'Conversion', value: fmtPct(data.conversion_rate_pct) },
          { label: 'Achieved', value: fmtKobo(data.achieved_kobo), color: '#4ADE80' },
          { label: 'Target', value: fmtKobo(data.target_kobo) },
          { label: 'Commission', value: fmtKobo(data.commission_kobo ?? 0), color: '#FBBF24' },
          { label: 'Open Pipeline', value: fmtKobo(openPipelineValue) },
        ]}
        actions={<>
          <HeroButton icon="view_kanban" label="Pipeline" primary onClick={() => navigate('/sales/leads')} />
          <HeroButton icon="contacts" label="My Leads" onClick={() => navigate('/sales/leads')} />
          <HeroButton icon="account_balance_wallet" label="My Book" onClick={() => navigate('/sales/book')} />
          <HeroButton icon="note_add" label="New Application" onClick={() => { setEditDraft(null); setAppOpen(true) }} />
          <HeroButton icon="add_task" label="New Task" onClick={() => setTaskOpen(true)} />
          <HeroButton icon="flag" label="Targets" onClick={() => navigate('/sales/targets')} />
        </>}
      />

      {/* ── My Day ─────────────────────────────────────────────────────────── */}
      <MyDaySection hint="your day at a glance">
        <MyDayTile icon="event_upcoming" count={fmtNum(data.followups_due)} label="Follow-ups due today"
          sub={data.followups_due > 0 ? 'reach out today' : 'nothing due today'}
          color={BLUE} urgent={data.followups_due > 0} onClick={() => navigate('/sales/leads?due=1')} />
        <MyDayTile icon="alarm" count={fmtNum(data.followups_overdue)} label="Overdue follow-ups"
          sub={data.followups_overdue > 0 ? 'past their date' : 'all caught up'}
          color={RED} urgent={data.followups_overdue > 0} onClick={() => navigate('/sales/leads?due=overdue')} />
        <MyDayTile icon="pause_circle" count={fmtNum(data.stalled_leads)} label="Stalled leads"
          sub="untouched 14+ days" color={AMBER} urgent={data.stalled_leads > 0} onClick={() => navigate('/sales/leads?stage=qualified')} />
        <MyDayTile icon="handshake" count={fmtNum(stageCount('negotiation'))} label="In negotiation"
          sub={stageCount('negotiation') > 0 ? 'close these to win' : 'nothing in negotiation'}
          color={PURPLE} urgent={stageCount('negotiation') > 0} onClick={() => navigate('/sales/leads?stage=qualified')} />
        <MyDayTile icon="flag" count={data.target_pct >= 100 ? 'Met' : fmtKobo(remaining)} label="Gap to target"
          sub={data.target_pct >= 100 ? 'target achieved' : 'still to book this month'}
          color={tColor} urgent={data.target_pct < 70} onClick={() => navigate('/sales/targets')} />
      </MyDaySection>

      {/* Target progress bar */}
      <SectionCard title="Target Progress" style={{ marginBottom: SP[4] }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[2] }}>
          <span>Achieved: <strong style={{ color: 'var(--txt)' }}>{fmtKobo(data.achieved_kobo)}</strong></span>
          <span>Target: <strong style={{ color: 'var(--txt)' }}>{fmtKobo(data.target_kobo)}</strong></span>
        </div>
        <div style={{ height: 12, background: 'var(--th-bg)', borderRadius: RADIUS.full, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${achievedPct}%`, background: tColor, borderRadius: RADIUS.full, transition: 'width 0.4s ease' }} />
        </div>
        <div style={{ textAlign: 'right', fontSize: TEXT.xs, color: tColor, fontWeight: FW.semibold, marginTop: SP[1] }}>
          {fmtPct(data.target_pct)} of target
        </div>
      </SectionCard>

      {/* ── My Follow-ups + Recent Activity ─────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: SP[4] }}>
        <SectionCard title="My Follow-ups" subtitle="Soonest first, overdue at the top" badge={data.next_followups.length || undefined}>
          {data.next_followups.length === 0 ? (
            <EmptyHint icon="event_available" text="No follow-ups scheduled. Log an activity on a lead and set its next date to build your queue." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.next_followups.map(f => {
                const m = dueMeta(f.next_action_at)
                return (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `${SP[2]} 0`, borderBottom: '1px solid var(--bdr)' }}>
                    <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => navigate(`/sales/customers/${f.id}`)}>
                      <div style={{ fontWeight: FW.semibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name ?? 'Unknown lead'}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{f.lead_stage}{f.phone ? ` · ${f.phone}` : ''}</div>
                    </div>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: m.color, whiteSpace: 'nowrap' }}>{m.label}</span>
                    <button onClick={() => setLogLead({ id: f.id, name: f.name })}
                      style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: RED, background: 'none', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '3px 10px', cursor: 'pointer' }}>Log</button>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard title="My Recent Activity" actions={<LiveBadge />}>
          {data.recent_activity.length === 0 ? (
            <EmptyHint icon="history" text="Nothing logged yet. Your calls, meetings and notes appear here as you work your leads." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.recent_activity.map(a => (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `${SP[2]} 0`, borderBottom: '1px solid var(--bdr)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY, flexShrink: 0 }}>{actIcon(a.type)}</span>
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => navigate(`/sales/customers/${a.contact_id}`)}>
                    <div style={{ fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.subject || a.type}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{a.contact_name ?? '—'}{a.outcome ? ` · ${a.outcome}` : ''}</div>
                  </div>
                  <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{relTime(a.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Pipeline + Trend charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: SP[4] }}>
        <SectionCard title="Pipeline by Stage">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.pipeline} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="stage" tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="count" name="Leads" fill={NAVY} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Monthly Trend">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.monthly_trend} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="sLeads" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sWon" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={GREEN} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="leads" name="Leads" stroke={NAVY} fill="url(#sLeads)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="won" name="Won" stroke={GREEN} fill="url(#sWon)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>

      {/* Recent leads */}
      <SectionCard title="My Recent Leads" badge={data.recent_leads.length}>
        <DataTable
          cols={leadCols}
          rows={data.recent_leads}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/sales/customers/${r.id}`)}
          searchKeys={['company_name', 'contact_name', 'stage']}
          searchPlaceholder="Search leads…"
          pageSize={10}
          emptyText="No leads found"
        />
      </SectionCard>

      {/* Draft applications — parked, waiting to be completed and submitted */}
      {drafts.length > 0 && (
        <SectionCard title="Draft applications" badge={drafts.length} style={{ marginTop: SP[4] }}
          subtitle="Parked applications — resume to complete and submit">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {drafts.map(d => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `${SP[2]} 0`, borderBottom: '1px solid var(--bdr)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER, flexShrink: 0 }}>draft</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: FW.semibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.applicant_name || d.applicant_cif} · {productLabel(d.product_type)}
                  </div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>
                    CIF {d.applicant_cif}{d.amount_requested_kobo ? ` · ${fmtKobo(d.amount_requested_kobo)}` : ''}
                  </div>
                </div>
                <button onClick={() => { setEditDraft(d); setAppOpen(true) }}
                  style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: 'none', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '3px 12px', cursor: 'pointer' }}>Resume</button>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {logLead && (
        <LogActivityModal lead={logLead} onClose={() => setLogLead(null)} onSaved={() => { setLogLead(null); load() }} />
      )}

      <NewApplicationModal
        open={appOpen}
        draft={editDraft}
        onClose={() => { setAppOpen(false); setEditDraft(null) }}
        onSaved={() => { setAppOpen(false); setEditDraft(null); load() }}
      />

      <Modal open={taskOpen} onClose={() => setTaskOpen(false)} title="New task" width={460}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <button onClick={() => { setTaskOpen(false); navigate('/sales/tasks') }}
              style={{ background: 'none', border: 'none', color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', padding: 0 }}>See all tasks</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setTaskOpen(false)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveTask} disabled={tSaving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: tSaving ? 'wait' : 'pointer', opacity: tSaving ? 0.7 : 1 }}>{tSaving ? 'Saving…' : 'Create task'}</button>
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }}>Title</label>
            <input value={tTitle} onChange={e => setTTitle(e.target.value)} placeholder="e.g. Call back Mr Okoro about FD rollover"
              style={{ width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', boxSizing: 'border-box' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }}>Priority</label>
              <select value={tPriority} onChange={e => setTPriority(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', boxSizing: 'border-box' }}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }}>Due date</label>
              <input type="date" value={tDue} onChange={e => setTDue(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
          </div>
        </div>
      </Modal>
    </Page>
  )
}

function EmptyHint({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '32px 16px', textAlign: 'center' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 28, color: 'var(--txt3)' }}>{icon}</span>
      <p style={{ fontSize: TEXT.sm, color: 'var(--txt3)', maxWidth: 320, lineHeight: 1.5 }}>{text}</p>
    </div>
  )
}
