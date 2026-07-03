import { useState, useEffect, useCallback, useRef } from 'react'
import { Page, FilterBar, filterInputStyle, ErrBanner, Modal, ConfirmModal, Spinner } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, NUM, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KBArticle {
  id: number
  title: string
  category: string
  status: string           // 'Live' | 'Draft' — computed from is_public in backend
  helpful_pct: number | null
  helpful_count?: number
  not_helpful_count?: number
  body: string             // aliased from body_text in backend
  last_updated: string     // aliased from updated_at in backend
  created_by: string       // joined from o3c_users in backend
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ['Account', 'Loans', 'Cards', 'Transfers', 'App', 'General']
const STATUSES = ['Draft', 'Live', 'Archived']

// ── Category pill ──────────────────────────────────────────────────────────────

function CatPill({ cat }: { cat: string }) {
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 20,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap',
    }}>
      {cat}
    </span>
  )
}

// ── Status pill ────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, { bg: string; txt: string }> = {
  live:     { bg: 'rgba(22,163,74,.12)',  txt: GREEN },
  draft:    { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  archived: { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status.toLowerCase()] ?? STATUS_STYLE.draft
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 20,
      background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

// ── Helpful badge ──────────────────────────────────────────────────────────────

function HelpfulBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span style={{ fontSize: 12, color: 'var(--txt3)' }}>—</span>
  const color = pct >= 70 ? GREEN : AMBER
  return (
    <span style={{
      ...NUM,
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: pct >= 70 ? 'rgba(22,163,74,.12)' : 'rgba(217,119,6,.12)',
      color, whiteSpace: 'nowrap',
    }}>
      {pct}% helpful
    </span>
  )
}

// ── Article form (shared by New and Edit) ──────────────────────────────────────

interface ArticleFormState {
  title: string
  category: string
  status: string
  body: string
}

function ArticleForm({ form, onChange }: {
  form: ArticleFormState
  onChange: (f: ArticleFormState) => void
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)',
    borderRadius: 7, fontSize: 13, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Title</label>
        <input
          value={form.title}
          onChange={e => onChange({ ...form, title: e.target.value })}
          placeholder="Article title…"
          style={inputStyle}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Category</label>
          <select
            value={form.category}
            onChange={e => onChange({ ...form, category: e.target.value })}
            style={{ ...inputStyle, height: 36, padding: '0 10px' }}
          >
            <option value="">— Select —</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Status</label>
          <select
            value={form.status}
            onChange={e => onChange({ ...form, status: e.target.value })}
            style={{ ...inputStyle, height: 36, padding: '0 10px' }}
          >
            <option value="">— Select —</option>
            <option value="Draft">Draft</option>
            <option value="Live">Live</option>
          </select>
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Body</label>
        <textarea
          value={form.body}
          onChange={e => onChange({ ...form, body: e.target.value })}
          rows={10}
          placeholder="Article content…"
          style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical', lineHeight: 1.5 }}
        />
      </div>
    </div>
  )
}

// ── Action button ──────────────────────────────────────────────────────────────

function ActionBtn({ icon, label, onClick }: { icon: string; label: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick(e) }}
      title={label}
      style={{
        width: 28, height: 28, borderRadius: 7, border: '1.5px solid var(--input-bdr)',
        background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color: 'var(--txt2)',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--txt2)'; (e.currentTarget as HTMLElement).style.color = 'var(--txt)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--input-bdr)'; (e.currentTarget as HTMLElement).style.color = 'var(--txt2)' }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span>
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const EMPTY_FORM: ArticleFormState = { title: '', category: '', status: 'Draft', body: '' }

