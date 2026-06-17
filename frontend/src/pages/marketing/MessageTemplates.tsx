import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Page, ErrBanner, NAVY } from '../../components/UI'
import { toast } from 'sonner'
import EmailBlockEditor, { exportToHtml, EmailBlock } from '../../components/EmailBlockEditor'

interface Template {
  id: number
  name: string
  channel: string
  subject?: string
  body: string
  email_blocks?: EmailBlock[]
  variables: string[]
  created_at: string
  updated_at: string
}

interface TemplateForm {
  name: string
  channel: string
  subject: string
  body: string
  email_blocks: EmailBlock[]
  variables: string   // comma-separated raw input
}

const EMPTY_FORM: TemplateForm = {
  name: '', channel: 'sms', subject: '', body: '', email_blocks: [], variables: '',
}

/* ── Starter templates (built-in) ──────────────────────────────────── */
interface StarterTemplate {
  name: string
  channel: string
  subject?: string
  body: string
  variables: string[]
  tag: string
  tagColor: string
}

const STARTERS: StarterTemplate[] = [
  {
    name: 'Payment Reminder',
    channel: 'sms',
    body: 'Dear {{first_name}}, your O3C Card repayment of ₦{{amount}} is due on {{date}}. Please pay to avoid late fees. Dial *901# or visit o3ccards.com. Reply STOP to opt out.',
    variables: ['first_name', 'amount', 'date'],
    tag: 'Collections',
    tagColor: '#C00000',
  },
  {
    name: 'Welcome Message',
    channel: 'sms',
    body: 'Welcome to O3C Cards, {{first_name}}! Your account {{account_no}} is now active. Download the app or visit o3ccards.com to get started. We\'re excited to have you!',
    variables: ['first_name', 'account_no'],
    tag: 'Onboarding',
    tagColor: '#059669',
  },
  {
    name: 'Overdue Notice',
    channel: 'sms',
    body: 'URGENT: Your O3C account {{account_no}} has an overdue balance of ₦{{amount}}. Ignoring this may affect your credit rating. Call 01-XXXXXXX or pay now at o3ccards.com.',
    variables: ['account_no', 'amount'],
    tag: 'Recovery',
    tagColor: '#D97706',
  },
  {
    name: 'Card Activation Prompt',
    channel: 'sms',
    body: 'Hi {{first_name}}, your O3C Card has not been activated yet. Activate now by logging into o3ccards.com or calling 01-XXXXXXX. Don\'t miss out on your card benefits!',
    variables: ['first_name'],
    tag: 'Activation',
    tagColor: '#2563EB',
  },
  {
    name: 'Re-engagement',
    channel: 'sms',
    body: 'Hi {{first_name}}, we noticed you haven\'t used your O3C Card recently. Come back and enjoy exclusive offers! Visit o3ccards.com or call us. Reply STOP to opt out.',
    variables: ['first_name'],
    tag: 'Marketing',
    tagColor: '#7C3AED',
  },
  {
    name: 'Monthly Statement Ready',
    channel: 'email',
    subject: 'Your O3C Statement for {{month}} is ready',
    body: 'Dear {{first_name}},\n\nYour monthly account statement for {{month}} is now available.\n\nAccount: {{account_no}}\nTotal Spend: ₦{{amount}}\nAvailable Balance: ₦{{balance}}\n\nLog in to view and download your full statement.\n\nBest regards,\nO3C Cards Team',
    variables: ['first_name', 'month', 'account_no', 'amount', 'balance'],
    tag: 'Statements',
    tagColor: '#0E2841',
  },
]

const CHANNEL_STYLES: Record<string, { bg: string; color: string; icon: string }> = {
  sms:   { bg: 'rgba(14,40,65,0.08)',     color: '#0E2841',  icon: 'sms' },
  email: { bg: 'rgba(37,99,235,0.09)',    color: '#1D4ED8',  icon: 'mail' },
  push:  { bg: 'rgba(124,58,237,0.09)',   color: '#7C3AED',  icon: 'notifications' },
}

function channelStyle(channel: string) {
  return CHANNEL_STYLES[channel.toLowerCase()] ?? { bg: 'rgba(14,40,65,0.06)', color: '#475569', icon: 'send' }
}

