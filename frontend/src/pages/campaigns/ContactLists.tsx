import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, Modal, ConfirmModal,
  ErrBanner, btnPrimary, btnSecondary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { GREEN, NUM, INTER } from '../../lib/design'
import { filterInputStyle } from '../../components/UI'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContactList {
  id: number
  name: string
  description?: string
  member_count?: number
  created_at: string
  created_by_name?: string
}

// ── Main component ─────────────────────────────────────────────────────────────

const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

export default function ContactLists() {
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)
  const [lists, setLists]       = useState<ContactList[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName]         = useState('')
  const [desc, setDesc]         = useState('')
  const [saving, setSaving]     = useState(false)
  const [saveErr, setSaveErr]   = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ContactList | null>(null)
  const [sel, setSel]           = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<ContactList[]>('/api/contact-lists')
      setLists(Array.isArray(res) ? res : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function create() {
    if (!name.trim()) return
    setSaving(true); setSaveErr(null)
    try {
      await apiPost('/api/contact-lists', { name: name.trim(), description: desc || undefined })
      setShowCreate(false); setName(''); setDesc(''); load()
    } catch (ex: any) { setSaveErr(ex.message) }
    finally { setSaving(false) }
  }

  async function doDelete() {
    if (!deleteTarget) return
    try {
      await apiDelete(`/api/contact-lists/${deleteTarget.id}`)
      setDeleteTarget(null); load()
    } catch (ex: any) { setErr(ex.message) }
  }

  function exportListsCsv(data: ContactList[]) {
    const header = ['Name', 'Description', 'Members', 'Created By', 'Created At']
    const lines = data.map(r => [
      `"${String(r.name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.description ?? '').replace(/"/g, '""')}"`,
      r.member_count != null ? String(r.member_count) : '',
      `"${String(r.created_by_name ?? '').replace(/"/g, '""')}"`,
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `contact-lists-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const totalMembers = lists.reduce((s, l) => s + Number(l.member_count ?? 0), 0)

  const cols: TableCol<ContactList>[] = [
    {
      key: 'name', label: 'List',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.name}</div>
          {r.description && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.description}</div>}
        </div>
      ),
    },
    {
      key: 'member_count', label: 'Members', align: 'right',
      render: r => (
        <span style={{ ...NUM, color: Number(r.member_count ?? 0) > 0 ? GREEN : 'var(--txt3)', fontWeight: 700 }}>
          {fmtNum(Number(r.member_count ?? 0))}
        </span>
      ),
    },
    { key: 'created_by_name', label: 'Created By', render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.created_by_name ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(r.created_at)}</span> },
    ...(canWrite ? [{
      key: 'id', label: '', align: 'right' as const,
      render: (r: ContactList) => (
        <button onClick={e => { e.stopPropagation(); setDeleteTarget(r) }}
          style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px', color: '#EF4444', borderColor: '#EF444440' }}>
          Delete
        </button>
      ),
    }] : []),
  ]

  return (
    <Page
      title="Contact Lists"
      subtitle={`${lists.length} lists · ${fmtNum(totalMembers)} total members`}
      actions={canWrite ? (
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New List
        </button>
      ) : undefined}
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="All Lists" badge={lists.length} padding={false}>
        <DataTable<ContactList>
          cols={cols}
          rows={lists}
          keyFn={r => r.id}
          emptyText="No contact lists yet."
          skeletonRows={loading ? 5 : 0}
          searchKeys={['name', 'description', 'created_by_name']}
          searchPlaceholder="Search lists…"
          pageSize={20}
          onExport={() => exportListsCsv(lists)}
        />
      </SectionCard>

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setName(''); setDesc(''); setSaveErr(null) }}
        title="New Contact List"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowCreate(false); setName(''); setDesc(''); setSaveErr(null) }} style={btnSecondary}>Cancel</button>
            <button onClick={create} disabled={saving || !name.trim()} style={btnPrimary}>
              {saving ? 'Creating…' : 'Create List'}
            </button>
          </div>
        }
      >
        {saveErr && <div style={{ color: '#EF4444', fontSize: 12.5, marginBottom: 10 }}>{saveErr}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
              List Name *
            </label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Active Cardholders Q3"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
              Description (optional)
            </label>
            <textarea
              value={desc}
              onChange={e => setDesc(e.target.value)}
              rows={3}
              placeholder="What's this list for?"
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', resize: 'none', fontSize: 13 }}
            />
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete Contact List"
        body={`Delete "${deleteTarget?.name}" and all its members? This cannot be undone.`}
        onConfirm={doDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </Page>
  )
}
