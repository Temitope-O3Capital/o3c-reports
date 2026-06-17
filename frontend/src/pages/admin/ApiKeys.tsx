import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Page, SectionCard, ErrBanner, NAVY } from '../../components/UI'
import { toast } from 'sonner'

interface ApiKey {
  key_name:       string
  description:    string
  category:       string
  is_active:      boolean
  last_tested_at: string | null
  test_status:    string | null
  updated_at:     string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  messaging:  'Messaging (Email & SMS)',
  payments:   'Payments',
  telephony:  'Telephony / Call Centre',
  general:    'General',
}

const CATEGORY_ICON: Record<string, string> = {
  messaging:  'email',
  payments:   'payments',
  telephony:  'call',
  general:    'settings',
}

function TestBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-[11px] text-slate-400">Not tested</span>
  if (status === 'ok') return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
      <span className="material-symbols-rounded text-[13px]">check_circle</span> OK
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
      <span className="material-symbols-rounded text-[13px]">error</span> Failed
    </span>
  )
}

function EditModal({
  keyName, description, onClose, onSave,
}: {
  keyName:     string
  description: string
  onClose:     () => void
  onSave:      () => void
}) {
  const [value,   setValue]   = useState('')
  const [saving,  setSaving]  = useState(false)

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim()) { toast.error('Enter a value'); return }
    setSaving(true)
    try {
      await apiFetch(`/api/admin/api-keys/${encodeURIComponent(keyName)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
      toast.success('Key saved. Use the Test button to verify it.')
      onSave()
      onClose()
    } catch (err: any) {
      toast.error(err.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: '100%', maxWidth: 440,
        boxShadow: '0 20px 60px rgba(0,0,0,.18)' }}>
        <h3 className="text-[15px] font-bold text-slate-800 mb-1">Update API Key</h3>
        <p className="text-[12px] text-slate-500 mb-5">{description}</p>
        <p className="text-[11px] font-mono text-slate-400 mb-4 px-2 py-1 rounded"
          style={{ background: 'rgba(15,23,42,0.04)' }}>{keyName}</p>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
              New Value
            </label>
            <input
              type="password"
              required
              autoComplete="off"
              placeholder="Paste key value here…"
              value={value}
              onChange={e => setValue(e.target.value)}
              className="w-full rounded-lg border px-3 py-2.5 text-[13px] font-mono outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 rounded-lg text-[13px] font-semibold border"
              style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#64748b' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : 'Save Key'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ApiKeys() {
  const [keys,    setKeys]    = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [editing, setEditing] = useState<ApiKey | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch('/api/admin/api-keys')
      setKeys((res.data ?? res) as ApiKey[])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleTest(keyName: string) {
    setTesting(keyName)
    try {
      const res = await apiFetch(`/api/admin/api-keys/${encodeURIComponent(keyName)}/test`, {
        method: 'POST',
      })
      const status = (res as any).status ?? 'ok'
      if (status === 'ok' || status === 'connected') {
        toast.success(`${keyName} — connection OK`)
      } else if (status === 'test_not_implemented') {
        toast.info(`${keyName} — no automated test for this key`)
      } else {
        toast.error(`${keyName} — test failed: ${status}`)
      }
      await load()
    } catch (e: any) {
      toast.error(`Test failed: ${e.message}`)
    } finally {
      setTesting(null)
    }
  }

  const grouped = Object.entries(CATEGORY_LABELS).map(([cat, label]) => ({
    cat,
    label,
    icon:  CATEGORY_ICON[cat] ?? 'settings',
    items: keys.filter(k => k.category === cat),
  })).filter(g => g.items.length > 0)

  return (
    <Page
      dept="Admin"
      title="API Credentials"
      subtitle="Manage external service API keys — stored encrypted">

      {/* Warning banner */}
      <div className="rounded-xl p-4 mb-2 flex items-start gap-3"
        style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
        <span className="material-symbols-rounded text-[20px] text-amber-500 flex-shrink-0 mt-0.5">warning</span>
        <p className="text-[13px] text-amber-800 leading-relaxed">
          API keys are encrypted before storage. Never share them in chats or emails.
          Use the <strong>Test</strong> button after saving each key to verify it's working.
        </p>
      </div>

      <ErrBanner msg={error} />

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-7 h-7 border-2 rounded-full animate-spin"
            style={{ borderColor: 'rgba(14,40,65,0.1)', borderTopColor: NAVY }} />
        </div>
      )}

      {!loading && grouped.length === 0 && !error && (
        <div className="flex flex-col items-center py-20 gap-3 text-slate-400">
          <span className="material-symbols-rounded text-[48px]">key_off</span>
          <p className="text-[14px]">No API credentials configured yet.</p>
          <p className="text-[12px]">Run migration 012_api_credentials.sql to seed the key names.</p>
        </div>
      )}

      {grouped.map(({ cat, label, icon, items }) => (
        <SectionCard
          key={cat}
          title={label}
          subtitle={`${items.length} credential${items.length !== 1 ? 's' : ''}`}>
          <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.06)' }}>
            {items.map(key => (
              <div key={key.key_name}
                className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-50 transition-colors">
                {/* Status dot */}
                <span className="w-2 h-2 rounded-full flex-shrink-0 mt-0.5"
                  style={{ background: key.is_active ? '#22C55E' : '#94A3B8' }} />

                {/* Key info */}
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-mono font-semibold text-slate-800">{key.key_name}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{key.description}</p>
                </div>

                {/* Test status + last tested */}
                <div className="hidden sm:flex flex-col items-end gap-0.5 flex-shrink-0">
                  <TestBadge status={key.test_status} />
                  {key.last_tested_at && (
                    <span className="text-[10px] text-slate-300">
                      Tested {fmtDate(key.last_tested_at)}
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleTest(key.key_name)}
                    disabled={testing === key.key_name}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all disabled:opacity-50"
                    style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#475569' }}>
                    <span className="material-symbols-rounded text-[13px]">
                      {testing === key.key_name ? 'hourglass_empty' : 'wifi_tethering'}
                    </span>
                    {testing === key.key_name ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    onClick={() => setEditing(key)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white"
                    style={{ background: NAVY }}>
                    <span className="material-symbols-rounded text-[13px]">edit</span>
                    Set Key
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      ))}

      {editing && (
        <EditModal
          keyName={editing.key_name}
          description={editing.description}
          onClose={() => setEditing(null)}
          onSave={load}
        />
      )}
    </Page>
  )
}