/* ── Shared modal ──────────────────────────────────────────────────── */
function Modal({
  title, onClose, children, wide = false,
}: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.4)', paddingTop: wide ? 0 : 48 }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-white shadow-2xl w-full overflow-hidden flex flex-col"
        style={{
          maxWidth: wide ? 960 : 520,
          maxHeight: wide ? '100vh' : '88vh',
          borderRadius: wide ? 0 : 16,
          marginTop: wide ? 0 : undefined,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-6 py-4 border-b shrink-0"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}
        >
          <h3 className="text-[15px] font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100">
            <span className="material-symbols-rounded text-[20px] text-slate-400">close</span>
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  )
}

/* ── Starter template card ──────────────────────────────────────────── */
function StarterCard({ s, onUse }: { s: StarterTemplate; onUse: (s: StarterTemplate) => void }) {
  const cs = channelStyle(s.channel)
  return (
    <div className="card p-4 flex flex-col gap-2.5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between gap-2">
        <span
          className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full"
          style={{ background: `${s.tagColor}14`, color: s.tagColor }}
        >
          {s.tag}
        </span>
        <span
          className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded"
          style={{ background: cs.bg, color: cs.color }}
        >
          <span className="material-symbols-rounded text-[11px]">{cs.icon}</span>
          {s.channel.toUpperCase()}
        </span>
      </div>
      <p className="text-[13px] font-semibold text-slate-800">{s.name}</p>
      <p
        className="text-[11px] text-slate-500 leading-relaxed"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {s.body}
      </p>
      <div className="flex flex-wrap gap-1">
        {s.variables.map(v => (
          <span key={v} className="text-[10px] font-mono px-1 py-0.5 rounded"
            style={{ background: 'rgba(14,40,65,0.06)', color: '#475569' }}>
            {`{{${v}}}`}
          </span>
        ))}
      </div>
      <button
        onClick={() => onUse(s)}
        className="mt-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-all"
        style={{ background: NAVY }}
      >
        <span className="material-symbols-rounded text-[13px]">content_copy</span>
        Use Template
      </button>
    </div>
  )
}

/* ── Field wrapper ─────────────────────────────────────────────────── */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-semibold text-slate-600 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-slate-400 transition-colors'
const INPUT_STYLE = { borderColor: 'rgba(15,23,42,0.15)' }

