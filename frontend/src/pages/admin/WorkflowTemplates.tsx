import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Modal, ConfirmModal, btnPrimary, btnDanger } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { ROLE_LABELS, roleLabel } from '../../lib/roles'
import { GREEN, RED, AMBER, NAVY, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowTemplate {
  id: number
  name: string
  description: string
  notify_roles: string[]
  approver_roles: string[]
  poster_roles: string[]
  created_at: string
}

// ── All selectable roles (for the multi-select pickers) ───────────────────────

const SELECTABLE_ROLES = Object.entries(ROLE_LABELS)
  .filter(([key]) => !['admin', 'management', 'md', 'coo', 'cmo', 'executive'].includes(key))
  .sort((a, b) => a[1].localeCompare(b[1]))

// ── Role tag ──────────────────────────────────────────────────────────────────

function RoleTag({ role, color = NAVY }: { role: string; color?: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600,
      padding: '2px 8px', borderRadius: 6, whiteSpace: 'nowrap',
      background: `${color}10`, color,
    }}>
      {roleLabel(role)}
    </span>
  )
}

// ── Role multi-select ─────────────────────────────────────────────────────────

function RolePicker({ label, hint, value, onChange }: {
  label: string
  hint: string
  value: string[]
  onChange: (v: string[]) => void
}) {
  function toggle(role: string) {
    onChange(value.includes(role) ? value.filter(r => r !== role) : [...value, role])
  }

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>{label}</label>
      <p style={{ fontSize: 11.5, color: 'var(--txt3)', margin: '0 0 8px' }}>{hint}</p>
      <div style={{ border: '1px solid var(--input-bdr)', borderRadius: 8, overflow: 'hidden' }}>
        {/* Selected tags */}
        <div style={{ minHeight: 36, padding: '6px 8px', display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: value.length > 0 ? '1px solid var(--bdr)' : 'none', background: 'var(--input-bg)' }}>
          {value.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--txt3)', lineHeight: '24px' }}>None selected</span>}
          {value.map(r => (
            <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, padding: '2px 6px 2px 8px', borderRadius: 6, background: `${NAVY}12`, color: NAVY }}>
              {roleLabel(r)}
              <button onClick={() => toggle(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: NAVY, fontSize: 14, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center' }}>×</button>
            </span>
          ))}
        </div>
        {/* Role grid */}
        <div style={{ maxHeight: 180, overflowY: 'auto', padding: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {SELECTABLE_ROLES.map(([key, lbl]) => {
            const selected = value.includes(key)
            return (
              <button key={key} onClick={() => toggle(key)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, padding: '3px 8px', borderRadius: 6, border: `1px solid ${selected ? NAVY : 'var(--bdr)'}`, background: selected ? `${NAVY}12` : 'var(--card)', color: selected ? NAVY : 'var(--txt2)', cursor: 'pointer' }}>
                {selected && <span className="material-symbols-rounded" style={{ fontSize: 12 }}>check</span>}
                {lbl}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Template form modal ───────────────────────────────────────────────────────

interface TemplateFormProps {
  open: boolean
  editing: WorkflowTemplate | null
  onClose: () => void
  onSaved: () => void
}

function TemplateForm({ open, editing, onClose, onSaved }: TemplateFormProps) {
  const [name, setName]                   = useState('')
  const [description, setDescription]     = useState('')
  const [notifyRoles, setNotifyRoles]     = useState<string[]>([])
  const [approverRoles, setApproverRoles] = useState<string[]>([])
  const [posterRoles, setPosterRoles]     = useState<string[]>([])
  const [saving, setSaving]               = useState(false)

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '')
      setDescription(editing?.description ?? '')
      setNotifyRoles(editing?.notify_roles ?? [])
      setApproverRoles(editing?.approver_roles ?? [])
      setPosterRoles(editing?.poster_roles ?? [])
    }
  }, [open, editing])

  function handleClose() {
    onClose()
  }

  async function handleSave() {
    if (!name.trim()) { toast.error('Template name is required'); return }
    if (approverRoles.length === 0) { toast.error('At least one approver role is required'); return }
    if (posterRoles.length === 0) { toast.error('At least one poster role is required'); return }

    setSaving(true)
    const body = { name: name.trim(), description: description.trim(), notify_roles: notifyRoles, approver_roles: approverRoles, poster_roles: posterRoles }
    try {
      if (editing) {
        await apiPut(`/api/admin/workflow-templates/${editing.id}`, body)
        toast.success('Template updated')
      } else {
        await apiPost('/api/admin/workflow-templates', body)
        toast.success('Template created')
      }
      onSaved()
      onClose()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box',
    border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13,
    background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none',
  }

  return (
    <Modal open={open} onClose={handleClose} title={editing ? 'Edit Workflow Template' : 'New Workflow Template'} width={580}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={handleClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Template Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. NIP Correction" style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Description</label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={description} onChange={e => setDescription(e.target.value)} placeholder="When is this template used?" rows={2}
            style={{ ...inputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical', fontFamily: "'Sora', sans-serif" }} />
        </div>

        <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--th-bg)', display: 'flex', gap: 10, fontSize: 12, color: 'var(--txt2)', alignItems: 'flex-start' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15, color: NAVY, marginTop: 1, flexShrink: 0 }}>info</span>
          <span><strong style={{ color: 'var(--txt)' }}>Flow:</strong> Settlement officer raises posting → <strong style={{ color: 'var(--txt)' }}>Approver</strong> approves or rejects → <strong style={{ color: 'var(--txt)' }}>Poster</strong> posts to ledger or returns for revision</span>
        </div>

        <RolePicker label="Notify on creation" hint="These roles receive a notification when a new posting is raised under this template."
          value={notifyRoles} onChange={setNotifyRoles} />
        <RolePicker label="Approver roles *" hint="Roles that can approve or reject the posting. Any one approver is sufficient."
          value={approverRoles} onChange={setApproverRoles} />
        <RolePicker label="Poster roles *" hint="Roles that can execute the posting to the ledger after approval, or return it."
          value={posterRoles} onChange={setPosterRoles} />
      </div>
    </Modal>
  )
}

// ── Stage badge ───────────────────────────────────────────────────────────────

function StageDots({ stage }: { stage: string }) {
  const stages = [
    { key: 'pending_approval', label: 'Approval' },
    { key: 'approved',         label: 'Posting' },
    { key: 'posted',           label: 'Done' },
  ]
  const rejected = stage === 'rejected' || stage === 'returned'
  const currentIdx = stages.findIndex(s => s.key === stage)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {stages.map((s, i) => {
        const done    = !rejected && i < currentIdx
        const active  = !rejected && i === currentIdx
        const color   = rejected && i === currentIdx ? RED : done ? GREEN : active ? NAVY : 'var(--bdr)'
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, transition: 'background 200ms' }} />
            {i < stages.length - 1 && <div style={{ width: 16, height: 1, background: done ? GREEN : 'var(--bdr)' }} />}
          </div>
        )
      })}
    </div>
  )
}

// ── Template card ─────────────────────────────────────────────────────────────

function TemplateCard({ t, onEdit, onDelete }: { t: WorkflowTemplate; onEdit: () => void; onDelete: () => void }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt)', margin: '0 0 3px' }}>{t.name}</p>
          {t.description && <p style={{ fontSize: 12.5, color: 'var(--txt2)', margin: 0 }}>{t.description}</p>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onEdit} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
          <button onClick={onDelete} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(192,0,0,0.08)', color: RED, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
        </div>
      </div>

      {/* Flow visualization */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, marginTop: 12 }}>
        {[
          { label: 'Notify', roles: t.notify_roles, color: AMBER, icon: 'notifications' },
          { label: 'Approve', roles: t.approver_roles, color: NAVY, icon: 'thumb_up' },
          { label: 'Post', roles: t.poster_roles, color: GREEN, icon: 'done_all' },
        ].map((step, i) => (
          <div key={step.label} style={{ display: 'flex', alignItems: 'center', flex: 1, gap: 0 }}>
            <div style={{ flex: 1, padding: '8px 10px', borderRadius: i === 0 ? '8px 0 0 8px' : i === 2 ? '0 8px 8px 0' : 0, background: `${step.color}09`, border: `1px solid ${step.color}22`, borderRight: i < 2 ? 'none' : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13, color: step.color }}>{step.icon}</span>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: step.color }}>{step.label}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {step.roles.length === 0
                  ? <span style={{ fontSize: 11.5, color: 'var(--txt3)', fontStyle: 'italic' }}>none</span>
                  : step.roles.map(r => <RoleTag key={r} role={r} color={step.color} />)
                }
              </div>
            </div>
            {i < 2 && <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)', flexShrink: 0 }}>chevron_right</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WorkflowTemplates() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [formOpen, setFormOpen]   = useState(false)
  const [editing, setEditing]     = useState<WorkflowTemplate | null>(null)
  const [deleting, setDeleting]   = useState<WorkflowTemplate | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch<WorkflowTemplate[]>('/api/admin/workflow-templates')
      setTemplates(res ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDelete() {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await apiDelete(`/api/admin/workflow-templates/${deleting.id}`)
      toast.success('Template deleted')
      setDeleting(null)
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  return (
    <Page
      title="Workflow Templates"
      subtitle="Configure approval chains for manual postings — who gets notified, who approves, who posts"
      actions={
        <button onClick={() => { setEditing(null); setFormOpen(true) }} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Template
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Info banner */}
      <div style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 10, background: `${NAVY}06`, border: `1px solid ${NAVY}14`, marginBottom: 20 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY, flexShrink: 0, marginTop: 1 }}>schema</span>
        <div>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', margin: '0 0 3px' }}>Three-stage approval flow</p>
          <p style={{ fontSize: 12.5, color: 'var(--txt2)', margin: 0 }}>
            When a settlement officer raises a manual posting, they pick a template. The template determines:
            <strong style={{ color: 'var(--txt)' }}> who gets notified</strong>,
            <strong style={{ color: 'var(--txt)' }}> who must approve</strong>, and
            <strong style={{ color: 'var(--txt)' }}> who executes the posting</strong> to the ledger.
          </p>
        </div>
      </div>

      <SectionCard padding={false}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>Loading templates…</div>
        ) : templates.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 40, color: 'var(--txt3)', display: 'block', marginBottom: 10 }}>schema</span>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', margin: '0 0 4px' }}>No workflow templates yet</p>
            <p style={{ fontSize: 13, color: 'var(--txt2)', margin: '0 0 16px' }}>Create your first template to define an approval chain for manual postings.</p>
            <button onClick={() => { setEditing(null); setFormOpen(true) }} style={btnPrimary}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
              New Template
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
            {templates.map(t => (
              <TemplateCard key={t.id} t={t}
                onEdit={() => { setEditing(t); setFormOpen(true) }}
                onDelete={() => setDeleting(t)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      <TemplateForm
        open={formOpen}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={load}
      />

      <ConfirmModal
        open={deleting !== null}
        title="Delete Template"
        body={`Delete "${deleting?.name}"? Any postings already using this template will keep their existing approval chain.`}
        confirmLabel="Delete"
        danger
        loading={deleteLoading}
        onConfirm={handleDelete}
        onClose={() => setDeleting(null)}
      />
    </Page>
  )
}

// Re-export the stage dots for use in ManualPostings
export { StageDots }
