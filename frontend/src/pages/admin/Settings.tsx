import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, SearchInput } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, NAVY, AMBER, INTER, SORA, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Setting {
  key: string
  value: string
  has_value?: boolean
  updated_at?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSensitive(key: string): boolean {
  const lk = key.toLowerCase()
  return ['secret','password','token','_key','credential','api_key'].some(p => lk.includes(p))
}

function categoryOf(key: string): string {
  if (key.startsWith('sendgrid') || key.startsWith('mail') || key.startsWith('email')) return 'Email'
  if (key.startsWith('zoho')) return 'Zoho'
  if (key.startsWith('supabase') || key.startsWith('database')) return 'Database'
  if (key.startsWith('mssql') || key.startsWith('tunnel')) return 'MSSQL'
  if (key.startsWith('jwt') || key.startsWith('secret') || key.startsWith('encryption')) return 'Security'
  if (key.startsWith('whatsapp') || key.startsWith('sms')) return 'Messaging'
  return 'General'
}


// ── Edit row ──────────────────────────────────────────────────────────────────

function SettingRow({ s, onSaved }: { s: Setting; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue]     = useState('')
  const [saving, setSaving]   = useState(false)
  const sensitive = isSensitive(s.key)

  function startEdit() {
    setValue('')
    setEditing(true)
  }

  async function save() {
    if (!value.trim()) { toast.error('Value cannot be empty'); return }
    setSaving(true)
    try {
      await apiFetch(`/api/settings/${encodeURIComponent(s.key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
      toast.success(`${s.key} updated`)
      setEditing(false)
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const displayValue = sensitive
    ? (s.has_value ? '••••••••' : <span style={{ color: 'var(--txt3)', fontStyle: 'italic' }}>not set</span>)
    : (s.value || <span style={{ color: 'var(--txt3)', fontStyle: 'italic' }}>empty</span>)

  return (
    <tr style={{ borderBottom: '1px solid var(--bdr)' }}>
      <td style={{ padding: '12px 18px', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {sensitive && <span className="material-symbols-rounded" style={{ fontSize: 14, color: AMBER }}>lock</span>}
          <span style={{ fontFamily: 'monospace', fontSize: 12.5, color: 'var(--txt)', fontWeight: 500 }}>{s.key}</span>
        </div>
      </td>
      <td style={{ padding: '12px 18px', verticalAlign: 'middle' }}>
        {editing ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              autoFocus
              type={sensitive ? 'password' : 'text'}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
              placeholder={sensitive ? 'Enter new value…' : 'Enter value…'}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 7, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA, outline: 'none' }}
            />
            <button onClick={save} disabled={saving} style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              {saving ? '…' : 'Save'}
            </button>
            <button onClick={() => setEditing(false)} style={{ padding: '5px 10px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 12, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        ) : (
          <span style={{ fontFamily: sensitive ? 'monospace' : 'inherit', fontSize: 12.5, color: 'var(--txt2)' }}>{displayValue}</span>
        )}
      </td>
      <td style={{ padding: '12px 18px', fontSize: 11.5, color: 'var(--txt3)', ...NUM, verticalAlign: 'middle' }}>
        {s.updated_at ? fmtDatetime(s.updated_at) : '—'}
      </td>
      <td style={{ padding: '12px 18px', verticalAlign: 'middle' }}>
        {!editing && (
          <button onClick={startEdit} style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 7,
            border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)',
            fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>edit</span>
            Edit
          </button>
        )}
      </td>
    </tr>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminSettings() {
  const [rows,    setRows]    = useState<Setting[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')
  const [catFilter, setCatFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Setting[]>('/api/settings')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const categories = [...new Set(rows.map(r => categoryOf(r.key)))].sort()

  const displayed = useMemo(() => {
    return rows.filter(r => {
      if (catFilter && categoryOf(r.key) !== catFilter) return false
      if (search && !r.key.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [rows, search, catFilter])

  const sensitiveCount = rows.filter(r => isSensitive(r.key)).length
  const missingCount   = rows.filter(r => isSensitive(r.key) && !r.has_value).length

  return (
    <Page back={{ label: 'Admin', to: '/admin' }} title="Settings" subtitle="Platform configuration key-value store">
      <ErrBanner error={error} onRetry={load} />

      {missingCount > 0 && (
        <div style={{ background: 'rgba(192,0,0,.07)', border: '1px solid rgba(192,0,0,.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>warning</span>
          <span style={{ fontSize: 13, color: RED, fontWeight: 600 }}>
            {missingCount} sensitive setting{missingCount !== 1 ? 's are' : ' is'} missing a value. Check API keys and secrets.
          </span>
        </div>
      )}

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Total Settings', value: rows.length, color: 'var(--txt)' },
          { label: 'Sensitive Keys',  value: sensitiveCount, color: AMBER },
          { label: 'Missing Values',  value: missingCount, color: missingCount > 0 ? RED : GREEN },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 6 }}>{label}</div>
            <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="Configuration" badge={displayed.length} padding={false}>

        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}>
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{displayed.length} settings</span>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--th-bg)' }}>
              {['Key', 'Value', 'Last Updated', ''].map(h => (
                <th key={h} style={{ padding: '10px 18px', textAlign: 'left', fontSize: 11.5, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--txt3)' }}>Loading…</td></tr>
            ) : displayed.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--txt3)', fontSize: 13 }}>No settings match</td></tr>
            ) : displayed.map(s => <SettingRow key={s.key} s={s} onSaved={load} />)}
          </tbody>
        </table>

      </SectionCard>
    </Page>
  )
}

void RED
