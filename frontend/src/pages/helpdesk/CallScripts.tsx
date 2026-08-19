import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Page, ErrBanner, Modal, ConfirmModal, Spinner } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, MONO, FW, RADIUS, TEXT } from '../../lib/design'
import { canManageScripts } from '../../hooks/useAuth'
import { type CallScript, CAT_ICON, CATEGORY_NAMES, parseScript, toPlainText, previewLine, ScriptReader } from '../../components/scriptKit'
import { toast } from 'sonner'

// ── Editor form ────────────────────────────────────────────────────────────────

interface FormState { title: string; category: string; body: string }
const EMPTY_FORM: FormState = { title: '', category: '', body: '' }

function ScriptForm({ form, onChange }: { form: FormState; onChange: (f: FormState) => void }) {
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
  }
  const label: React.CSSProperties = { fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={label}>Title</label>
        <input value={form.title} onChange={e => onChange({ ...form, title: e.target.value })} placeholder="e.g. Loan Repayment & Balance" style={inputStyle} />
      </div>
      <div>
        <label style={label}>Category</label>
        <select value={form.category} onChange={e => onChange({ ...form, category: e.target.value })} style={{ ...inputStyle, height: 36, padding: '0 10px' }}>
          <option value="">— Select —</option>
          {CATEGORY_NAMES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label style={label}>Script</label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
          value={form.body} onChange={e => onChange({ ...form, body: e.target.value })} rows={12}
          placeholder={'## Section heading\n> A line the agent says out loud\n[ A note or action just for the agent ]\n- A bullet point\nUse {Customer Name} for fill-in placeholders'}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, fontFamily: MONO, fontSize: TEXT.sm }} />
        <div style={{ marginTop: 6, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.6 }}>
          <code style={{ fontFamily: MONO }}>##</code> heading&nbsp;·&nbsp;
          <code style={{ fontFamily: MONO }}>&gt;</code> spoken line&nbsp;·&nbsp;
          <code style={{ fontFamily: MONO }}>[ ]</code> agent note&nbsp;·&nbsp;
          <code style={{ fontFamily: MONO }}>-</code> bullet&nbsp;·&nbsp;
          <code style={{ fontFamily: MONO }}>{'{token}'}</code> fill-in
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CallScripts() {
  const [rows, setRows] = useState<CallScript[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState<string>('')   // '' = all
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const [newOpen, setNewOpen] = useState(false)
  const [editItem, setEditItem] = useState<CallScript | null>(null)
  const [deleteItem, setDeleteItem] = useState<CallScript | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [copied, setCopied] = useState(false)

  // Reference content: supervisors curate, line agents read-only (enforced server-side).
  const canManage = useMemo(() => canManageScripts(), [])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    try {
      const data = await apiFetch<CallScript[]>(`/api/helpdesk/canned-responses?channel=call`)
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['tickets'] })

  // Category rail: canonical order first, then any extras present in data.
  const categories = useMemo(() => {
    const present = new Set(rows.map(r => r.category).filter(Boolean))
    const extras = [...present].filter(c => !CATEGORY_NAMES.includes(c)).sort()
    const counts = (c: string) => rows.filter(r => r.category === c).length
    return [...CATEGORY_NAMES, ...extras]
      .filter(c => present.has(c))
      .map(c => ({ name: c, icon: CAT_ICON(c), count: counts(c) }))
  }, [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (activeCat && r.category !== activeCat) return false
    if (search) {
      const q = search.toLowerCase()
      return r.title.toLowerCase().includes(q) || (r.category ?? '').toLowerCase().includes(q) || (r.body ?? '').toLowerCase().includes(q)
    }
    return true
  }), [rows, activeCat, search])

  // Keep a valid selection as the list changes.
  useEffect(() => {
    if (loading) return
    if (selectedId != null && filtered.some(r => r.id === selectedId)) return
    setSelectedId(filtered.length ? filtered[0].id : null)
  }, [filtered, loading, selectedId])

  const selected = useMemo(() => rows.find(r => r.id === selectedId) ?? null, [rows, selectedId])
  const blocks = useMemo(() => selected ? parseScript(selected.body) : [], [selected])

  useEffect(() => { setCopied(false) }, [selectedId])

  function openNew() { setForm(EMPTY_FORM); setNewOpen(true) }
  function openEdit(r: CallScript) { setEditItem(r); setForm({ title: r.title, category: r.category, body: r.body }) }

  async function handleCreate() {
    if (!form.title || !form.category || !form.body) { toast.error('Please fill in title, category and script'); return }
    setSaving(true)
    try {
      const created = await apiPost<CallScript>('/api/helpdesk/canned-responses', { name: form.title, category: form.category, body_text: form.body, channel: 'call' })
      toast.success('Call script created')
      setNewOpen(false)
      if (created?.id) setSelectedId(created.id)
      load()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function handleUpdate() {
    if (!editItem) return
    if (!form.title || !form.category || !form.body) { toast.error('Please fill in title, category and script'); return }
    setSaving(true)
    try {
      await apiPut(`/api/helpdesk/canned-responses/${editItem.id}`, { name: form.title, category: form.category, body_text: form.body })
      toast.success('Call script updated')
      setEditItem(null)
      load()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!deleteItem) return
    setDeleting(true)
    try {
      await apiDelete(`/api/helpdesk/canned-responses/${deleteItem.id}`)
      toast.success('Deleted')
      setDeleteItem(null)
      load()
    } catch (e: any) { toast.error(e.message) } finally { setDeleting(false) }
  }

  async function copyScript() {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(toPlainText(selected.body))
      setCopied(true)
      toast.success('Script copied')
      // best-effort usage bump so the "last used" surfaces the busy scripts
      apiPost(`/api/helpdesk/canned-responses/${selected.id}/use`, {}).catch(() => {})
      setTimeout(() => setCopied(false), 2000)
    } catch { toast.error('Could not copy') }
  }

  // ── Styles ──
  const chip = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 11px', borderRadius: RADIUS.full, cursor: 'pointer',
    fontSize: TEXT.sm, fontWeight: FW.medium, whiteSpace: 'nowrap',
    border: `1px solid ${active ? NAVY : 'var(--bdr)'}`,
    background: active ? NAVY : 'var(--card)', color: active ? '#fff' : 'var(--txt2)',
    transition: 'all .12s',
  })

  const modalFooter = (onSave: () => void, onCancel: () => void) => (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button onClick={onCancel} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
      <button onClick={onSave} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', opacity: saving ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit' }}>
        {saving && <Spinner size={14} color="#fff" />}Save
      </button>
    </div>
  )

  return (
    <Page
      title="Call Scripts"
      subtitle="Ready-to-use talk-tracks for the Call Centre: search, read, and copy live on a call"
      actions={canManage ? (
        <button onClick={openNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: 'inherit' }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
          New Script
        </button>
      ) : undefined}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Search + category rail */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <div style={{ position: 'relative', maxWidth: 460 }}>
          <span className="material-symbols-rounded" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 19, color: 'var(--txt3)' }}>search</span>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search scripts by title or content…"
            style={{ width: '100%', padding: '9px 12px 9px 37px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          <button onClick={() => setActiveCat('')} style={chip(activeCat === '')}>
            All <span style={{ fontFamily: MONO, opacity: 0.75 }}>{rows.length}</span>
          </button>
          {categories.map(c => (
            <button key={c.name} onClick={() => setActiveCat(activeCat === c.name ? '' : c.name)} style={chip(activeCat === c.name)}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{c.icon}</span>
              {c.name} <span style={{ fontFamily: MONO, opacity: 0.75 }}>{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Two-pane: list + reader */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Left list */}
        <div style={{ flex: '1 1 300px', minWidth: 280, maxWidth: 380, display: 'flex', flexDirection: 'column', border: '1px solid var(--card-bdr)', borderRadius: 12, background: 'var(--card)', boxShadow: 'var(--card-shadow)', overflow: 'hidden', maxHeight: 'calc(100vh - 250px)' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bdr)', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', justifyContent: 'space-between' }}>
            <span>{activeCat || 'All scripts'}</span>
            <span style={{ fontFamily: MONO }}>{filtered.length}</span>
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading ? (
              <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No scripts match.</div>
            ) : filtered.map(r => {
              const active = r.id === selectedId
              return (
                <button key={r.id} onClick={() => setSelectedId(r.id)} style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '11px 14px', border: 'none', borderBottom: '1px solid var(--bdr)',
                  borderLeft: `3px solid ${active ? RED : 'transparent'}`,
                  background: active ? 'var(--row-sel)' : 'transparent', fontFamily: 'inherit',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15, color: active ? RED : 'var(--txt3)', flexShrink: 0 }}>{CAT_ICON(r.category)}</span>
                    <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', lineHeight: 1.3 }}>{r.title}</span>
                  </div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: 22 }}>
                    {previewLine(r.body)}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Right reader */}
        <div style={{ flex: '2 1 420px', minWidth: 300, border: '1px solid var(--card-bdr)', borderRadius: 12, background: 'var(--card)', boxShadow: 'var(--card-shadow)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 250px)' }}>
          {!selected ? (
            <div style={{ padding: '60px 24px', textAlign: 'center', color: 'var(--txt3)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 40, color: 'var(--txt3)' }}>menu_book</span>
              <div style={{ fontSize: TEXT.base }}>Select a script to read it here.</div>
            </div>
          ) : (
            <>
              {/* Sticky header */}
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'var(--chip-bg)', borderRadius: RADIUS.full, padding: '2px 10px', marginBottom: 7 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{CAT_ICON(selected.category)}</span>
                    {selected.category}
                  </div>
                  <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1.25 }}>{selected.title}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>
                    {selected.created_by ? `By ${selected.created_by}` : 'O3 Capital · Standard script'}
                    {selected.last_used_at ? ` · Last used ${fmtDate(selected.last_used_at)}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={copyScript} title="Copy script" style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: RADIUS.md,
                    border: 'none', background: copied ? GREEN : NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                    cursor: 'pointer', fontFamily: 'inherit', transition: 'background .15s',
                  }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{copied ? 'check' : 'content_copy'}</span>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  {canManage && (
                    <>
                      <button onClick={() => openEdit(selected)} title="Edit" style={iconBtn}>
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>edit</span>
                      </button>
                      <button onClick={() => setDeleteItem(selected)} title="Delete" style={{ ...iconBtn, color: RED }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>delete</span>
                      </button>
                    </>
                  )}
                </div>
              </div>
              {/* Body */}
              <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
                <ScriptReader blocks={blocks} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* New */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New Call Script" width={620} footer={modalFooter(handleCreate, () => setNewOpen(false))}>
        <ScriptForm form={form} onChange={setForm} />
      </Modal>

      {/* Edit */}
      <Modal open={!!editItem} onClose={() => setEditItem(null)} title="Edit Call Script" width={620} footer={modalFooter(handleUpdate, () => setEditItem(null))}>
        <ScriptForm form={form} onChange={setForm} />
      </Modal>

      {/* Delete */}
      <ConfirmModal
        open={!!deleteItem}
        title="Delete call script?"
        body={`"${deleteItem?.title}" will be permanently deleted and cannot be recovered.`}
        confirmLabel="Delete" danger loading={deleting}
        onConfirm={handleDelete} onClose={() => setDeleteItem(null)}
      />
    </Page>
  )
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 34, height: 34, borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
  background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer',
}
