import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, ErrBanner, Spinner, SectionCard, Modal } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, fmtKobo } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Contact {
  id:               number
  first_name:       string
  last_name:        string
  phone:            string | null
  email:            string | null
  state:            string | null
  city:             string | null
  address:          string | null
  gender:           string | null
  occupation:       string | null
  employer:         string | null
  income_range:     string | null
  id_type:          string | null
  source:           string | null
  cif_number:       string | null
  status:           string
  tags:             string | null
  notes:            string | null
  assigned_name:    string | null
  created_by_name:  string | null
  created_at:       string
  updated_at:       string
}

interface Activity {
  id:             number
  type:           string
  subject:        string | null
  body:           string | null
  outcome:        string | null
  completed:      boolean
  duration_mins:  number | null
  next_follow_up: string | null
  agent_name:     string | null
  created_at:     string
}

interface Deal {
  id:                  number
  title:               string
  value_kobo:          number
  probability:         number
  stage_name:          string | null
  stage_color:         string | null
  assigned_name:       string | null
  expected_close_date: string | null
  status:              string
  updated_at:          string
}

interface Task {
  id:           number
  title:        string
  due_date:     string | null
  priority:     string
  status:       string
  assigned_name: string | null
}

interface C360 {
  contact:    Contact
  deals:      Deal[]
  activities: Activity[]
  tasks:      Task[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  lead: AMBER, prospect: BLUE, customer: GREEN, inactive: '#6B7280', lost: RED,
}
const ACT_ICON: Record<string, string> = {
  call: 'call', email: 'mail', meeting: 'groups', note: 'sticky_note_2', other: 'bolt',
}
const PRIORITY_COLOR: Record<string, string> = {
  high: RED, medium: AMBER, low: GREEN,
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ width: 140, fontSize: TEXT.sm, color: 'var(--txt3)', fontWeight: FW.semibold, flexShrink: 0 }}>{label}</div>
      <div style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{value}</div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ContactDetail() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [data,    setData]    = useState<C360 | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [tab,     setTab]     = useState<'overview' | 'activities' | 'deals' | 'tasks'>('overview')

  // Log activity modal
  const [showActivity, setShowActivity] = useState(false)
  const [actType,  setActType]  = useState('call')
  const [actSubj,  setActSubj]  = useState('')
  const [actBody,  setActBody]  = useState('')
  const [actOutc,  setActOutc]  = useState('')
  const [saving,   setSaving]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const d = await apiFetch<C360>(`/api/crm/contacts/${id}/360`)
      setData(d)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function logActivity() {
    setSaving(true)
    try {
      await apiPost(`/api/crm/activities`, {
        contact_id: Number(id), type: actType, subject: actSubj, body: actBody, outcome: actOutc,
      })
      toast.success('Activity logged')
      setShowActivity(false)
      setActSubj(''); setActBody(''); setActOutc('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <Page title="Contact" subtitle=""><div style={{ display:'flex', justifyContent:'center', padding:80 }}><Spinner size={32} /></div></Page>
  if (error || !data) return <Page title="Contact" subtitle=""><ErrBanner error={error ?? 'Not found'} onRetry={load} /></Page>

  const { contact, deals, activities, tasks } = data
  const statusColor = STATUS_COLOR[contact.status] ?? '#6B7280'

  const TABS = [
    { key: 'overview',   label: 'Overview'   },
    { key: 'activities', label: `Activities (${activities.length})` },
    { key: 'deals',      label: `Deals (${deals.length})`           },
    { key: 'tasks',      label: `Tasks (${tasks.filter(t=>t.status==='open').length} open)` },
  ] as const

  return (
    <Page
      title={`${contact.first_name} ${contact.last_name}`}
      subtitle={[contact.occupation, contact.employer].filter(Boolean).join(' · ')}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowActivity(true)}
            style={{ display:'flex', alignItems:'center', gap:5, padding:'7px 14px', borderRadius:RADIUS.md, border:`1px solid ${NAVY}25`, background:`${NAVY}08`, color:NAVY, fontSize:TEXT.sm, fontWeight:FW.bold, cursor:'pointer', fontFamily:INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize:15 }}>add_task</span>Log Activity
          </button>
          <button onClick={() => navigate(-1)}
            style={{ padding:'7px 14px', borderRadius:RADIUS.md, border:'1px solid var(--bdr)', background:'var(--card)', color:'var(--txt)', fontSize:TEXT.sm, cursor:'pointer' }}>
            ← Back
          </button>
        </div>
      }
    >
      {/* Contact header card */}
      <div style={{ background:'var(--card)', border:'1px solid var(--bdr)', borderRadius:RADIUS.xl, padding:`${SP[5]} ${SP[6]}`, marginBottom:SP[5] }}>
        <div style={{ display:'flex', gap:18, alignItems:'flex-start' }}>
          {/* Avatar */}
          <div style={{ width:56, height:56, borderRadius:RADIUS.full, background:`${NAVY}15`, border:`2px solid ${NAVY}30`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:TEXT['2xl'], fontWeight:FW.extrabold, color:NAVY, flexShrink:0, fontFamily:INTER }}>
            {contact.first_name.charAt(0).toUpperCase()}{contact.last_name.charAt(0).toUpperCase()}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
              <h2 style={{ margin:0, fontSize:TEXT['2xl'], fontWeight:FW.extrabold, color:'var(--txt)' }}>{contact.first_name} {contact.last_name}</h2>
              <span style={{ fontSize:TEXT.xs, fontWeight:FW.bold, padding:'2px 10px', borderRadius:RADIUS.lg, background:`${statusColor}18`, color:statusColor, textTransform:'capitalize' }}>
                {contact.status}
              </span>
              {contact.cif_number && (
                <span style={{ fontSize:TEXT.xs, color:'var(--txt3)', background:'var(--row-hvr)', padding:`2px ${SP[2]}`, borderRadius:RADIUS.sm }}>CIF: {contact.cif_number}</span>
              )}
            </div>
            <div style={{ display:'flex', gap:20, marginTop:8, flexWrap:'wrap' }}>
              {contact.phone  && <a href={`tel:${contact.phone}`}  style={{ fontSize:TEXT.base, color:NAVY, textDecoration:'none', display:'flex', alignItems:'center', gap:4 }}><span className="material-symbols-rounded" style={{fontSize:15}}>call</span>{contact.phone}</a>}
              {contact.email  && <a href={`mailto:${contact.email}`} style={{ fontSize:TEXT.base, color:NAVY, textDecoration:'none', display:'flex', alignItems:'center', gap:4 }}><span className="material-symbols-rounded" style={{fontSize:15}}>mail</span>{contact.email}</a>}
              {contact.assigned_name && <span style={{ fontSize:TEXT.sm, color:'var(--txt3)', display:'flex', alignItems:'center', gap:4 }}><span className="material-symbols-rounded" style={{fontSize:14}}>person</span>{contact.assigned_name}</span>}
            </div>
          </div>
          {/* Summary KPIs */}
          <div style={{ display:'flex', gap:16, flexShrink:0 }}>
            {[
              { label:'Deals',     value: deals.length,                                        color:BLUE  },
              { label:'Open Tasks',value: tasks.filter(t=>t.status==='open').length,            color:AMBER },
              { label:'Activities',value: activities.length,                                    color:NAVY  },
            ].map(({label,value,color}) => (
              <div key={label} style={{ textAlign:'center', padding:`${SP[2]} ${SP[3]}`, background:`${color}08`, borderRadius:RADIUS.lg, border:`1px solid ${color}20` }}>
                <div style={{ fontSize:TEXT['2xl'], fontWeight:FW.extrabold, color, ...NUM }}>{value}</div>
                <div style={{ fontSize:TEXT['2xs'], fontWeight:FW.semibold, color:'var(--txt3)', marginTop:2 }}>{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:'2px solid var(--bdr)' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key as any)}
            style={{ padding:'9px 18px', background:'none', border:'none', borderBottom: tab===t.key ? `2px solid ${NAVY}` : '2px solid transparent', marginBottom:-2, color: tab===t.key ? NAVY : 'var(--txt2)', fontWeight: tab===t.key ? FW.bold : FW.medium, fontSize:TEXT.base, cursor:'pointer', fontFamily:INTER }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview tab */}
      {tab === 'overview' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <SectionCard title="Personal Info">
            <div>
              <InfoRow label="Full Name"     value={`${contact.first_name} ${contact.last_name}`} />
              <InfoRow label="Phone"         value={contact.phone} />
              <InfoRow label="Email"         value={contact.email} />
              <InfoRow label="Gender"        value={contact.gender} />
              <InfoRow label="Occupation"    value={contact.occupation} />
              <InfoRow label="Employer"      value={contact.employer} />
              <InfoRow label="Income Range"  value={contact.income_range} />
              <InfoRow label="ID Type"       value={contact.id_type} />
              <InfoRow label="Source"        value={contact.source} />
            </div>
          </SectionCard>
          <SectionCard title="Location & Notes">
            <div>
              <InfoRow label="Address"       value={contact.address} />
              <InfoRow label="City"          value={contact.city} />
              <InfoRow label="State"         value={contact.state} />
              <InfoRow label="Assigned To"   value={contact.assigned_name} />
              <InfoRow label="Created By"    value={contact.created_by_name} />
              <InfoRow label="Created"       value={fmtDate(contact.created_at)} />
              <InfoRow label="Tags"          value={contact.tags} />
            </div>
            {contact.notes && (
              <div style={{ marginTop:12, padding:'10px 12px', background:'var(--row-hvr)', borderRadius:RADIUS.md, fontSize:TEXT.base, color:'var(--txt2)' }}>
                {contact.notes}
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {/* Activities tab */}
      {tab === 'activities' && (
        <SectionCard title="Activity Timeline" actions={
          <button onClick={() => setShowActivity(true)}
            style={{ padding:'5px 12px', borderRadius:RADIUS.md, border:'none', background:`${NAVY}12`, color:NAVY, fontSize:TEXT.sm, fontWeight:FW.semibold, cursor:'pointer' }}>
            + Log Activity
          </button>
        }>
          {activities.length === 0 ? (
            <div style={{ textAlign:'center', padding:SP[10], color:'var(--txt3)', fontSize:TEXT.base }}>No activities yet</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
              {activities.map((act, i) => (
                <div key={act.id} style={{ display:'flex', gap:14, padding:'12px 0', borderBottom: i<activities.length-1 ? '1px solid var(--bdr)' : 'none' }}>
                  <div style={{ width:32, height:32, borderRadius:RADIUS.full, background:`${NAVY}10`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <span className="material-symbols-rounded" style={{ fontSize:TEXT.lg, color:NAVY }}>{ACT_ICON[act.type] ?? 'bolt'}</span>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
                      <span style={{ fontSize:TEXT.base, fontWeight:FW.semibold, color:'var(--txt)', textTransform:'capitalize' }}>{act.type}{act.subject ? `: ${act.subject}` : ''}</span>
                      <span style={{ fontSize:TEXT.xs, color:'var(--txt3)' }}>{fmtDate(act.created_at)}</span>
                    </div>
                    {act.body    && <div style={{ fontSize:TEXT.sm, color:'var(--txt2)', marginTop:3 }}>{act.body}</div>}
                    {act.outcome && <div style={{ fontSize:TEXT.sm, color:GREEN, marginTop:3 }}>Outcome: {act.outcome}</div>}
                    {act.agent_name && <div style={{ fontSize:TEXT.xs, color:'var(--txt3)', marginTop:3 }}>By {act.agent_name}{act.duration_mins ? ` · ${act.duration_mins}min` : ''}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Deals tab */}
      {tab === 'deals' && (
        <SectionCard title="Deals Pipeline" badge={deals.length}>
          {deals.length === 0 ? (
            <div style={{ textAlign:'center', padding:SP[10], color:'var(--txt3)', fontSize:TEXT.base }}>No deals yet</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {deals.map(deal => (
                <div key={deal.id} style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 14px', background:'var(--row-hvr)', borderRadius:10, border:'1px solid var(--bdr)' }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:TEXT.base, fontWeight:FW.bold, color:'var(--txt)' }}>{deal.title}</div>
                    <div style={{ fontSize:TEXT.xs, color:'var(--txt3)', marginTop:3 }}>
                      {deal.assigned_name && `${deal.assigned_name} · `}
                      {deal.expected_close_date && `Close: ${fmtDate(deal.expected_close_date)}`}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:15, fontWeight:FW.extrabold, color:NAVY, ...NUM }}>{fmtKobo(deal.value_kobo)}</div>
                    <div style={{ fontSize:TEXT.xs, color:'var(--txt3)', marginTop:2 }}>{deal.probability}% likely</div>
                  </div>
                  {deal.stage_name && (
                    <span style={{ fontSize:TEXT.xs, fontWeight:FW.bold, padding:'3px 9px', borderRadius:RADIUS.md, background:deal.stage_color ? `${deal.stage_color}20` : `${BLUE}15`, color:deal.stage_color ?? BLUE }}>
                      {deal.stage_name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Tasks tab */}
      {tab === 'tasks' && (
        <SectionCard title="Tasks" badge={tasks.length}>
          {tasks.length === 0 ? (
            <div style={{ textAlign:'center', padding:SP[10], color:'var(--txt3)', fontSize:TEXT.base }}>No tasks</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
              {tasks.map(task => (
                <div key={task.id} style={{ display:'flex', alignItems:'center', gap:SP[3], padding:'10px 12px', borderRadius:RADIUS.md, background: task.status==='done' ? `${GREEN}06` : 'transparent' }}>
                  <span className="material-symbols-rounded" style={{ fontSize:TEXT.xl, color: task.status==='done' ? GREEN : '#D1D5DB' }}>
                    {task.status==='done' ? 'check_circle' : 'radio_button_unchecked'}
                  </span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:TEXT.base, fontWeight: task.status==='done' ? FW.normal : FW.semibold, color: task.status==='done' ? 'var(--txt3)' : 'var(--txt)', textDecoration: task.status==='done' ? 'line-through' : 'none' }}>
                      {task.title}
                    </div>
                    {task.due_date && <div style={{ fontSize:TEXT.xs, color:'var(--txt3)', marginTop:2 }}>Due: {fmtDate(task.due_date)}</div>}
                  </div>
                  <span style={{ fontSize:TEXT.xs, fontWeight:FW.bold, padding:'2px 7px', borderRadius:RADIUS.md, background:`${PRIORITY_COLOR[task.priority] ?? 'var(--chart-lbl)'}18`, color:PRIORITY_COLOR[task.priority] ?? 'var(--chart-lbl)' }}>
                    {task.priority}
                  </span>
                  {task.assigned_name && <span style={{ fontSize:TEXT.xs, color:'var(--txt3)' }}>{task.assigned_name}</span>}
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* Log Activity modal */}
      <Modal open={showActivity} onClose={() => setShowActivity(false)} title="Log Activity" width={440}
        footer={
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={logActivity} disabled={saving}
              style={{ padding:`${SP[2]} ${SP[5]}`, borderRadius:RADIUS.md, border:'none', background:NAVY, color:'#fff', fontSize:TEXT.base, fontWeight:FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display:'inline-flex', alignItems:'center', gap:6 }}>
              {saving && <Spinner size={13} color="#fff" />}Log
            </button>
            <button onClick={() => setShowActivity(false)} style={{ padding:`${SP[2]} ${SP[4]}`, borderRadius:RADIUS.md, border:'1px solid var(--bdr)', background:'var(--card)', color:'var(--txt)', fontSize:TEXT.base, cursor:'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={{ display:'block', fontSize:TEXT.sm, fontWeight:FW.semibold, color:'var(--txt2)', marginBottom:5 }}>Type</label>
            <select value={actType} onChange={e => setActType(e.target.value)}
              style={{ width:'100%', padding:`${SP[2]} 10px`, border:'1px solid var(--input-bdr)', borderRadius:RADIUS.md, fontSize:TEXT.base, background:'var(--input-bg)', color:'var(--txt)', boxSizing:'border-box' }}>
              {['call','email','meeting','note','other'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display:'block', fontSize:TEXT.sm, fontWeight:FW.semibold, color:'var(--txt2)', marginBottom:5 }}>Subject</label>
            <input value={actSubj} onChange={e => setActSubj(e.target.value)}
              style={{ width:'100%', padding:`${SP[2]} 10px`, border:'1px solid var(--input-bdr)', borderRadius:RADIUS.md, fontSize:TEXT.base, background:'var(--input-bg)', color:'var(--txt)', boxSizing:'border-box' }} />
          </div>
          <div>
            <label style={{ display:'block', fontSize:TEXT.sm, fontWeight:FW.semibold, color:'var(--txt2)', marginBottom:5 }}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={actBody} onChange={e => setActBody(e.target.value)} rows={3}
              style={{ width:'100%', padding:'8px 10px', border:'1px solid var(--input-bdr)', borderRadius:7, fontSize:TEXT.base, background:'var(--input-bg)', color:'var(--txt)', boxSizing:'border-box', resize:'vertical' }} />
          </div>
          <div>
            <label style={{ display:'block', fontSize:TEXT.sm, fontWeight:FW.semibold, color:'var(--txt2)', marginBottom:5 }}>Outcome</label>
            <input value={actOutc} onChange={e => setActOutc(e.target.value)}
              style={{ width:'100%', padding:`${SP[2]} 10px`, border:'1px solid var(--input-bdr)', borderRadius:RADIUS.md, fontSize:TEXT.base, background:'var(--input-bg)', color:'var(--txt)', boxSizing:'border-box' }} />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
