import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'

type Lead = {
  id: number
  title: string
  company_name: string | null
  stage: string
  potential_value_kobo: number | null
  lead_type: string | null
  contact_name: string | null
  assigned_to: number | null
  assigned_name: string | null
  employer_name: string | null
  expected_close_date: string | null
  updated_at: string
}

const STAGES = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost']
const STAGE_LABELS: Record<string, string> = {
  prospect: 'Prospect', qualified: 'Qualified', proposal: 'Proposal',
  negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
}
const STAGE_COLORS: Record<string, string> = {
  prospect: '#6b7280', qualified: '#2563eb', proposal: '#7c3aed',
  negotiation: '#d97706', won: '#16a34a', lost: '#dc2626',
}

export default function BDPipeline() {
  const nav = useNavigate()
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ title: '', stage: 'prospect', lead_type: '', company_name: '', contact_name: '', contact_phone: '' })
  const [saving, setSaving] = useState(false)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = (q = search, s = stageFilter) => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '200' })
    if (q) params.set('search', q)
    if (s) params.set('stage', s)
    apiFetch(`/api/bd/leads?${params}`).then(r => r.json()).then(setLeads).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (v: string) => {
    setSearch(v)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => load(v, stageFilter), 300)
  }

  const addLead = async () => {
    if (!form.title) return
    setSaving(true)
    await apiFetch('/api/bd/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title,
        stage: form.stage,
        lead_type: form.lead_type || undefined,
        company_name: form.company_name || undefined,
        contact_name: form.contact_name || undefined,
        contact_phone: form.contact_phone || undefined,
      }),
    })
    setSaving(false)
    setShowAdd(false)
    setForm({ title: '', stage: 'prospect', lead_type: '', company_name: '', contact_name: '', contact_phone: '' })
    load()
  }

  const moveStage = async (id: number, stage: string) => {
    await apiFetch(`/api/bd/leads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    })
    load()
  }

  const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }
  const sorted = [...leads].sort((a, b) => {
    if (!sortKey) return 0
    const va = (a as any)[sortKey] ?? ''
    const vb = (b as any)[sortKey] ?? ''
    const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))
    return sortDir === 'asc' ? cmp : -cmp
  })

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>BD Pipeline</h1>
        <button onClick={() => setShowAdd(true)} style={{ padding: '8px 18px', background: '#0E2841', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          + New Lead
        </button>
      </div>

      {/* Stage filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={() => { setStageFilter(''); load(search, '') }}
          style={{ padding: '6px 14px', borderRadius: 20, border: '1px solid var(--bdr)', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: stageFilter === '' ? '#0E2841' : 'var(--card)', color: stageFilter === '' ? '#fff' : 'var(--txt)' }}>
          All
        </button>
        {STAGES.map(s => (
          <button key={s} onClick={() => { setStageFilter(s); load(search, s) }}
            style={{ padding: '6px 14px', borderRadius: 20, border: `1px solid ${STAGE_COLORS[s]}44`, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: stageFilter === s ? STAGE_COLORS[s] : 'var(--card)', color: stageFilter === s ? '#fff' : STAGE_COLORS[s] }}>
            {STAGE_LABELS[s]}
          </button>
        ))}
      </div>

      <input value={search} onChange={e => onSearch(e.target.value)} placeholder="Search leads…"
        style={{ marginBottom: 16, width: 280, padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }} />

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
              {([['Title','title'],['Company','company_name'],['Type','lead_type'],['Value','potential_value_kobo'],['Assigned To','assigned_name'],['Stage','stage'],['Close Date','expected_close_date'],['Updated','updated_at'],['',null]] as [string, string|null][]).map(([h, k]) => (
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
              <tr><td colSpan={10} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>No leads found.</td></tr>
            ) : sorted.map(l => (
              <tr key={l.id} style={{ borderTop: '1px solid var(--bdr)', background: selectedIds.has(l.id) ? 'var(--row-sel)' : undefined }}>
                <td style={{ padding: '10px 14px' }} onClick={ev => ev.stopPropagation()}>
                  <input type="checkbox" checked={selectedIds.has(l.id)}
                    onChange={() => setSelectedIds(s => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n })}
                    style={{ cursor: 'pointer' }} />
                </td>
                <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--txt)', cursor: 'pointer' }}
                  onClick={() => nav(`/bd/leads/${l.id}`)}>{l.title}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{l.employer_name ?? l.company_name ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{l.lead_type ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap' }}>
                  {l.potential_value_kobo ? fmtKobo(l.potential_value_kobo) : '—'}
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{l.assigned_name ?? '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <select value={l.stage} onChange={e => moveStage(l.id, e.target.value)}
                    style={{ padding: '3px 8px', borderRadius: 6, border: `1px solid ${STAGE_COLORS[l.stage]}66`, fontSize: 11, fontWeight: 600, background: STAGE_COLORS[l.stage] + '18', color: STAGE_COLORS[l.stage], cursor: 'pointer' }}>
                    {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                  </select>
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
                  {l.expected_close_date ? fmtDate(l.expected_close_date) : '—'}
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtDate(l.updated_at)}</td>
                <td style={{ padding: '10px 14px' }}>
                  <button onClick={() => nav(`/bd/leads/${l.id}`)} style={{ padding: '4px 10px', border: '1px solid var(--bdr)', borderRadius: 6, background: 'var(--bg)', color: 'var(--txt)', fontSize: 11, cursor: 'pointer' }}>View</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>New BD Lead</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {([
                { k: 'title', label: 'Title *' },
                { k: 'company_name', label: 'Company' },
                { k: 'contact_name', label: 'Contact Name' },
                { k: 'contact_phone', label: 'Contact Phone' },
              ] as const).map(f => (
                <div key={f.k}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>{f.label}</label>
                  <input value={form[f.k]} onChange={e => setForm(p => ({ ...p, [f.k]: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Stage</label>
                  <select value={form.stage} onChange={e => setForm(p => ({ ...p, stage: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)' }}>
                    {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Lead Type</label>
                  <select value={form.lead_type} onChange={e => setForm(p => ({ ...p, lead_type: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)' }}>
                    <option value="">— Select —</option>
                    {['salary_advance', 'business_loan', 'card_product', 'fixed_deposit'].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: '8px 18px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--bg)', color: 'var(--txt)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={addLead} disabled={!form.title || saving}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', cursor: 'pointer', fontSize: 13, opacity: !form.title || saving ? 0.5 : 1 }}>
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
