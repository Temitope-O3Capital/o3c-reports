import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, Spinner, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AMLRule {
  id: number
  name: string
  rule_type: string        // "amount_threshold" | "velocity" | "pattern"
  threshold_kobo: number
  velocity_count: number
  time_window_hours: number
  action: string           // "flag" | "block" | "escalate"
  active: boolean
  created_at: string
  updated_at: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const RULE_TYPE_LABEL: Record<string, string> = {
  amount_threshold: 'Amount Threshold',
  velocity: 'Velocity',
  pattern: 'Pattern',
}

const ACTION_STYLE: Record<string, { color: string; bg: string }> = {
  flag:     { color: AMBER, bg: `${AMBER}22` },
  block:    { color: RED,   bg: `${RED}18`   },
  escalate: { color: NAVY,  bg: `${NAVY}15`  },
}

function RuleTypeBadge({ type }: { type: string }) {
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--input-bg)', color: 'var(--txt2)', border: '1px solid var(--bdr)' }}>
      {RULE_TYPE_LABEL[type] ?? type}
    </span>
  )
}

function ActionBadge({ action }: { action: string }) {
  const s = ACTION_STYLE[action] ?? ACTION_STYLE.flag
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: s.bg, color: s.color }}>
      {action.charAt(0).toUpperCase() + action.slice(1)}
    </span>
  )
}

function thresholdDisplay(rule: AMLRule): string {
  if (rule.rule_type === 'amount_threshold') {
    return `₦${(rule.threshold_kobo / 100).toLocaleString('en-NG')}`
  }
  if (rule.rule_type === 'velocity') {
    return `${rule.velocity_count} txn / ${rule.time_window_hours}h`
  }
  return '—'
}

// ── Blank form ─────────────────────────────────────────────────────────────────

interface RuleForm {
  name: string
  rule_type: string
  threshold_ngn: string   // user types NGN, we convert to kobo on save
  velocity_count: string
  time_window_hours: string
  action: string
  active: boolean
}

const BLANK_FORM: RuleForm = {
  name: '',
  rule_type: 'amount_threshold',
  threshold_ngn: '',
  velocity_count: '',
  time_window_hours: '',
  action: 'flag',
  active: true,
}

function formFromRule(r: AMLRule): RuleForm {
  return {
    name: r.name,
    rule_type: r.rule_type,
    threshold_ngn: r.rule_type === 'amount_threshold' ? String(r.threshold_kobo / 100) : '',
    velocity_count: r.rule_type === 'velocity' ? String(r.velocity_count) : '',
    time_window_hours: r.rule_type === 'velocity' ? String(r.time_window_hours) : '',
    action: r.action,
    active: r.active,
  }
}

function formToPayload(f: RuleForm) {
  return {
    name: f.name,
    rule_type: f.rule_type,
    threshold_kobo: f.rule_type === 'amount_threshold' ? Math.round(parseFloat(f.threshold_ngn || '0') * 100) : 0,
    velocity_count: f.rule_type === 'velocity' ? parseInt(f.velocity_count || '0', 10) : 0,
    time_window_hours: f.rule_type === 'velocity' ? parseInt(f.time_window_hours || '0', 10) : 0,
    action: f.action,
    active: f.active,
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--input-bdr)',
  borderRadius: RADIUS.md,
  fontSize: TEXT.base,
  background: 'var(--input-bg)',
  color: 'var(--txt)',
  outline: 'none',
  boxSizing: 'border-box',
}

