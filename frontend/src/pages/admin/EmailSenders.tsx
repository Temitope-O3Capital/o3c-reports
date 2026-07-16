import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { GREEN, AMBER, RED, NAVY, INTER, SORA, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Sender {
  id: string
  address: string
  name: string
  label: string
  purpose: string
  is_default: boolean
  is_active: boolean
  created_at: string
}

const PURPOSES = ['general','campaigns','helpdesk','notifications','statements']

// ── Modal ─────────────────────────────────────────────────────────────────────

function SenderModal({ sender, onClose, onSaved }: {
  sender: Partial<Sender> | null; onClose: () => void; onSaved: () => void
}) {
  const isNew = !sender?.id
  const [form, setForm] = useState({
    address:    sender?.address    ?? '',
    name:       sender?.name       ?? '',
    label:      sender?.label      ?? '',
    purpose:    sender?.purpose    ?? 'general',
    is_default: sender?.is_default ?? false,
  })
  const [saving, setSaving] = useState(false)

  function field(k: keyof typeof form, v: string | boolean) {
    setForm(f => ({ ...f, [k]: v }))
  }

  async function save() {
    if (!form.address || !form.name || !form.label) {
      toast.error('Address, name, and label are required')
      return
    }
    setSaving(true)
    try {
      if (isNew) {
        await apiFetch('/api/admin/email-senders', { method: 'POST', body: JSON.stringify(form) })
        toast.success('Sender added')
      } else {
        await apiFetch(`/api/admin/email-senders/${sender!.id}`, { method: 'PUT', body: JSON.stringify(form) })
        toast.success('Sender updated')
      }
      onSaved()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: RADIUS['2xl'], width: 480, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>{isNew ? 'Add Email Sender' : 'Edit Sender'}</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {[
            { label: 'Email Address *', key: 'address' as const, placeholder: 'sender@yourdomain.com', type: 'email' },
            { label: 'Display Name *',  key: 'name'    as const, placeholder: 'O3 Capital', type: 'text' },
            { label: 'Label *',         key: 'label'   as const, placeholder: 'Main transactional sender', type: 'text' },
          ].map(({ label, key, placeholder, type }) => (
            <div key={key}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
              <input
                type={type} value={form[key] as string} onChange={e => field(key, e.target.value)}
                placeholder={placeholder}
                style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
              />
            </div>
          ))}

          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>Purpose</div>
            <select value={form.purpose} onChange={e => field('purpose', e.target.value)}
              style={{ display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}>
              {PURPOSES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: SP[2], cursor: 'pointer', fontSize: TEXT.base }}>
            <input type="checkbox" checked={form.is_default} onChange={e => field('is_default', e.target.checked)} />
            Set as default for this purpose
          </label>
        </div>

        <div style={{ display: 'flex', gap: SP[2], marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: RADIUS.md, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}>
            {saving ? 'Saving…' : isNew ? 'Add Sender' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Columns ───────────────────────────────────────────────────────────────────

export default function AdminEmailSenders() {
  const [rows,    setRows]    = useState<Sender[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [editing, setEditing] = useState<Partial<Sender> | null | false>(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Sender[]>('/api/admin/email-senders')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function setDefault(id: string) {
    try {
      await apiFetch(`/api/admin/email-senders/${id}/set-default`, { method: 'POST' })
      toast.success('Default sender updated')
      load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  async function deleteSender(id: string, label: string) {
    if (!confirm(`Deactivate "${label}"?`)) return
    try {
      await apiFetch(`/api/admin/email-senders/${id}`, { method: 'DELETE' })
      toast.success('Sender deactivated')
      load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const COLS: TableCol<Sender>[] = [
    { key: 'address', label: 'Address',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: 'monospace' }}>{r.address}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.name}</div>
        </div>
      ),
    },
    { key: 'label', label: 'Label', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.label}</span> },
    { key: 'purpose', label: 'Purpose',
      render: r => <span style={{ fontSize: TEXT.sm, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: RADIUS.sm, padding: '2px 9px', fontWeight: FW.semibold, textTransform: 'capitalize' }}>{r.purpose}</span> },
    { key: 'is_default', label: 'Default',
      render: r => r.is_default
        ? <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: GREEN }}>✓ Default</span>
        : <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>—</span> },
    { key: 'is_active', label: 'Status',
      render: r => (
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: r.is_active ? GREEN : 'var(--txt3)' }}>
          {r.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    { key: '_actions', label: '',
      render: r => (
        <div style={{ display: 'flex', gap: SP[1] }}>
          {!r.is_default && (
            <button onClick={e => { e.stopPropagation(); setDefault(r.id) }} style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer' }}>
              Set default
            </button>
          )}
          <button onClick={e => { e.stopPropagation(); setEditing(r) }} style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: 'none', background: `${NAVY}12`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Edit</button>
          {!r.is_default && (
            <button onClick={e => { e.stopPropagation(); deleteSender(r.id, r.label) }} style={{ padding: '3px 8px', borderRadius: RADIUS.sm, border: 'none', background: 'rgba(192,0,0,.08)', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Deactivate</button>
          )}
        </div>
      ),
    },
  ]

  return (
    <Page
      back={{ label: 'Admin', to: '/admin' }}
      title="Email Senders"
      subtitle="Verified sender identities for transactional and campaign emails"
      actions={
        <button onClick={() => setEditing({})} style={{
          display: 'flex', alignItems: 'center', gap: SP[1], padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md,
          border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
          Add Sender
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Configured Senders" badge={rows.length} padding={false}>
        <DataTable cols={COLS} rows={rows} keyFn={r => r.id} loading={loading} emptyText="No email senders configured" />
      </SectionCard>

      {editing !== false && (
        <SenderModal sender={editing} onClose={() => setEditing(false)} onSaved={load} />
      )}
    </Page>
  )
}

void AMBER
