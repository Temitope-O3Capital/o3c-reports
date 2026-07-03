import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, INTER, SORA, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiKey {
  key_name: string
  description: string
  category: string
  is_active: boolean
  is_secret: boolean
  has_value: boolean
  last_tested_at?: string
  test_status?: string
  updated_at?: string
  updated_by?: string
}

// ── Status badge ──────────────────────────────────────────────────────────────

function TestBadge({ status }: { status?: string }) {
  if (!status) return <span style={{ color: 'var(--txt3)', fontSize: 12 }}>—</span>
  const c = status === 'ok' ? GREEN : RED
  return (
    <span style={{ fontSize: 11.5, fontWeight: 600, background: `${c}18`, color: c, borderRadius: 10, padding: '2px 9px' }}>
      {status === 'ok' ? '✓ OK' : `✗ ${status}`}
    </span>
  )
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({ apiKey, onClose, onSaved }: { apiKey: ApiKey; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!value.trim()) { toast.error('Value cannot be empty'); return }
    setSaving(true)
    try {
      await apiFetch(`/api/admin/api-keys/${encodeURIComponent(apiKey.key_name)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
      toast.success(`${apiKey.key_name} updated`)
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
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 480, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>Update API Key</h3>
            <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 4, fontFamily: 'monospace' }}>{apiKey.key_name}</div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
        {apiKey.description && (
          <div style={{ fontSize: 13, color: 'var(--txt2)', marginBottom: 16, background: 'var(--input-bg)', borderRadius: 8, padding: '10px 12px' }}>{apiKey.description}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14, color: AMBER }}>lock</span>
          <span style={{ fontSize: 12, color: AMBER, fontWeight: 600 }}>Value is encrypted at rest with AES-256-GCM</span>
        </div>
        <input
          autoFocus
          type="password"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save() }}
          placeholder={apiKey.has_value ? 'Enter new value to replace current…' : 'Enter value…'}
          style={{ display: 'block', width: '100%', padding: '9px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none', marginBottom: 18 }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER }}>
            {saving ? 'Saving…' : 'Save Key'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Row actions ───────────────────────────────────────────────────────────────

function RowActions({ apiKey, onEdit, onReload }: { apiKey: ApiKey; onEdit: () => void; onReload: () => void }) {
  const [testing, setTesting] = useState(false)

  async function test() {
    if (!apiKey.has_value) { toast.error('No value stored — save a value first'); return }
    setTesting(true)
    try {
      const res = await apiFetch<{ status: string; detail: string }>(
        `/api/admin/api-keys/${encodeURIComponent(apiKey.key_name)}/test`,
        { method: 'POST' }
      )
      if (res.status === 'ok') {
        toast.success(`${apiKey.key_name}: ${res.detail}`)
      } else {
        toast.error(`${apiKey.key_name}: ${res.detail}`)
      }
      onReload()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button onClick={e => { e.stopPropagation(); test() }} disabled={testing} style={{
        padding: '3px 10px', borderRadius: 6, border: '1.5px solid var(--bdr)', background: 'transparent',
        color: 'var(--txt2)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
      }}>
        {testing ? '…' : 'Test'}
      </button>
      <button onClick={e => { e.stopPropagation(); onEdit() }} style={{
        padding: '3px 10px', borderRadius: 6, border: 'none', background: `${NAVY}12`,
        color: NAVY, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
      }}>
        Edit
      </button>
    </div>
  )
}


// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminApiKeys() {
  const [rows,    setRows]    = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [editing, setEditing] = useState<ApiKey | null>(null)
  const [search,  setSearch]  = useState('')
  const [catFilter, setCatFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<ApiKey[]>('/api/admin/api-keys')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const categories = [...new Set(rows.map(r => r.category))].sort()

  const displayed = useMemo(() => {
    return rows.filter(r => {
      if (catFilter && r.category !== catFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return r.key_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)
      }
      return true
    })
  }, [rows, search, catFilter])

  const missingCount = rows.filter(r => !r.has_value).length
  const failedCount  = rows.filter(r => r.test_status && r.test_status !== 'ok').length

  const COLS: TableCol<ApiKey>[] = [
    { key: 'key_name', label: 'Key Name',
      render: r => (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {r.is_secret && <span className="material-symbols-rounded" style={{ fontSize: 14, color: AMBER }}>lock</span>}
            <span style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 600, color: 'var(--txt)' }}>{r.key_name}</span>
          </div>
          {r.description && <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 2 }}>{r.description}</div>}
        </div>
      ),
    },
    { key: 'category', label: 'Category',
      render: r => <span style={{ fontSize: 12, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: 6, padding: '2px 9px', fontWeight: 600 }}>{r.category}</span> },
    { key: 'has_value', label: 'Value',
      render: r => (
        <span style={{ fontSize: 11.5, fontWeight: 600, color: r.has_value ? GREEN : RED }}>
          {r.has_value ? '✓ Set' : '✗ Missing'}
        </span>
      ),
    },
    { key: 'test_status', label: 'Last Test', render: r => <TestBadge status={r.test_status} /> },
    { key: 'updated_at', label: 'Updated', width: 145,
      render: r => <span style={{ ...NUM, fontSize: 11.5, color: 'var(--txt3)' }}>{r.updated_at ? fmtDatetime(r.updated_at) : '—'}</span> },
    { key: '_actions', label: '',
      render: r => <RowActions apiKey={r} onEdit={() => setEditing(r)} onReload={load} /> },
  ]

  return (
    <Page back={{ label: 'Admin', to: '/admin' }} title="API Keys" subtitle="Encrypted external service credentials">
      <ErrBanner error={error} onRetry={load} />

      {(missingCount > 0 || failedCount > 0) && (
        <div style={{ background: 'rgba(192,0,0,.07)', border: '1px solid rgba(192,0,0,.2)', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>warning</span>
          <span style={{ fontSize: 13, color: RED, fontWeight: 600 }}>
            {[missingCount > 0 && `${missingCount} keys missing values`, failedCount > 0 && `${failedCount} keys failing health check`].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Total Keys',    value: rows.length,  color: 'var(--txt)' },
          { label: 'Missing Value', value: missingCount, color: missingCount > 0 ? RED : GREEN },
          { label: 'Failed Tests',  value: failedCount,  color: failedCount > 0 ? RED : GREEN },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 6 }}>{label}</div>
            <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="API Credentials" badge={displayed.length} padding={false}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}>
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{displayed.length} keys</span>
        </div>
        <DataTable cols={COLS} rows={displayed} keyFn={r => r.key_name} loading={loading} emptyText="No API keys configured" />
      </SectionCard>

      {editing && <EditModal apiKey={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </Page>
  )
}
