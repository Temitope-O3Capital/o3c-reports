import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Modal, ConfirmModal, Spinner } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER } from '../../lib/design'
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
  const [rules, setRules] = useState<RoutingRule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [newOpen, setNewOpen] = useState(false)
  const [editRule, setEditRule] = useState<RoutingRule | null>(null)
  const [deleteRule, setDeleteRule] = useState<RoutingRule | null>(null)
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

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

  useEffect(() => { load() }, [load])

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

  const modalFooter = (onSave: () => void) => (
    <div style={{ display: 'flex', gap: 8 }}>
      <button onClick={onSave} disabled={saving} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {saving && <Spinner size={13} color="#fff" />}
        Save Rule
      </button>
      <button onClick={() => { setNewOpen(false); setEditRule(null) }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
    </div>
  )

  return (
    <Page
      title="Helpdesk Settings"
      subtitle="Routing rules — configure how incoming tickets are assigned to queues"
      actions={
        <button onClick={openNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Rule
        </button>
      }
    >
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
                {/* Priority badge */}
                <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: NAVY }}>
                  {rule.priority}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{rule.name}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, padding: '1px 8px', borderRadius: 10, background: `${NAVY}12`, color: NAVY }}>→ {rule.target_queue}</span>
                    {!rule.active && <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: 'rgba(75,85,99,.12)', color: '#6B7280' }}>Inactive</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 3 }}>{conditionsSummary(rule.conditions)}</div>
                </div>

                {/* Last updated */}
                <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(rule.updated_at)}</div>

                {/* Actions */}
                <div style={{ flexShrink: 0, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button onClick={() => handleToggleActive(rule)} title={rule.active ? 'Disable rule' : 'Enable rule'} style={{
                    padding: '4px 10px', borderRadius: 6, border: `1.5px solid ${rule.active ? AMBER : GREEN}40`,
                    background: rule.active ? `${AMBER}0d` : `${GREEN}0d`,
                    color: rule.active ? AMBER : GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                  }}>
                    {rule.active ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => openEdit(rule)} title="Edit rule" style={{ width: 28, height: 28, borderRadius: 6, border: '1.5px solid var(--input-bdr)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--txt2)' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                  </button>
                  <button onClick={() => setDeleteRule(rule)} title="Delete rule" style={{ width: 28, height: 28, borderRadius: 6, border: `1.5px solid ${RED}30`, background: `${RED}08`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: RED }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* New rule modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Routing Rule" width={520} footer={modalFooter(handleCreate)}>
        <RuleFormFields form={form} onChange={setForm} />
      </Modal>

      {/* Edit rule modal */}
      <Modal open={!!editRule} onClose={() => setEditRule(null)} title="Edit Routing Rule" width={520} footer={modalFooter(handleUpdate)}>
        <RuleFormFields form={form} onChange={setForm} />
      </Modal>

      {/* Delete confirm */}
      <ConfirmModal
        open={!!deleteRule}
        title="Delete Routing Rule"
        body={`Delete rule "${deleteRule?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteRule(null)}
      />
    </Page>
  )
}
