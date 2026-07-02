import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, ErrBanner, NAVY } from '../../components/UI'
import { toast } from 'sonner'

const RED = '#C00000'

const PURPOSE_LABELS: Record<string, string> = {
  promo:         'Promotions',
  internal:      'Internal / Staff',
  helpdesk:      'Customer Support',
  transactional: 'Transactional',
  general:       'General',
}
const PURPOSES = Object.keys(PURPOSE_LABELS)

interface Sender {
  id:         number
  address:    string
  name:       string
  label:      string
  purpose:    string
  is_default: boolean
  is_active:  boolean
}

function SenderModal({
  sender, onClose, onSave,
}: {
  sender: Partial<Sender> | null
  onClose: () => void
  onSave:  () => void
}) {
  const isEdit = !!sender?.id
  const [address,   setAddress]   = useState(sender?.address ?? '')
  const [name,      setName]      = useState(sender?.name ?? '')
  const [label,     setLabel]     = useState(sender?.label ?? '')
  const [purpose,   setPurpose]   = useState(sender?.purpose ?? 'general')
  const [isDefault, setIsDefault] = useState(sender?.is_default ?? false)
  const [saving,    setSaving]    = useState(false)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!address.includes('@')) { toast.error('Enter a valid email address'); return }
    setSaving(true)
    try {
      if (isEdit) {
        await apiFetch(`/api/admin/email-senders/${sender!.id}`, {
          method: 'PUT',
          body: JSON.stringify({ address, name, label, purpose, is_default: isDefault }),
        })
      } else {
        await apiFetch('/api/admin/email-senders', {
          method: 'POST',
          body: JSON.stringify({ address, name, label, purpose, is_default: isDefault }),
        })
      }
      toast.success(isEdit ? 'Sender updated' : 'Sender added')
      onSave(); onClose()
    } catch (err: any) {
      toast.error(err.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: '100%', maxWidth: 460,
        boxShadow: '0 20px 60px rgba(0,0,0,.18)' }}>
        <h3 className="text-[15px] font-bold mb-5" style={{ color: 'var(--txt)' }}>
          {isEdit ? 'Edit Sender' : 'Add Sender'}
        </h3>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: 'var(--txt2)' }}>
              Email Address <span className="text-red-500">*</span>
            </label>
            <input type="email" required value={address} onChange={e => setAddress(e.target.value)}
              placeholder="promo@o3cards.com"
              className="w-full rounded-lg border px-3 py-2.5 text-[13px] outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
            <p className="text-[11px] mt-1" style={{ color: 'var(--txt2)' }}>Must be on an authenticated domain (e.g. @o3cards.com)</p>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: 'var(--txt2)' }}>
              Display Name <span className="text-red-500">*</span>
            </label>
            <input type="text" required value={name} onChange={e => setName(e.target.value)}
              placeholder="O3 Capital Offers"
              className="w-full rounded-lg border px-3 py-2.5 text-[13px] outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
            <p className="text-[11px] mt-1" style={{ color: 'var(--txt2)' }}>What recipients see in their inbox as the sender name</p>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: 'var(--txt2)' }}>
              Label <span className="text-red-500">*</span>
            </label>
            <input type="text" required value={label} onChange={e => setLabel(e.target.value)}
              placeholder="Promotions Team"
              className="w-full rounded-lg border px-3 py-2.5 text-[13px] outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
            <p className="text-[11px] mt-1" style={{ color: 'var(--txt2)' }}>Internal label shown in dropdowns</p>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide mb-1.5" style={{ color: 'var(--txt2)' }}>
              Purpose
            </label>
            <select value={purpose} onChange={e => setPurpose(e.target.value)}
              className="w-full rounded-lg border px-3 py-2.5 text-[13px] outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}>
              {PURPOSES.map(p => (
                <option key={p} value={p}>{PURPOSE_LABELS[p]}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)}
              className="w-4 h-4 rounded" />
            <span className="text-[13px]" style={{ color: 'var(--txt)' }}>
              Set as default for <strong>{PURPOSE_LABELS[purpose]}</strong> emails
            </span>
          </label>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 rounded-lg text-[13px] font-semibold border"
              style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : isEdit ? 'Update' : 'Add Sender'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function EmailSenders() {
  const [senders, setSenders] = useState<Sender[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [modal,   setModal]   = useState<Partial<Sender> | null | 'new'>('new' as any)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const data = await apiFetch('/api/admin/email-senders')
      setSenders((data ?? []) as Sender[])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  // reset modal to null after initial load
  useEffect(() => { setModal(null) }, [])

  async function handleSetDefault(s: Sender) {
    await apiFetch(`/api/admin/email-senders/${s.id}/set-default`, { method: 'POST' })
    toast.success(`${s.label} set as default for ${PURPOSE_LABELS[s.purpose]}`)
    load()
  }

  async function handleDelete(s: Sender) {
    await apiFetch(`/api/admin/email-senders/${s.id}`, { method: 'DELETE' })
    toast.success('Sender removed')
    load()
  }

  const grouped = PURPOSES.map(p => ({
    purpose: p,
    label:   PURPOSE_LABELS[p],
    items:   senders.filter(s => s.purpose === p && s.is_active),
  })).filter(g => g.items.length > 0)

  return (
    <Page dept="Admin" title="Email Senders"
      subtitle="Configure sender identities for each email type. The default is pre-selected in compose forms.">

      <ErrBanner msg={error} />

      <div className="flex justify-end mb-4">
        <button onClick={() => setModal({})}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[16px]">add</span>
          Add Sender
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-7 h-7 border-2 rounded-full animate-spin"
            style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: NAVY }} />
        </div>
      )}

      {!loading && grouped.length === 0 && !error && (
        <div className="flex flex-col items-center py-20 gap-3 text-[color:var(--txt2)]">
          <span className="material-symbols-rounded text-[48px]">alternate_email</span>
          <p className="text-[14px]">No senders configured yet. Add one above.</p>
        </div>
      )}

      {grouped.map(({ purpose, label, items }) => (
        <SectionCard key={purpose} title={label}
          subtitle={`${items.length} sender${items.length !== 1 ? 's' : ''}`}>
          <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.06)' }}>
            {items.map(s => (
              <div key={s.id}
                className="flex items-center gap-4 px-5 py-3.5 transition-colors" style={{ background: 'var(--card)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--card)')}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>{s.name}</p>
                    {s.is_default && (
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded text-white"
                        style={{ background: NAVY }}>DEFAULT</span>
                    )}
                  </div>
                  <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>{s.address}</p>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--txt2)' }}>{s.label}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!s.is_default && (
                    <button onClick={() => handleSetDefault(s)}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all"
                      style={{ borderColor: 'var(--bdr)', color: 'var(--txt2)' }}>
                      Set default
                    </button>
                  )}
                  <button onClick={() => setModal(s)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white"
                    style={{ background: NAVY }}>
                    <span className="material-symbols-rounded text-[13px]">edit</span>
                    Edit
                  </button>
                  {!s.is_default && (
                    <button onClick={() => handleDelete(s)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold border transition-all"
                      style={{ borderColor: 'rgba(192,0,0,0.2)', color: RED }}>
                      <span className="material-symbols-rounded text-[13px]">delete</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      ))}

      {modal !== null && modal !== 'new' && (
        <SenderModal
          sender={modal as Partial<Sender>}
          onClose={() => setModal(null)}
          onSave={load}
        />
      )}
    </Page>
  )
}
