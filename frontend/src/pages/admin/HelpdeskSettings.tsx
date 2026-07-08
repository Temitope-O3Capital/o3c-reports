import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Modal, ConfirmModal, Spinner, Tabs } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, SORA } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RoutingRule {
  id: number
  name: string
  conditions: Record<string, string>
  target_queue: string
  priority: number
  active: boolean
  created_at: string
  updated_at: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const QUEUES = ['general', 'collections', 'cards', 'loans', 'compliance', 'technical', 'vip']

const TICKET_TYPES = [
  'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Card Dispute',
  'Statement Request', 'Loan Complaint', 'FD Enquiry', 'Technical / App Issue',
  'Complaint (CBN reportable)',
]

const CHANNELS = ['portal', 'email', 'phone', 'whatsapp', 'sms', 'walk-in']

const PRIORITIES = ['low', 'medium', 'high', 'urgent']

// ── Call script types ─────────────────────────────────────────────────────────

interface CallScriptStep { order: number; prompt: string; options?: string[] }
interface CallScript { id: number; ticket_type: string; name: string; steps: CallScriptStep[]; is_active: boolean }

interface ScriptForm {
  name: string
  ticket_type: string
  steps: { prompt: string }[]
  is_active: boolean
}

const EMPTY_SCRIPT_FORM: ScriptForm = { name: '', ticket_type: '', steps: [{ prompt: '' }], is_active: true }

// ── SLA policy types ──────────────────────────────────────────────────────────

interface SLAPolicy {
  id: number
  priority: string
  first_response_hours: number
  resolution_hours: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5,
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  boxSizing: 'border-box',
}

function conditionsSummary(cond: Record<string, string>): string {
  if (!cond || Object.keys(cond).length === 0) return 'All tickets'
  return Object.entries(cond)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} = ${v}`)
    .join(' · ')
}

// ── Rule form ─────────────────────────────────────────────────────────────────

interface RuleForm {
  name: string
  target_queue: string
  priority: number
  active: boolean
  cond_ticket_type: string
  cond_channel: string
  cond_priority: string
}

const EMPTY_FORM: RuleForm = {
  name: '', target_queue: 'general', priority: 10, active: true,
  cond_ticket_type: '', cond_channel: '', cond_priority: '',
}

function formToConditions(f: RuleForm): Record<string, string> {
  const c: Record<string, string> = {}
  if (f.cond_ticket_type) c.ticket_type = f.cond_ticket_type
  if (f.cond_channel) c.channel = f.cond_channel
  if (f.cond_priority) c.priority = f.cond_priority
  return c
}

function conditionsToForm(cond: Record<string, string>): Pick<RuleForm, 'cond_ticket_type' | 'cond_channel' | 'cond_priority'> {
  return {
    cond_ticket_type: cond?.ticket_type ?? '',
    cond_channel: cond?.channel ?? '',
    cond_priority: cond?.priority ?? '',
  }
}

function RuleFormFields({ form, onChange }: { form: RuleForm; onChange: (f: RuleForm) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={labelStyle}>Rule Name *</label>
        <input
          value={form.name} onChange={e => onChange({ ...form, name: e.target.value })}
          placeholder="e.g. Route card disputes to cards queue"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Target Queue *</label>
          <select value={form.target_queue} onChange={e => onChange({ ...form, target_queue: e.target.value })} style={{ ...inputStyle }}>
            {QUEUES.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Priority (lower = runs first)</label>
          <input
            type="number" min={1} max={100} value={form.priority}
            onChange={e => onChange({ ...form, priority: Number(e.target.value) })}
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', paddingTop: 4 }}>
        Match Conditions (leave blank to match all)
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Ticket Type</label>
          <select value={form.cond_ticket_type} onChange={e => onChange({ ...form, cond_ticket_type: e.target.value })} style={{ ...inputStyle }}>
            <option value="">Any</option>
            {TICKET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Channel</label>
          <select value={form.cond_channel} onChange={e => onChange({ ...form, cond_channel: e.target.value })} style={{ ...inputStyle }}>
            <option value="">Any</option>
            {CHANNELS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Priority</label>
          <select value={form.cond_priority} onChange={e => onChange({ ...form, cond_priority: e.target.value })} style={{ ...inputStyle }}>
            <option value="">Any</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 22 }}>
          <input type="checkbox" id="rule-active" checked={form.active} onChange={e => onChange({ ...form, active: e.target.checked })} style={{ width: 15, height: 15, cursor: 'pointer' }} />
          <label htmlFor="rule-active" style={{ fontSize: 13, color: 'var(--txt)', cursor: 'pointer' }}>Rule is active</label>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HelpdeskSettings() {
  const [activeTab, setActiveTab] = useState('routing')

  // ── Routing rules state ──────────────────────────────────────────────────────
  const [rules, setRules] = useState<RoutingRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [newOpen, setNewOpen] = useState(false)
  const [editRule, setEditRule] = useState<RoutingRule | null>(null)
  const [deleteRule, setDeleteRule] = useState<RoutingRule | null>(null)
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // ── Call scripts state ───────────────────────────────────────────────────────
  const [scripts, setScripts] = useState<CallScript[]>([])
  const [scriptsLoading, setScriptsLoading] = useState(false)
  const [scriptsError, setScriptsError] = useState<string | null>(null)
  const [scriptModalOpen, setScriptModalOpen] = useState(false)
  const [editScript, setEditScript] = useState<CallScript | null>(null)
  const [deleteScript, setDeleteScript] = useState<CallScript | null>(null)
  const [scriptForm, setScriptForm] = useState<ScriptForm>(EMPTY_SCRIPT_FORM)
  const [scriptSaving, setScriptSaving] = useState(false)
  const [scriptDeleting, setScriptDeleting] = useState(false)

  // ── SLA policies state ───────────────────────────────────────────────────────
  const [slaList, setSlaList] = useState<SLAPolicy[]>([])
  const [slaLoading, setSlaLoading] = useState(false)
  const [slaError, setSlaError] = useState<string | null>(null)
  const [slaEditing, setSlaEditing] = useState<number | null>(null)
  const [slaForm, setSlaForm] = useState<{ first_response_hours: number; resolution_hours: number }>({ first_response_hours: 0, resolution_hours: 0 })
  const [slaSaving, setSlaSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<RoutingRule[]>('/api/helpdesk/routing-rules')
      setRules(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadScripts = useCallback(async () => {
    setScriptsLoading(true)
    setScriptsError(null)
    try {
      const data = await apiFetch<CallScript[]>('/api/helpdesk/call-scripts')
      setScripts(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setScriptsError(e.message)
    } finally {
      setScriptsLoading(false)
    }
  }, [])

  const loadSLA = useCallback(async () => {
    setSlaLoading(true)
    setSlaError(null)
    try {
      const data = await apiFetch<SLAPolicy[]>('/api/helpdesk/sla-policies')
      setSlaList(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setSlaError(e.message)
    } finally {
      setSlaLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (activeTab === 'scripts') loadScripts()
    if (activeTab === 'sla') loadSLA()
  }, [activeTab, loadScripts, loadSLA])

  // ── Routing rule handlers ────────────────────────────────────────────────────

  function openNew() {
    setForm(EMPTY_FORM)
    setNewOpen(true)
  }

  function openEdit(r: RoutingRule) {
    setForm({
      name: r.name,
      target_queue: r.target_queue,
      priority: r.priority,
      active: r.active,
      ...conditionsToForm(r.conditions),
    })
    setEditRule(r)
  }

  async function handleCreate() {
    if (!form.name.trim()) { toast.error('Rule name is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/helpdesk/routing-rules', {
        name: form.name.trim(),
        conditions: formToConditions(form),
        target_queue: form.target_queue,
        priority: form.priority,
        active: form.active,
      })
      toast.success('Rule created')
      setNewOpen(false)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdate() {
    if (!editRule) return
    if (!form.name.trim()) { toast.error('Rule name is required'); return }
    setSaving(true)
    try {
      await apiPut(`/api/helpdesk/routing-rules/${editRule.id}`, {
        name: form.name.trim(),
        conditions: formToConditions(form),
        target_queue: form.target_queue,
        priority: form.priority,
        active: form.active,
      })
      toast.success('Rule updated')
      setEditRule(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteRule) return
    setDeleting(true)
    try {
      await apiFetch(`/api/helpdesk/routing-rules/${deleteRule.id}`, { method: 'DELETE' })
      toast.success('Rule deleted')
      setDeleteRule(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setDeleting(false)
    }
  }

  async function handleToggleActive(rule: RoutingRule) {
    try {
      await apiPut(`/api/helpdesk/routing-rules/${rule.id}`, { active: !rule.active })
      toast.success(rule.active ? 'Rule disabled' : 'Rule enabled')
      load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  // ── Call script handlers ─────────────────────────────────────────────────────

  function openNewScript() {
    setScriptForm(EMPTY_SCRIPT_FORM)
    setEditScript(null)
    setScriptModalOpen(true)
  }

  function openEditScript(s: CallScript) {
    setEditScript(s)
    setScriptForm({ name: s.name, ticket_type: s.ticket_type, steps: s.steps.map(st => ({ prompt: st.prompt })), is_active: s.is_active })
    setScriptModalOpen(true)
  }

  async function handleSaveScript() {
    if (!scriptForm.name.trim()) { toast.error('Script name is required'); return }
    if (!scriptForm.ticket_type) { toast.error('Ticket type is required'); return }
    const steps = scriptForm.steps.map((st, i) => ({ order: i + 1, prompt: st.prompt })).filter(st => st.prompt.trim())
    if (steps.length === 0) { toast.error('Add at least one step'); return }
    setScriptSaving(true)
    try {
      const payload = { name: scriptForm.name.trim(), ticket_type: scriptForm.ticket_type, steps, is_active: scriptForm.is_active }
      if (editScript) {
        await apiPut(`/api/helpdesk/call-scripts/${editScript.id}`, payload)
        toast.success('Script updated')
      } else {
        await apiPost('/api/helpdesk/call-scripts', payload)
        toast.success('Script created')
      }
      setScriptModalOpen(false)
      loadScripts()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setScriptSaving(false)
    }
  }

  async function handleDeleteScript() {
    if (!deleteScript) return
    setScriptDeleting(true)
    try {
      await apiDelete(`/api/helpdesk/call-scripts/${deleteScript.id}`)
      toast.success('Script deleted')
      setDeleteScript(null)
      loadScripts()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setScriptDeleting(false)
    }
  }

  // ── SLA policy handlers ──────────────────────────────────────────────────────

  function startSLAEdit(policy: SLAPolicy) {
    setSlaEditing(policy.id)
    setSlaForm({ first_response_hours: policy.first_response_hours, resolution_hours: policy.resolution_hours })
  }

  async function handleSaveSLA(id: number) {
    setSlaSaving(true)
    try {
      await apiPut(`/api/helpdesk/sla-policies/${id}`, slaForm)
      toast.success('SLA policy updated')
      setSlaEditing(null)
      loadSLA()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSlaSaving(false)
    }
  }

  const modalFooter = (onSave: () => void) => (
    <div style={{ display: 'flex', gap: 8 }}>
      <button onClick={onSave} disabled={saving} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {saving && <Spinner size={13} color="#fff" />}
        Save Rule
      </button>
      <button onClick={() => { setNewOpen(false); setEditRule(null) }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
    </div>
  )

  const slaInputStyle: React.CSSProperties = {
    width: 80, height: 30, padding: '0 8px', border: '1px solid var(--input-bdr)', borderRadius: 6,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', textAlign: 'right', boxSizing: 'border-box',
  }

  const PRIORITY_ORDER = ['critical', 'high', 'normal', 'low']

  return (
    <Page
      title="Helpdesk Settings"
      subtitle="Routing rules, call scripts and SLA policies"
      actions={
        activeTab === 'routing' ? (
          <button onClick={openNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Rule
          </button>
        ) : activeTab === 'scripts' ? (
          <button onClick={openNewScript} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Script
          </button>
        ) : null
      }
    >
      <Tabs
        tabs={[
          { key: 'routing', label: 'Routing Rules' },
          { key: 'scripts', label: 'Call Scripts' },
          { key: 'sla',     label: 'SLA Policies' },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {/* ── Routing Rules tab ──────────────────────────────────────────────── */}
      {activeTab === 'routing' && (
        <>
          <ErrBanner error={error} onRetry={load} />
          <SectionCard title="Ticket Routing Rules" subtitle="Rules are evaluated in priority order (lowest number first). First matching rule wins.">
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                <Spinner size={24} />
              </div>
            ) : rules.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)', fontSize: 13 }}>
                No routing rules configured. All tickets will use default queue assignment.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, border: '1px solid var(--bdr)', borderRadius: 8, overflow: 'hidden' }}>
                {rules.map((rule, i) => (
                  <div key={rule.id} style={{
                    display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px',
                    borderBottom: i < rules.length - 1 ? '1px solid var(--bdr)' : 'none',
                    background: rule.active ? 'transparent' : 'var(--th-bg)',
                    opacity: rule.active ? 1 : 0.65,
                  }}>
                    <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: NAVY }}>
                      {rule.priority}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{rule.name}</span>
                        <span style={{ fontSize: 11.5, fontWeight: 600, padding: '1px 8px', borderRadius: 10, background: `${NAVY}12`, color: NAVY }}>→ {rule.target_queue}</span>
                        {!rule.active && <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: 'rgba(75,85,99,.12)', color: '#6B7280' }}>Inactive</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 3 }}>{conditionsSummary(rule.conditions)}</div>
                    </div>
                    <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(rule.updated_at)}</div>
                    <div style={{ flexShrink: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button onClick={() => handleToggleActive(rule)} style={{ padding: '4px 10px', borderRadius: 6, border: `1.5px solid ${rule.active ? AMBER : GREEN}40`, background: rule.active ? `${AMBER}0d` : `${GREEN}0d`, color: rule.active ? AMBER : GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                        {rule.active ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => openEdit(rule)} style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--input-bdr)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--txt2)' }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                      </button>
                      <button onClick={() => setDeleteRule(rule)} style={{ width: 28, height: 28, borderRadius: 6, border: `1.5px solid ${RED}30`, background: `${RED}08`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: RED }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}

      {/* ── Call Scripts tab ───────────────────────────────────────────────── */}
      {activeTab === 'scripts' && (
        <>
          <ErrBanner error={scriptsError} onRetry={loadScripts} />
          <SectionCard title="Call Scripts" subtitle="Scripts guide agents through calls for specific ticket types.">
            {scriptsLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>
            ) : scripts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)', fontSize: 13 }}>No call scripts configured.</div>
            ) : (
              <div style={{ border: '1px solid var(--bdr)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--th-bg)' }}>
                      {['Ticket Type', 'Script Name', 'Steps', 'Active', 'Actions'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scripts.map((s, i) => (
                      <tr key={s.id} style={{ borderTop: '1px solid var(--bdr)', background: i % 2 === 0 ? 'transparent' : 'var(--th-bg)' }}>
                        <td style={{ padding: '9px 14px', color: 'var(--txt)', fontWeight: 500 }}>{s.ticket_type}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--txt)', fontWeight: 600 }}>{s.name}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--txt2)' }}>{s.steps.length}</td>
                        <td style={{ padding: '9px 14px' }}>
                          <span style={{ fontSize: 11.5, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: s.is_active ? `${GREEN}15` : 'rgba(75,85,99,.1)', color: s.is_active ? GREEN : '#6B7280' }}>
                            {s.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td style={{ padding: '9px 14px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button onClick={() => openEditScript(s)} style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--input-bdr)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--txt2)' }}>
                              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                            </button>
                            <button onClick={() => setDeleteScript(s)} style={{ width: 28, height: 28, borderRadius: 6, border: `1.5px solid ${RED}30`, background: `${RED}08`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: RED }}>
                              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}

      {/* ── SLA Policies tab ───────────────────────────────────────────────── */}
      {activeTab === 'sla' && (
        <>
          <ErrBanner error={slaError} onRetry={loadSLA} />
          <SectionCard title="SLA Policies" subtitle="Response and resolution time targets per priority level.">
            {slaLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>
            ) : slaList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)', fontSize: 13 }}>No SLA policies found.</div>
            ) : (
              <div style={{ border: '1px solid var(--bdr)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--th-bg)' }}>
                      {['Priority', 'First Response (hrs)', 'Resolution (hrs)', 'Actions'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...slaList].sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)).map((p, i) => {
                      const isEditing = slaEditing === p.id
                      return (
                        <tr key={p.id} style={{ borderTop: '1px solid var(--bdr)', background: i % 2 === 0 ? 'transparent' : 'var(--th-bg)' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--txt)', textTransform: 'capitalize' }}>{p.priority}</td>
                          <td style={{ padding: '9px 14px' }}>
                            {isEditing ? (
                              <input type="number" min={0} value={slaForm.first_response_hours}
                                onChange={e => setSlaForm(f => ({ ...f, first_response_hours: Number(e.target.value) }))}
                                style={slaInputStyle} />
                            ) : (
                              <span style={{ color: 'var(--txt)' }}>{p.first_response_hours}h</span>
                            )}
                          </td>
                          <td style={{ padding: '9px 14px' }}>
                            {isEditing ? (
                              <input type="number" min={0} value={slaForm.resolution_hours}
                                onChange={e => setSlaForm(f => ({ ...f, resolution_hours: Number(e.target.value) }))}
                                style={slaInputStyle} />
                            ) : (
                              <span style={{ color: 'var(--txt)' }}>{p.resolution_hours}h</span>
                            )}
                          </td>
                          <td style={{ padding: '9px 14px' }}>
                            {isEditing ? (
                              <div style={{ display: 'flex', gap: 6 }}>
                                <button onClick={() => handleSaveSLA(p.id)} disabled={slaSaving}
                                  style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: NAVY, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                  {slaSaving && <Spinner size={11} color="#fff" />}
                                  Save
                                </button>
                                <button onClick={() => setSlaEditing(null)}
                                  style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12, cursor: 'pointer' }}>
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button onClick={() => startSLAEdit(p)}
                                style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--input-bdr)', background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--txt2)' }}>
                                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                              </button>
                            )}
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

      {/* New rule modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Routing Rule" width={520} footer={modalFooter(handleCreate)}>
        <RuleFormFields form={form} onChange={setForm} />
      </Modal>

      {/* Edit rule modal */}
      <Modal open={!!editRule} onClose={() => setEditRule(null)} title="Edit Routing Rule" width={520} footer={modalFooter(handleUpdate)}>
        <RuleFormFields form={form} onChange={setForm} />
      </Modal>

      {/* Delete routing rule confirm */}
      <ConfirmModal
        open={!!deleteRule}
        title="Delete Routing Rule"
        body={`Delete rule "${deleteRule?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteRule(null)}
      />

      {/* Script modal (new / edit) */}
      <Modal
        open={scriptModalOpen}
        onClose={() => { setScriptModalOpen(false); setEditScript(null) }}
        title={editScript ? 'Edit Call Script' : 'New Call Script'}
        width={540}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSaveScript} disabled={scriptSaving}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: scriptSaving ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: scriptSaving ? 0.7 : 1 }}>
              {scriptSaving && <Spinner size={13} color="#fff" />}
              Save Script
            </button>
            <button onClick={() => { setScriptModalOpen(false); setEditScript(null) }}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SORA }}>
          <div>
            <label style={labelStyle}>Ticket Type *</label>
            <select value={scriptForm.ticket_type} onChange={e => setScriptForm(f => ({ ...f, ticket_type: e.target.value }))} style={{ ...inputStyle }}>
              <option value="">— Select type —</option>
              {TICKET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Script Name *</label>
            <input value={scriptForm.name} onChange={e => setScriptForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Card Dispute Standard Script" style={inputStyle} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" id="script-active" checked={scriptForm.is_active} onChange={e => setScriptForm(f => ({ ...f, is_active: e.target.checked }))} style={{ width: 15, height: 15, cursor: 'pointer' }} />
            <label htmlFor="script-active" style={{ fontSize: 13, color: 'var(--txt)', cursor: 'pointer' }}>Script is active</label>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <label style={labelStyle}>Steps *</label>
              <button type="button" onClick={() => setScriptForm(f => ({ ...f, steps: [...f.steps, { prompt: '' }] }))}
                style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, cursor: 'pointer' }}>
                + Add Step
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {scriptForm.steps.map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: NAVY, marginTop: 7 }}>
                    {i + 1}
                  </div>
                  <input
                    value={step.prompt}
                    onChange={e => setScriptForm(f => ({ ...f, steps: f.steps.map((s, j) => j === i ? { prompt: e.target.value } : s) }))}
                    placeholder={`Step ${i + 1} prompt…`}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  {scriptForm.steps.length > 1 && (
                    <button type="button" onClick={() => setScriptForm(f => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))}
                      style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${RED}30`, background: `${RED}08`, color: RED, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 4 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete script confirm */}
      <ConfirmModal
        open={!!deleteScript}
        title="Delete Call Script"
        body={`Delete script "${deleteScript?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        loading={scriptDeleting}
        onConfirm={handleDeleteScript}
        onClose={() => setDeleteScript(null)}
      />
    </Page>
  )
}
