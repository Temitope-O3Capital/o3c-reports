import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'

type Employer = {
  id: number
  name: string
  sector: string | null
  staff_count: number | null
  monthly_payroll_kobo: number | null
  credit_limit_kobo: number | null
  mou_status: string
  mou_date: string | null
  mou_expiry: string | null
  contact_name: string | null
  contact_phone: string | null
  contact_email: string | null
  is_active: boolean
  lead_count: number
}

const MOU_COLORS: Record<string, string> = {
  none: '#6b7280', negotiating: '#d97706', signed: '#16a34a', expired: '#dc2626',
}

const EMPTY: Partial<Employer> = {
  name: '', sector: undefined, staff_count: undefined, monthly_payroll_kobo: undefined,
  credit_limit_kobo: undefined, mou_status: 'none', mou_date: undefined, mou_expiry: undefined,
  contact_name: undefined, contact_phone: undefined, contact_email: undefined, is_active: true,
}

export default function EmployerRegister() {
  const [employers, setEmployers] = useState<Employer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [mouFilter, setMouFilter] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Partial<Employer> | null>(null)
  const [saving, setSaving] = useState(false)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = (q = search, m = mouFilter) => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '200' })
    if (q) params.set('search', q)
    if (m) params.set('mou_status', m)
    apiFetch(`/api/bd/employers?${params}`).then(r => r.json()).then(setEmployers).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (v: string) => {
    setSearch(v)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => load(v, mouFilter), 300)
  }

  const openAdd = () => { setEditing({ ...EMPTY }); setShowModal(true) }
  const openEdit = (e: Employer) => { setEditing({ ...e }); setShowModal(true) }

  const save = async () => {
    if (!editing || !editing.name) return
    setSaving(true)
    const isNew = !editing.id
    const body = { ...editing }
    if (isNew) delete body.id
    await apiFetch(isNew ? '/api/bd/employers' : `/api/bd/employers/${editing.id}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    setShowModal(false)
    load()
  }

  const field = (k: keyof Employer) => (editing?.[k] ?? '') as string
  const setField = (k: keyof Employer, v: unknown) => setEditing(prev => prev ? { ...prev, [k]: v } : null)

  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('en-GB') : '—'

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }
  const sorted = [...employers].sort((a, b) => {
    if (!sortKey) return 0
    const va = (a as any)[sortKey] ?? ''
    const vb = (b as any)[sortKey] ?? ''
    const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))
    return sortDir === 'asc' ? cmp : -cmp
  })

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>Employer Register</h1>
        <button onClick={openAdd} style={{ padding: '8px 18px', background: '#0E2841', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          + Add Employer
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <input value={search} onChange={e => onSearch(e.target.value)} placeholder="Search employer…"
          style={{ flex: 1, maxWidth: 300, padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }} />
        <select value={mouFilter} onChange={e => { setMouFilter(e.target.value); load(search, e.target.value) }}
          style={{ padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }}>
          <option value="">All MoU Status</option>
          {['none', 'negotiating', 'signed', 'expired'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'auto' }}>
        {selectedIds.size > 0 && (
          <div style={{ padding: '10px 14px', background: '#F0F4FF', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0E2841' }}>{selectedIds.size} selected</span>
            <button style={{ padding: '5px 12px', border: '1px solid var(--bdr)', borderRadius: 7, fontSize: 12, fontWeight: 600, background: '#fff', color: '#0E2841', cursor: 'pointer' }}>Export</button>
            <button onClick={() => setSelectedIds(new Set())} style={{ marginLeft: 'auto', padding: '5px 12px', border: '1px solid var(--bdr)', borderRadius: 7, fontSize: 12, background: 'transparent', color: 'var(--txt2)', cursor: 'pointer' }}>Clear</button>
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--th-bg)' }}>
            <tr>
              <th style={{ width: 40, padding: '10px 14px' }}>
                <input type="checkbox" checked={selectedIds.size === sorted.length && sorted.length > 0}
                  onChange={e => setSelectedIds(e.target.checked ? new Set(sorted.map(x => x.id)) : new Set())}
                  style={{ cursor: 'pointer' }} />
              </th>
              {([['Employer','name'],['Sector','sector'],['Staff','staff_count'],['Payroll','monthly_payroll_kobo'],['Credit Limit','credit_limit_kobo'],['MoU','mou_status'],['MoU Expiry','mou_expiry'],['Leads','lead_count'],['',null]] as [string, string|null][]).map(([h, k]) => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, color: sortKey === k ? 'var(--txt)' : 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', cursor: k ? 'pointer' : undefined }}
                  onClick={k ? () => toggleSort(k) : undefined}>
                  {h}{k && <span style={{ marginLeft: 3, color: '#C00000', opacity: sortKey === k ? 1 : 0.3 }}>{sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>No employers found.</td></tr>
            ) : sorted.map(e => (
              <tr key={e.id} style={{ borderTop: '1px solid var(--bdr)', opacity: e.is_active ? 1 : 0.5, background: selectedIds.has(e.id) ? 'var(--row-sel)' : undefined }}>
                <td style={{ padding: '10px 14px' }} onClick={ev => ev.stopPropagation()}>
                  <input type="checkbox" checked={selectedIds.has(e.id)}
                    onChange={() => setSelectedIds(s => { const n = new Set(s); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n })}
                    style={{ cursor: 'pointer' }} />
                </td>
                <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--txt)' }}>{e.name}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{e.sector ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace' }}>{e.staff_count?.toLocaleString() ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>{e.monthly_payroll_kobo ? fmtKobo(e.monthly_payroll_kobo) : '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>{e.credit_limit_kobo ? fmtKobo(e.credit_limit_kobo) : '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: (MOU_COLORS[e.mou_status] ?? '#6b7280') + '22', color: MOU_COLORS[e.mou_status] ?? '#6b7280' }}>
                    {e.mou_status}
                  </span>
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtDate(e.mou_expiry)}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace' }}>{e.lead_count}</td>
                <td style={{ padding: '10px 14px' }}>
                  <button onClick={() => openEdit(e)} style={{ padding: '4px 10px', border: '1px solid var(--bdr)', borderRadius: 6, background: 'var(--bg)', color: 'var(--txt)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, overflowY: 'auto', padding: 32 }}>
          <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: 560, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', margin: 'auto' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>{editing.id ? 'Edit Employer' : 'Add Employer'}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {([
                { k: 'name', label: 'Name *', full: true },
                { k: 'sector', label: 'Sector' },
                { k: 'staff_count', label: 'Staff Count', type: 'number' },
                { k: 'contact_name', label: 'Contact Name' },
                { k: 'contact_phone', label: 'Contact Phone' },
                { k: 'contact_email', label: 'Contact Email' },
                { k: 'mou_date', label: 'MoU Date', type: 'date' },
                { k: 'mou_expiry', label: 'MoU Expiry', type: 'date' },
              ] as const).map(f => (
                <div key={f.k} style={{ gridColumn: (f as { full?: boolean }).full ? '1/-1' : undefined }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>{f.label}</label>
                  <input
                    type={(f as { type?: string }).type ?? 'text'}
                    value={field(f.k as keyof Employer)}
                    onChange={e => setField(f.k as keyof Employer, (f as { type?: string }).type === 'number' ? Number(e.target.value) || undefined : e.target.value || undefined)}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)', boxSizing: 'border-box' }}
                  />
                </div>
              ))}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>MoU Status</label>
                <select value={field('mou_status')} onChange={e => setField('mou_status', e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)' }}>
                  {['none', 'negotiating', 'signed', 'expired'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
                <input type="checkbox" checked={editing.is_active ?? true} onChange={e => setField('is_active', e.target.checked)} id="isActive" />
                <label htmlFor="isActive" style={{ fontSize: 13, color: 'var(--txt)', cursor: 'pointer' }}>Active</label>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowModal(false)} style={{ padding: '8px 18px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--bg)', color: 'var(--txt)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={save} disabled={!editing.name || saving}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', cursor: 'pointer', fontSize: 13, opacity: !editing.name || saving ? 0.5 : 1 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