export default function KnowledgeBase() {
  const [articles, setArticles] = useState<KBArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [categoryFilter, setCategoryFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQ, setSearchQ] = useState('')

  // Expanded article id
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // Track article IDs the user has already voted on this session
  const [votedIds, setVotedIds] = useState<Set<number>>(new Set())

  // Modals
  const [newOpen, setNewOpen] = useState(false)
  const [editArticle, setEditArticle] = useState<KBArticle | null>(null)
  const [archiveArticle, setArchiveArticle] = useState<KBArticle | null>(null)
  const [form, setForm] = useState<ArticleFormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)

  // Debounce ref for search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedQ, setDebouncedQ] = useState('')

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setDebouncedQ(searchQ), 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [searchQ])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (categoryFilter) p.set('category', categoryFilter)
      if (statusFilter) p.set('status', statusFilter)
      const data = await apiFetch<KBArticle[]>(`/api/helpdesk/kb?${p.toString()}`)
      setArticles(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [categoryFilter, statusFilter])

  useEffect(() => { load() }, [load])

  // Client-side search
  const filtered = articles.filter(a =>
    !debouncedQ ||
    a.title.toLowerCase().includes(debouncedQ.toLowerCase()) ||
    a.body.toLowerCase().includes(debouncedQ.toLowerCase())
  )

  // New article
  function openNew() {
    setForm(EMPTY_FORM)
    setNewOpen(true)
  }

  async function handleCreate() {
    if (!form.title || !form.category || !form.status) {
      toast.error('Please fill in all required fields')
      return
    }
    setSaving(true)
    try {
      await apiPost('/api/helpdesk/kb', { title: form.title, category: form.category, status: form.status, body: form.body, body_text: form.body })
      toast.success('Article created')
      setNewOpen(false)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  // Edit article
  function openEdit(a: KBArticle) {
    setEditArticle(a)
    setForm({ title: a.title, category: a.category, status: a.status, body: a.body })
  }

  async function handleUpdate() {
    if (!editArticle) return
    if (!form.title || !form.category || !form.status) {
      toast.error('Please fill in all required fields')
      return
    }
    setSaving(true)
    try {
      await apiPut(`/api/helpdesk/kb/${editArticle.id}`, { title: form.title, category: form.category, status: form.status, body: form.body, body_text: form.body })
      toast.success('Article updated')
      setEditArticle(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  // Toggle publish/unpublish
  async function handleToggleStatus(a: KBArticle, e: React.MouseEvent) {
    e.stopPropagation()
    const newStatus = a.status === 'Live' ? 'Archived' : 'Live'
    try {
      await apiPut(`/api/helpdesk/kb/${a.id}/status`, { status: newStatus === 'Archived' ? 'Draft' : newStatus })
      toast.success(`Article ${newStatus === 'Live' ? 'published' : 'unpublished'}`)
      load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  // Archive
  async function handleArchive() {
    if (!archiveArticle) return
    setArchiving(true)
    try {
      await apiPut(`/api/helpdesk/kb/${archiveArticle.id}/status`, { status: 'Draft' })
      toast.success('Article archived')
      setArchiveArticle(null)
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setArchiving(false)
    }
  }

  // KB article feedback
  async function handleFeedback(articleId: number, helpful: boolean, e: React.MouseEvent) {
    e.stopPropagation()
    if (votedIds.has(articleId)) return
    try {
      await apiPost(`/api/helpdesk/kb/${articleId}/feedback`, { helpful })
      setVotedIds(prev => new Set(prev).add(articleId))
      // Optimistic update of local counts
      setArticles(prev => prev.map(a => {
        if (a.id !== articleId) return a
        return {
          ...a,
          helpful_count:     helpful ? (a.helpful_count ?? 0) + 1 : (a.helpful_count ?? 0),
          not_helpful_count: !helpful ? (a.not_helpful_count ?? 0) + 1 : (a.not_helpful_count ?? 0),
        }
      }))
      toast.success(helpful ? 'Marked as helpful' : 'Feedback recorded')
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const modalFooter = (onSave: () => void) => (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button
        onClick={() => { setNewOpen(false); setEditArticle(null) }}
        style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving}
        style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 8 }}
      >
        {saving && <Spinner size={14} color="#fff" />}
        Save
      </button>
    </div>
  )

  return (
    <Page
      title="Knowledge Base"
      subtitle="Help articles for agents and customers"
      actions={
        <button onClick={openNew} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Article
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Filters */}
      <FilterBar onReset={() => { setCategoryFilter(''); setStatusFilter('') }}>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </FilterBar>

      {/* Search bar */}
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <span className="material-symbols-rounded" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: 'var(--txt3)', pointerEvents: 'none' }}>search</span>
        <input
          placeholder="Search articles…"
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          style={{ ...filterInputStyle, width: '100%', paddingLeft: 34, height: 36, boxSizing: 'border-box' }}
        />
      </div>

      {/* Article list */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spinner size={28} />
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--txt2)', fontSize: 13 }}>
          No articles found
        </div>
      ) : (
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, overflow: 'hidden' }}>
          {filtered.map(a => (
            <div key={a.id}>
              {/* Row */}
              <div
                onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '12px 18px', borderBottom: '1px solid var(--bdr)',
                  cursor: 'pointer', background: expandedId === a.id ? 'var(--row-sel)' : 'transparent',
                }}
                onMouseEnter={e => { if (expandedId !== a.id) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                onMouseLeave={e => { if (expandedId !== a.id) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                {/* Left: title + pills */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{a.title}</span>
                    <CatPill cat={a.category} />
                    <StatusPill status={a.status} />
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 3, fontFamily: INTER }}>by {a.created_by}</div>
                </div>

                {/* Middle: helpful % */}
                <div style={{ flexShrink: 0 }}>
                  <HelpfulBadge pct={a.helpful_pct} />
                </div>

                {/* Right: last updated + actions */}
                <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(a.last_updated)}</span>
                  <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
                    <ActionBtn icon="edit" label="Edit" onClick={() => openEdit(a)} />
                    <button
                      onClick={e => handleToggleStatus(a, e)}
                      title={a.status === 'Live' ? 'Unpublish' : 'Publish'}
                      style={{
                        ...NUM,
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '3px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
                        border: a.status === 'Live' ? '1.5px solid rgba(217,119,6,.3)' : '1.5px solid rgba(22,163,74,.3)',
                        background: 'transparent',
                        color: a.status === 'Live' ? '#D97706' : GREEN,
                      }}
                    >
                      {a.status === 'Live' ? 'Unpublish' : 'Publish'}
                    </button>
                    {a.status !== 'Archived' && (
                      <ActionBtn icon="archive" label="Archive" onClick={() => setArchiveArticle(a)} />
                    )}
                  </div>
                </div>
              </div>

              {/* Expanded body */}
              {expandedId === a.id && (
                <div style={{
                  padding: '12px 18px 16px', borderBottom: '1px solid var(--bdr)',
                  background: 'var(--th-bg)',
                }}>
                  <div style={{
                    whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 13,
                    color: 'var(--txt)', padding: '12px 0',
                  }}>
                    {a.body || <span style={{ color: 'var(--txt3)', fontStyle: 'italic' }}>No content.</span>}
                  </div>

                  {/* Helpful / Not helpful feedback */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--bdr)', paddingTop: 12 }}>
                    <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>Was this helpful?</span>
                    {votedIds.has(a.id) ? (
                      <span style={{ fontSize: 12, color: GREEN, fontWeight: 600 }}>Thanks for your feedback!</span>
                    ) : (
                      <>
                        <button
                          onClick={e => handleFeedback(a.id, true, e)}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '4px 12px', border: `1.5px solid ${GREEN}40`, borderRadius: 6,
                            background: `${GREEN}0d`, color: GREEN, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          }}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>thumb_up</span>
                          Yes{(a.helpful_count ?? 0) > 0 && ` · ${a.helpful_count}`}
                        </button>
                        <button
                          onClick={e => handleFeedback(a.id, false, e)}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '4px 12px', border: '1.5px solid var(--bdr)', borderRadius: 6,
                            background: 'transparent', color: 'var(--txt2)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          }}
                        >
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>thumb_down</span>
                          No{(a.not_helpful_count ?? 0) > 0 && ` · ${a.not_helpful_count}`}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* New Article modal */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Article"
        width={560}
        footer={modalFooter(handleCreate)}
      >
        <ArticleForm form={form} onChange={setForm} />
      </Modal>

      {/* Edit Article modal */}
      <Modal
        open={!!editArticle}
        onClose={() => setEditArticle(null)}
        title="Edit Article"
        width={560}
        footer={modalFooter(handleUpdate)}
      >
        <ArticleForm form={form} onChange={setForm} />
      </Modal>

      {/* Archive confirm */}
      <ConfirmModal
        open={!!archiveArticle}
        title="Archive article?"
        body={`"${archiveArticle?.title}" will be moved to Archived and hidden from agents.`}
        confirmLabel="Archive"
        danger
        loading={archiving}
        onConfirm={handleArchive}
        onClose={() => setArchiveArticle(null)}
      />
    </Page>
  )
}