export default function AMLRules() {
  const [rules, setRules] = useState<AMLRule[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AMLRule | null>(null)
  const [form, setForm] = useState<RuleForm>(BLANK_FORM)
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<AMLRule | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<AMLRule[]>('/api/compliance/aml-rules')
      setRules(Array.isArray(data) ? data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function openNew() {
    setEditTarget(null)
    setForm(BLANK_FORM)
    setModalOpen(true)
  }

  function openEdit(rule: AMLRule) {
    setEditTarget(rule)
    setForm(formFromRule(rule))
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error('Rule name is required'); return }
    if (form.rule_type === 'amount_threshold' && !form.threshold_ngn) {
      toast.error('Threshold amount is required'); return
    }
    if (form.rule_type === 'velocity' && (!form.velocity_count || !form.time_window_hours)) {
      toast.error('Max transactions and time window are required'); return
    }
    setSaving(true)
    try {
      const payload = formToPayload(form)
      if (editTarget) {
        await apiPut(`/api/compliance/aml-rules/${editTarget.id}`, payload)
        toast.success('Rule updated')
      } else {
        await apiPost('/api/compliance/aml-rules', payload)
        toast.success('Rule created')
      }
      setModalOpen(false)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleToggleActive(rule: AMLRule) {
    try {
      await apiPut(`/api/compliance/aml-rules/${rule.id}`, { active: !rule.active })
      toast.success(rule.active ? 'Rule deactivated' : 'Rule activated')
      load()
    } catch (e: any) { toast.error(e.message) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await fetch(`/api/compliance/aml-rules/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('token') ?? ''}` },
      })
      toast.success('Rule deleted')
      setDeleteTarget(null)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setDeleting(false) }
  }

  const cols: TableCol<AMLRule>[] = [
    {
      key: 'name', label: 'Rule Name',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.name}</span>,
    },
    {
      key: 'rule_type', label: 'Type',
      render: r => <RuleTypeBadge type={r.rule_type} />,
    },
    {
      key: 'threshold_kobo', label: 'Threshold / Velocity',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{thresholdDisplay(r)}</span>,
    },
    {
      key: 'action', label: 'Action',
      render: r => <ActionBadge action={r.action} />,
    },
    {
      key: 'active', label: 'Status',
      render: r => (
        <button
          onClick={e => { e.stopPropagation(); handleToggleActive(r) }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: RADIUS.sm, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
            border: `1.5px solid ${r.active ? '#16A34A40' : 'var(--bdr)'}`,
            background: r.active ? 'rgba(22,163,74,.08)' : 'transparent',
            color: r.active ? '#16A34A' : 'var(--txt2)',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{r.active ? 'toggle_on' : 'toggle_off'}</span>
          {r.active ? 'Active' : 'Inactive'}
        </button>
      ),
    },
    {
      key: 'id', label: '',
      render: r => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={e => { e.stopPropagation(); openEdit(r) }}
            style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            Edit
          </button>
          <button
            onClick={e => { e.stopPropagation(); setDeleteTarget(r) }}
            style={{ padding: '3px 10px', borderRadius: RADIUS.sm, border: `1.5px solid ${RED}30`, background: 'transparent', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}
          >
            Delete
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page
      title="AML Rules"
      subtitle="Configure automated flagging rules for suspicious transaction patterns"
      actions={
        <button onClick={openNew} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
          New Rule
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="Rules" badge={rules.length} padding={false}>
        <DataTable<AMLRule>
          cols={cols}
          rows={rules}
          keyFn={r => r.id}
          emptyText="No AML rules configured. Create one to start monitoring transactions."
          skeletonRows={loading ? 5 : 0}
          searchKeys={['name', 'rule_type', 'action']}
          searchPlaceholder="Search rules…"
          pageSize={20}
        />
      </SectionCard>

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editTarget ? `Edit Rule — ${editTarget.name}` : 'New AML Rule'}
        width={480}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button
              onClick={() => setModalOpen(false)}
              style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              {editTarget ? 'Save Changes' : 'Create'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Name */}
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Name *</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Large Cash Deposit"
              style={inputStyle}
            />
          </div>

          {/* Rule Type */}
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Rule Type *</label>
            <select
              value={form.rule_type}
              onChange={e => setForm(f => ({ ...f, rule_type: e.target.value }))}
              style={inputStyle}
            >
              <option value="amount_threshold">Amount Threshold</option>
              <option value="velocity">Velocity</option>
              <option value="pattern">Pattern</option>
            </select>
          </div>

          {/* Amount Threshold fields */}
          {form.rule_type === 'amount_threshold' && (
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Threshold Amount (₦) *</label>
              <input
                type="number"
                min="0"
                value={form.threshold_ngn}
                onChange={e => setForm(f => ({ ...f, threshold_ngn: e.target.value }))}
                placeholder="e.g. 1000000"
                style={inputStyle}
              />
            </div>
          )}

          {/* Velocity fields */}
          {form.rule_type === 'velocity' && (
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Max Transactions *</label>
                <input
                  type="number"
                  min="1"
                  value={form.velocity_count}
                  onChange={e => setForm(f => ({ ...f, velocity_count: e.target.value }))}
                  placeholder="e.g. 10"
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Time Window (hours) *</label>
                <input
                  type="number"
                  min="1"
                  value={form.time_window_hours}
                  onChange={e => setForm(f => ({ ...f, time_window_hours: e.target.value }))}
                  placeholder="e.g. 24"
                  style={inputStyle}
                />
              </div>
            </div>
          )}

          {/* Action */}
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Action *</label>
            <select
              value={form.action}
              onChange={e => setForm(f => ({ ...f, action: e.target.value }))}
              style={inputStyle}
            >
              <option value="flag">Flag</option>
              <option value="block">Block</option>
              <option value="escalate">Escalate</option>
            </select>
          </div>

          {/* Active */}
          <label style={{ display: 'flex', alignItems: 'center', gap: SP[2], cursor: 'pointer', fontSize: TEXT.base, color: 'var(--txt)', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={e => setForm(f => ({ ...f, active: e.target.checked }))}
              style={{ width: 15, height: 15, cursor: 'pointer' }}
            />
            Active — rule fires immediately
          </label>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <ConfirmModal
        open={!!deleteTarget}
        title={`Delete rule '${deleteTarget?.name}'?`}
        body="Active rules will stop firing immediately."
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </Page>
  )
}