/* ── Template card ─────────────────────────────────────────────────── */
function TemplateCard({
  t,
  onEdit,
  onDelete,
}: {
  t: Template
  onEdit: (t: Template) => void
  onDelete: (t: Template) => void
}) {
  const cs = channelStyle(t.channel)
  return (
    <div className="card p-5 flex flex-col gap-3">
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
          style={{ background: cs.bg, color: cs.color }}
        >
          <span className="material-symbols-rounded text-[12px]">{cs.icon}</span>
          {t.channel.toUpperCase()}
        </span>
        <span className="text-[11px] text-slate-400">{fmtDate(t.updated_at)}</span>
      </div>

      {/* name */}
      <p className="text-[14px] font-semibold text-slate-800 leading-snug">{t.name}</p>

      {/* subject */}
      {t.subject && (
        <p className="text-[12px] italic text-slate-400 -mt-1">{t.subject}</p>
      )}

      {/* body preview */}
      <p
        className="text-[12px] text-slate-500 leading-relaxed"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {t.body}
      </p>

      {/* variables */}
      {t.variables.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {t.variables.map(v => (
            <span
              key={v}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(14,40,65,0.06)', color: '#475569' }}
            >
              {'{{'}{v}{'}}'}
            </span>
          ))}
        </div>
      )}

      {/* footer actions */}
      <div
        className="flex items-center gap-2 pt-2 border-t"
        style={{ borderColor: 'rgba(15,23,42,0.07)' }}
      >
        <button
          onClick={() => onEdit(t)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors hover:bg-slate-50"
          style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#334155' }}
        >
          <span className="material-symbols-rounded text-[14px]">edit</span>
          Edit
        </button>
        <button
          onClick={() => onDelete(t)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors hover:bg-red-50"
          style={{ borderColor: 'rgba(192,0,0,0.2)', color: '#C00000' }}
        >
          <span className="material-symbols-rounded text-[14px]">delete</span>
          Delete
        </button>
      </div>
    </div>
  )
}

/* ── Starter section (collapsible) ────────────────────────────────── */
function StarterSection({ starters, onUse }: { starters: StarterTemplate[]; onUse: (s: StarterTemplate) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-[12px] font-semibold text-slate-500 hover:text-slate-700 transition-colors mb-3"
      >
        <span className="material-symbols-rounded text-[16px]">{open ? 'expand_less' : 'expand_more'}</span>
        Starter Templates
        <span className="text-[11px] font-normal text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
          {starters.length} built-in — duplicate & customise
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
          {starters.map(s => (
            <StarterCard key={s.name} s={s} onUse={onUse} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Main page ─────────────────────────────────────────────────────── */
export default function MessageTemplates() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [channelFilter, setChannelFilter] = useState('all')

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null)
  const [editing, setEditing]     = useState<Template | null>(null)
  const [form, setForm]           = useState<TemplateForm>(EMPTY_FORM)
  const [saving, setSaving]       = useState(false)

  const [confirmDelete, setConfirmDelete] = useState<Template | null>(null)
  const [deleting, setDeleting]           = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch('/api/message-templates')
      setTemplates(res.data ?? res ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openCreate() {
    setForm(EMPTY_FORM)
    setEditing(null)
    setModalMode('create')
  }

  function useStarter(s: StarterTemplate) {
    setForm({
      name: s.name,
      channel: s.channel,
      subject: s.subject ?? '',
      body: s.body,
      email_blocks: [],
      variables: s.variables.join(', '),
    })
    setEditing(null)
    setModalMode('create')
  }

  function openEdit(t: Template) {
    setForm({
      name: t.name,
      channel: t.channel,
      subject: t.subject ?? '',
      body: t.body,
      email_blocks: t.email_blocks || [],
      variables: t.variables.join(', '),
    })
    setEditing(t)
    setModalMode('edit')
  }

  function closeModal() {
    setModalMode(null)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  function parseVars(raw: string): string[] {
    return raw.split(',').map(v => v.trim()).filter(Boolean)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const payload = {
      name: form.name,
      channel: form.channel,
      subject: form.channel === 'email' ? form.subject : undefined,
      body: form.channel === 'email' ? exportToHtml(form.email_blocks) : form.body,
      email_blocks: form.channel === 'email' ? form.email_blocks : undefined,
      variables: parseVars(form.variables),
    }
    try {
      if (modalMode === 'create') {
        await apiFetch('/api/message-templates', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        toast.success('Template created')
      } else if (editing) {
        await apiFetch(`/api/message-templates/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        })
        toast.success('Template updated')
      }
      closeModal()
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      await apiFetch(`/api/message-templates/${confirmDelete.id}`, { method: 'DELETE' })
      toast.success('Template deleted')
      setConfirmDelete(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setDeleting(false)
    }
  }

  const filtered = channelFilter === 'all'
    ? templates
    : templates.filter(t => t.channel.toLowerCase() === channelFilter)

  const tabs: { key: string; label: string }[] = [
    { key: 'all',   label: 'All' },
    { key: 'sms',   label: 'SMS' },
    { key: 'email', label: 'Email' },
    { key: 'push',  label: 'Push' },
  ]

  return (
    <Page
      dept="Marketing"
      title="Message Templates"
      subtitle="Reusable templates for SMS, email, and push notifications"
      actions={
        <button
          onClick={openCreate}
          style={{ background: NAVY }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
        >
          <span className="material-symbols-rounded text-[15px]">add</span>
          New Template
        </button>
      }
    >
      <ErrBanner msg={error} />

      {/* Channel filter tabs */}
      <div
        className="flex items-center gap-1 mb-5 p-1 rounded-xl w-fit"
        style={{ background: 'rgba(14,40,65,0.05)' }}
      >
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setChannelFilter(tab.key)}
            className="px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all"
            style={
              channelFilter === tab.key
                ? { background: '#fff', color: NAVY, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }
                : { color: '#64748B' }
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Starter templates ── */}
      {templates.length === 0 && !loading && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <p className="text-[13px] font-semibold text-slate-700">Starter Templates</p>
            <span className="text-[11px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Duplicate & customise</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {STARTERS.map(s => (
              <StarterCard key={s.name} s={s} onUse={useStarter} />
            ))}
          </div>
          <div className="mt-4 border-t pt-5" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
            <p className="text-[12px] text-slate-500 mb-3">Your saved templates will appear below.</p>
          </div>
        </div>
      )}

      {/* When there are saved templates, show starters in a collapsible */}
      {templates.length > 0 && (
        <StarterSection starters={STARTERS} onUse={useStarter} />
      )}

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card p-5 space-y-3">
              <div className="flex justify-between">
                <div className="h-5 w-16 skeleton rounded-full" />
                <div className="h-4 w-20 skeleton rounded" />
              </div>
              <div className="h-4 w-2/3 skeleton rounded" />
              <div className="h-3 w-full skeleton rounded" />
              <div className="h-3 w-4/5 skeleton rounded" />
              <div className="flex gap-1.5">
                <div className="h-4 w-14 skeleton rounded" />
                <div className="h-4 w-14 skeleton rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center">
          <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">description</span>
          <p className="text-[13px] text-slate-400">No templates found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(t => (
            <TemplateCard
              key={t.id}
              t={t}
              onEdit={openEdit}
              onDelete={setConfirmDelete}
            />
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      {modalMode && (
        <Modal
          title={modalMode === 'create' ? 'New Template' : 'Edit Template'}
          onClose={closeModal}
          wide={form.channel === 'email'}
        >
          <form onSubmit={handleSave} className="space-y-4">
            <Field label="Name">
              <input
                required
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Repayment Reminder"
                className={INPUT_CLS}
                style={INPUT_STYLE}
              />
            </Field>

            <Field label="Channel">
              <select
                value={form.channel}
                onChange={e => setForm(f => ({ ...f, channel: e.target.value }))}
                className={INPUT_CLS}
                style={INPUT_STYLE}
              >
                <option value="sms">SMS</option>
                <option value="email">Email</option>
                <option value="push">Push Notification</option>
              </select>
            </Field>

            {form.channel === 'email' && (
              <Field label="Subject">
                <input
                  value={form.subject}
                  onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                  placeholder="e.g. Your repayment is due"
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                />
              </Field>
            )}

            {form.channel === 'email' ? (
              <Field label="Email Body">
                <div style={{ height: 'calc(100vh - 260px)', minHeight: 400 }}>
                  <EmailBlockEditor
                    value={{ blocks: form.email_blocks }}
                    onChange={({ blocks }) => setForm(f => ({ ...f, email_blocks: blocks }))}
                  />
                </div>
              </Field>
            ) : (
              <Field label="Body">
                <textarea
                  required
                  value={form.body}
                  onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                  placeholder="Write your message here…"
                  rows={5}
                  className={`${INPUT_CLS} resize-none`}
                  style={{ ...INPUT_STYLE, minHeight: 120 }}
                />
              </Field>
            )}

            <Field label="Variables (comma-separated)">
              <input
                value={form.variables}
                onChange={e => setForm(f => ({ ...f, variables: e.target.value }))}
                placeholder="name, amount, due_date"
                className={INPUT_CLS}
                style={INPUT_STYLE}
              />
              {form.variables.trim() && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {parseVars(form.variables).map(v => (
                    <span
                      key={v}
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(14,40,65,0.07)', color: '#475569' }}
                    >
                      {'{{'}{v}{'}}'}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-slate-400 mt-1">
                These become {'{{variable}}'} placeholders in the template body.
              </p>
            </Field>

            <button
              type="submit"
              disabled={saving}
              className="w-full py-2.5 text-[13px] font-semibold text-white rounded-lg disabled:opacity-60 transition-opacity"
              style={{ background: NAVY }}
            >
              {saving
                ? modalMode === 'create' ? 'Creating…' : 'Saving…'
                : modalMode === 'create' ? 'Create Template' : 'Save Changes'}
            </button>
          </form>
        </Modal>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <Modal title="Delete Template" onClose={() => setConfirmDelete(null)}>
          <p className="text-[13px] text-slate-600 mb-5">
            Are you sure you want to delete <strong>{confirmDelete.name}</strong>? This cannot be undone.
          </p>
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => setConfirmDelete(null)}
              className="px-4 py-2 rounded-lg text-[13px] font-medium border transition-colors hover:bg-slate-50"
              style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#475569' }}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: '#C00000' }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Modal>
      )}
    </Page>
  )
}
