import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Page, SectionCard, DataTable, Modal, ConfirmModal,
  ErrBanner, btnPrimary, btnSecondary, Spinner,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiDelete, API, getCsrfToken } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, SORA, INTER, NUM } from '../../lib/design'
import { filterInputStyle } from '../../components/UI'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContactList {
  id: number
  name: string
  description?: string
  member_count?: number
  created_at: string
  created_by_name?: string
}

interface Member {
  id: number
  cif_number?: string
  contact_name?: string
  first_name?: string
  last_name?: string
  phone?: string
  email?: string
  added_at?: string
  created_at?: string
}

interface SearchResult {
  cif_number: string
  name?: string
  first_name?: string
  last_name?: string
  phone?: string
  email?: string
}

interface PreflightResult {
  total: number
  valid: number
  invalid: number
  errors?: string[]
}

// ── Member Drawer ──────────────────────────────────────────────────────────────

function MemberDrawer({ list, onClose, canWrite }: { list: ContactList; onClose: () => void; canWrite: boolean }) {
  const [members,    setMembers]    = useState<Member[]>([])
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState<string | null>(null)
  const [search,     setSearch]     = useState('')
  const [results,    setResults]    = useState<SearchResult[]>([])
  const [searching,  setSearching]  = useState(false)
  const [addErr,     setAddErr]     = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)
  const [csvFile,    setCsvFile]    = useState<File | null>(null)
  const [preflight,  setPreflight]  = useState<PreflightResult | null>(null)
  const [uploading,  setUploading]  = useState(false)
  const [showCsvModal, setShowCsvModal] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadMembers = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<Member[]>(`/api/contact-lists/${list.id}/members`)
      setMembers(Array.isArray(data) ? data : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [list.id])

  useEffect(() => { loadMembers() }, [loadMembers])

  function triggerSearch(q: string) {
    setSearch(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (q.trim().length < 2) { setResults([]); return }
    searchTimer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await apiFetch<SearchResult[]>(`/api/contact-lists/${list.id}/search?q=${encodeURIComponent(q)}`)
        setResults(Array.isArray(data) ? data : [])
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 300)
  }

  async function addMember(cif: string) {
    setAddErr(null)
    try {
      await apiPost(`/api/contact-lists/${list.id}/members`, { cif_number: cif })
      setSearch(''); setResults([])
      toast.success('Member added')
      loadMembers()
    } catch (ex: any) { setAddErr(ex.message ?? 'Failed to add member') }
  }

  async function removeMember() {
    if (!removeTarget) return
    try {
      await apiDelete(`/api/contact-lists/${list.id}/members/${removeTarget.id}`)
      setRemoveTarget(null)
      toast.success('Member removed')
      loadMembers()
    } catch (ex: any) { toast.error(ex.message ?? 'Failed to remove') }
  }

  async function postMultipart<T>(endpoint: string, file: File): Promise<T> {
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`${API}${endpoint}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrfToken() },
      body: fd,
    })
    if (!res.ok) {
      const msg = await res.json().catch(() => ({}))
      throw new Error(msg?.error ?? `HTTP ${res.status}`)
    }
    return res.json()
  }

  async function pickCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvFile(file)
    setPreflight(null)
    try {
      const res = await postMultipart<PreflightResult>(`/api/contact-lists/${list.id}/preflight`, file)
      setPreflight(res)
      setShowCsvModal(true)
    } catch (ex: any) { toast.error(ex.message ?? 'Preflight failed') }
    if (fileRef.current) fileRef.current.value = ''
  }

  async function uploadCsv() {
    if (!csvFile) return
    setUploading(true)
    try {
      await postMultipart(`/api/contact-lists/${list.id}/upload-csv`, csvFile)
      setShowCsvModal(false); setCsvFile(null); setPreflight(null)
      toast.success('CSV imported')
      loadMembers()
    } catch (ex: any) { toast.error(ex.message ?? 'Upload failed') }
    finally { setUploading(false) }
  }

  function memberName(m: Member) {
    return m.contact_name ?? ([m.first_name, m.last_name].filter(Boolean).join(' ') || '—')
  }

  const memberCols: TableCol<Member>[] = [
    {
      key: 'contact_name', label: 'Name',
      render: m => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{memberName(m)}</div>
          {m.cif_number && <div style={{ fontSize: 11, color: 'var(--txt3)', fontFamily: 'monospace' }}>{m.cif_number}</div>}
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: m => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{m.phone ?? '—'}</span> },
    { key: 'email', label: 'Email', render: m => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{m.email ?? '—'}</span> },
    {
      key: 'added_at', label: 'Added',
      render: m => <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{fmtDatetime(m.added_at ?? m.created_at ?? '')}</span>,
    },
    ...(canWrite ? [{
      key: 'id', label: '', align: 'right' as const,
      render: (m: Member) => (
        <button
          onClick={() => setRemoveTarget(m)}
          style={{ ...btnSecondary, fontSize: 11, padding: '2px 9px', color: RED, borderColor: `${RED}40` }}
        >
          Remove
        </button>
      ),
    }] : []),
  ]

  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }
  const inp: React.CSSProperties = { ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 900,
        }}
      />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 560,
        background: 'var(--card)', zIndex: 901, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 32px rgba(0,0,0,.15)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 20px 16px', borderBottom: '1px solid var(--bdr)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)', fontFamily: SORA }}>{list.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 2 }}>
              {fmtNum(members.length)} member{members.length !== 1 ? 's' : ''}
              {list.description ? ` · ${list.description}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ ...btnSecondary, padding: '4px 10px', flexShrink: 0 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <ErrBanner error={err} onRetry={loadMembers} />

          {/* Add member */}
          {canWrite && (
            <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 16, border: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', fontFamily: SORA, marginBottom: 12 }}>
                Add Member
              </div>
              <label style={lbl}>Search by name, phone, email, or CIF</label>
              <div style={{ position: 'relative' }}>
                <input
                  value={search}
                  onChange={e => triggerSearch(e.target.value)}
                  placeholder="Type at least 2 characters…"
                  style={inp}
                />
                {searching && (
                  <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)' }}>
                    <Spinner size={14} />
                  </span>
                )}
              </div>
              {addErr && <div style={{ fontSize: 12, color: RED, marginTop: 6 }}>{addErr}</div>}
              {results.length > 0 && (
                <div style={{
                  marginTop: 6, border: '1px solid var(--bdr)', borderRadius: 8,
                  background: 'var(--card)', maxHeight: 180, overflowY: 'auto',
                }}>
                  {results.map(r => (
                    <button
                      key={r.cif_number}
                      onClick={() => addMember(r.cif_number)}
                      style={{
                        display: 'flex', width: '100%', padding: '9px 14px',
                        borderBottom: '1px solid var(--bdr)', background: 'none', border: 'none',
                        cursor: 'pointer', textAlign: 'left', gap: 10, alignItems: 'center',
                      }}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>person</span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
                          {r.name ?? ([r.first_name, r.last_name].filter(Boolean).join(' ') || '—')}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--txt2)' }}>
                          {[r.cif_number, r.phone, r.email].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, color: NAVY, fontWeight: 600 }}>Add →</span>
                    </button>
                  ))}
                </div>
              )}
              {search.length >= 2 && !searching && results.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 6 }}>No contacts found for "{search}"</div>
              )}

              <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 1, background: 'var(--bdr)' }} />
                <span style={{ fontSize: 11, color: 'var(--txt3)', flexShrink: 0 }}>or</span>
                <div style={{ flex: 1, height: 1, background: 'var(--bdr)' }} />
              </div>

              <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={pickCsvFile} />
              <button
                onClick={() => fileRef.current?.click()}
                style={{ ...btnSecondary, width: '100%', marginTop: 12, justifyContent: 'center', gap: 6, display: 'flex' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>upload_file</span>
                Upload CSV
              </button>
              <p style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 5, textAlign: 'center' }}>
                CSV must have a <code>cif_number</code> column. Each row adds one member.
              </p>
            </div>
          )}

          {/* Members table */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', fontFamily: SORA, marginBottom: 10 }}>
              Members ({fmtNum(members.length)})
            </div>
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>
            ) : (
              <DataTable<Member>
                cols={memberCols}
                rows={members}
                keyFn={m => m.id}
                emptyText="No members yet. Add contacts above."
                searchKeys={['contact_name', 'first_name', 'last_name', 'phone', 'email', 'cif_number']}
                searchPlaceholder="Filter members…"
                pageSize={25}
              />
            )}
          </div>
        </div>
      </div>

      {/* CSV preflight modal */}
      <Modal
        open={showCsvModal}
        onClose={() => { setShowCsvModal(false); setCsvFile(null); setPreflight(null) }}
        title="CSV Import Preview"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowCsvModal(false); setCsvFile(null); setPreflight(null) }} style={btnSecondary}>Cancel</button>
            <button
              onClick={uploadCsv}
              disabled={uploading || !preflight || preflight.valid === 0}
              style={btnPrimary}
            >
              {uploading ? 'Importing…' : `Import ${fmtNum(preflight?.valid ?? 0)} Contacts`}
            </button>
          </div>
        }
      >
        {preflight && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              {[
                ['Total Rows',   preflight.total,   '#6B7280'],
                ['Valid',        preflight.valid,   GREEN],
                ['Invalid',      preflight.invalid, preflight.invalid > 0 ? RED : '#6B7280'],
              ].map(([label, val, color]) => (
                <div key={String(label)} style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px', textAlign: 'center' as const }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: String(color), fontFamily: SORA }}>
                    {fmtNum(Number(val))}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--txt2)', marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>
            {preflight.errors && preflight.errors.length > 0 && (
              <div style={{ background: '#FFF1F1', borderRadius: 8, padding: 12, border: `1px solid ${RED}30` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: RED, marginBottom: 6 }}>Issues found:</div>
                <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12, color: '#7F1D1D', lineHeight: 1.7 }}>
                  {preflight.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}
                  {preflight.errors.length > 8 && <li>…and {preflight.errors.length - 8} more</li>}
                </ul>
              </div>
            )}
            {preflight.valid === 0 && (
              <div style={{ color: RED, fontSize: 13, fontWeight: 500 }}>
                No valid rows to import. Check your CSV format.
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!removeTarget}
        title="Remove Member"
        body={`Remove "${memberName(removeTarget ?? ({} as Member))}" from this list? They can be re-added later.`}
        onConfirm={removeMember}
        onClose={() => setRemoveTarget(null)}
        confirmLabel="Remove"
        danger
      />
    </>
  )
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
  const [openList, setOpenList] = useState<ContactList | null>(null)
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
    {
      key: 'id', label: '', align: 'right' as const,
      render: (r: ContactList) => (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={e => { e.stopPropagation(); setOpenList(r) }}
            style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px', gap: 4, display: 'flex', alignItems: 'center' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>group</span>
            Members
          </button>
          {canWrite && (
            <button
              onClick={e => { e.stopPropagation(); setDeleteTarget(r) }}
              style={{ ...btnSecondary, fontSize: 11, padding: '3px 10px', color: RED, borderColor: `${RED}40` }}
            >
              Delete
            </button>
          )}
        </div>
      ),
    },
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

      <SectionCard
        title="All Lists"
        badge={lists.length}
        padding={false}
        actions={
          <button
            onClick={() => exportListsCsv(lists)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
            Export CSV
          </button>
        }
      >
        <DataTable<ContactList>
          cols={cols}
          rows={lists}
          keyFn={r => r.id}
          emptyText="No contact lists yet."
          skeletonRows={loading ? 5 : 0}
          searchKeys={['name', 'description', 'created_by_name']}
          searchPlaceholder="Search lists…"
          pageSize={20}
          onRowClick={r => setOpenList(r)}
        />
      </SectionCard>

      {/* Member management drawer */}
      {openList && (
        <MemberDrawer
          list={openList}
          onClose={() => { setOpenList(null); load() }}
          canWrite={canWrite}
        />
      )}

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
        {saveErr && <div style={{ color: RED, fontSize: 12.5, marginBottom: 10 }}>{saveErr}</div>}
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
