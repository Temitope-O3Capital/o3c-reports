import { useState, useEffect, useCallback } from 'react'
import { snake } from '../../lib/labels'
import { apiFetch } from '../../lib/api'
import { apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, Page, SectionCard, NAVY, RED } from '../../components/UI'

interface Setting { key: string; value: string; updated_at: string }

function groupSettings(rows: Setting[]): Record<string, Setting[]> {
  const groups: Record<string, Setting[]> = { other: [] }
  for (const row of rows) {
    const prefix = row.key.includes('_') ? row.key.split('_')[0] : 'other'
    if (!groups[prefix]) groups[prefix] = []
    groups[prefix].push(row)
  }
  return groups
}

function GroupCard({
  title, settings, onSave,
}: {
  title: string
  settings: Setting[]
  onSave: (key: string, value: string) => Promise<void>
}) {
  const [editing, setEditing]   = useState<string | null>(null)
  const [draft, setDraft]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [saveErr, setSaveErr]   = useState('')

  function startEdit(s: Setting) {
    setEditing(s.key)
    setDraft(s.value)
    setSaveErr('')
  }

  async function save(key: string) {
    setSaving(true); setSaveErr('')
    try {
      await onSave(key, draft)
      setEditing(null)
    } catch (e: any) {
      setSaveErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard title={snake(title) + ' Settings'}>
      <div className="divide-y divide-[var(--bdr)]">
        {settings.map(s => (
          <div key={s.key} className="px-5 py-3.5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-[color:var(--txt)]">{s.key}</p>
              <p className="text-[11px] text-[color:var(--txt2)] mt-0.5">Updated {fmtDate(s.updated_at)}</p>
            </div>
            {editing === s.key ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <input
                  type="text"
                  className="px-2.5 py-1.5 rounded-lg border border-[var(--bdr)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20 w-56"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') save(s.key); if (e.key === 'Escape') setEditing(null) }}
                  autoFocus
                />
                <button
                  className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-50"
                  style={{ background: NAVY }}
                  disabled={saving}
                  onClick={() => save(s.key)}
                >
                  {saving ? '…' : 'Save'}
                </button>
                <button
                  className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-[color:var(--txt2)] bg-black/[0.05] hover:bg-black/[0.08]"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="font-mono text-[13px] text-[color:var(--txt)] max-w-[200px] truncate">{s.value || '—'}</span>
                <button
                  className="p-1.5 rounded-lg text-[color:var(--txt2)] hover:text-[color:var(--txt)] hover:bg-[var(--chip-bg)]"
                  onClick={() => startEdit(s)}
                >
                  <span className="material-symbols-rounded text-[16px]">edit</span>
                </button>
              </div>
            )}
          </div>
        ))}
        {saveErr && (
          <div className="px-5 py-2">
            <ErrBanner msg={saveErr} />
          </div>
        )}
      </div>
    </SectionCard>
  )
}

export default function PlatformSettings() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [saved, setSaved]       = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch<Setting[]>('/api/settings/')
      setSettings(Array.isArray(res) ? res : (res as any).data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function saveSetting(key: string, value: string) {
    await apiPut(`/api/settings/${key}`, { value })
    setSettings(prev => prev.map(s => s.key === key ? { ...s, value, updated_at: new Date().toISOString() } : s))
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const groups = groupSettings(settings)

  return (
    <Page dept="Admin" title="Platform Settings">
      <ErrBanner msg={error} />

      {saved && (
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl text-[13px] font-semibold mb-5"
          style={{ background: 'rgba(5,150,105,0.07)', border: '1px solid rgba(5,150,105,0.2)', color: '#059669' }}>
          <span className="material-symbols-rounded text-[17px]">check_circle</span>
          Setting saved successfully.
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24"><Spinner size={36} /></div>
      ) : settings.length === 0 ? (
        <div className="text-center py-24 text-[color:var(--txt2)] text-[14px]">No platform settings found.</div>
      ) : (
        <div className="space-y-5">
          {Object.entries(groups)
            .filter(([, rows]) => rows.length > 0)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([group, rows]) => (
              <GroupCard key={group} title={group} settings={rows} onSave={saveSetting} />
            ))}
        </div>
      )}
    </Page>
  )
}
