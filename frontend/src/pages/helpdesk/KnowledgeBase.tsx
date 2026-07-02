import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'

type Article = {
  id: number
  title: string
  slug: string
  category: string
  tags: string[]
  is_public: boolean
  view_count: number
  updated_at: string
  body_html?: string
  body_text?: string
}

const CATEGORIES = ['General', 'Loans', 'Cards', 'Accounts', 'Compliance', 'HR', 'IT', 'Collections']

const inp = (extra?: React.CSSProperties): React.CSSProperties => ({
  width: '100%', padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8,
  fontSize: 13, background: 'var(--bg)', color: 'var(--txt)', boxSizing: 'border-box', ...extra,
})

const fmtDate = (dt: string) => new Date(dt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

export default function KnowledgeBase() {
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [viewing, setViewing] = useState<Article | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Article | null>(null)
  const [saving, setSaving] = useState(false)

  const [fTitle, setFTitle] = useState('')
  const [fCategory, setFCategory] = useState('')
  const [fBody, setFBody] = useState('')
  const [fTags, setFTags] = useState('')
  const [fPublic, setFPublic] = useState(false)

  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = (q = search, cat = category) => {
    setLoading(true)
    const params = new URLSearchParams()
    if (q) params.set('search', q)
    if (cat) params.set('category', cat)
    apiFetch(`/api/helpdesk/kb?${params}`).then(r => r.json()).then(setArticles).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (v: string) => {
    setSearch(v)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => load(v, category), 300)
  }

  const openNew = () => {
    setEditing(null)
    setFTitle(''); setFCategory(''); setFBody(''); setFTags(''); setFPublic(false)
    setShowForm(true)
  }

  const openEdit = (a: Article) => {
    setEditing(a)
    setFTitle(a.title); setFCategory(a.category); setFBody(a.body_text ?? ''); setFTags((a.tags ?? []).join(', ')); setFPublic(a.is_public)
    setShowForm(true)
  }

  const openView = async (a: Article) => {
    apiFetch(`/api/helpdesk/kb/${a.id}`).then(r => r.json()).then(full => {
      setViewing(full)
      apiFetch(`/api/helpdesk/kb/${a.id}/view`, { method: 'POST' })
    })
  }

  const save = async () => {
    if (!fTitle.trim()) return
    setSaving(true)
    const tags = fTags.split(',').map(t => t.trim()).filter(Boolean)
    const body = {
      title: fTitle.trim(),
      category: fCategory,
      body_html: `<p>${fBody.replace(/\n/g, '</p><p>')}</p>`,
      body_text: fBody,
      tags,
      is_public: fPublic,
    }
    if (editing) {
      await apiFetch(`/api/helpdesk/kb/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } else {
      await apiFetch('/api/helpdesk/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    setSaving(false)
    setShowForm(false)
    load()
  }

  const deleteArticle = async (id: number) => {
    if (!confirm('Delete this article?')) return
    await apiFetch(`/api/helpdesk/kb/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>Knowledge Base</h1>
        <button
          onClick={openNew}
          style={{ padding: '8px 18px', background: '#0E2841', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          + New Article
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search articles…"
          style={{ flex: 1, maxWidth: 320, padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }}
        />
        <select
          value={category}
          onChange={e => { setCategory(e.target.value); load(search, e.target.value) }}
          style={{ padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }}
        >
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Article list */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--bg)' }}>
            <tr>
              {['Title', 'Category', 'Tags', 'Views', 'Public', 'Updated', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
            ) : articles.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>No articles found.</td></tr>
            ) : articles.map(a => (
              <tr key={a.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                <td style={{ padding: '10px 14px' }}>
                  <button
                    onClick={() => openView(a)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#0E2841', fontWeight: 600, fontSize: 13, textDecoration: 'underline', textUnderlineOffset: 2 }}
                  >
                    {a.title}
                  </button>
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{a.category || '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>
                  {(a.tags ?? []).slice(0, 3).map(t => (
                    <span key={t} style={{ display: 'inline-block', marginRight: 4, padding: '1px 6px', background: 'var(--bg)', border: '1px solid var(--bdr)', borderRadius: 99, fontSize: 11 }}>{t}</span>
                  ))}
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace' }}>{a.view_count}</td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: a.is_public ? '#16a34a22' : '#6b728022', color: a.is_public ? '#16a34a' : '#6b7280' }}>
                    {a.is_public ? 'Public' : 'Internal'}
                  </span>
                </td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{fmtDate(a.updated_at)}</td>
                <td style={{ padding: '10px 14px' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => openEdit(a)} style={{ padding: '3px 10px', border: '1px solid var(--bdr)', borderRadius: 6, background: 'var(--bg)', color: 'var(--txt)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
                    <button onClick={() => deleteArticle(a.id)} style={{ padding: '3px 10px', border: '1px solid #dc2626', borderRadius: 6, background: 'transparent', color: '#dc2626', fontSize: 11, cursor: 'pointer' }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* View Article Modal */}
      {viewing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--card)', borderRadius: 14, padding: 32, width: 680, maxWidth: '90vw', maxHeight: '80vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)', marginBottom: 4 }}>{viewing.title}</h2>
                <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{viewing.category} · {viewing.view_count} views · Updated {fmtDate(viewing.updated_at)}</span>
              </div>
              <button onClick={() => setViewing(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--txt2)', lineHeight: 1 }}>×</button>
            </div>
            <div
              style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--txt)', whiteSpace: 'pre-wrap' }}
              dangerouslySetInnerHTML={{ __html: viewing.body_html || viewing.body_text || '' }}
            />
            {(viewing.tags ?? []).length > 0 && (
              <div style={{ marginTop: 20, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {viewing.tags.map(t => (
                  <span key={t} style={{ padding: '2px 8px', background: 'var(--bg)', border: '1px solid var(--bdr)', borderRadius: 99, fontSize: 12, color: 'var(--txt2)' }}>{t}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: 600, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>{editing ? 'Edit Article' : 'New Article'}</h3>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Title *</label>
              <input value={fTitle} onChange={e => setFTitle(e.target.value)} placeholder="Article title" style={inp()} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Category</label>
                <select value={fCategory} onChange={e => setFCategory(e.target.value)} style={inp()}>
                  <option value="">Select category…</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Tags (comma-separated)</label>
                <input value={fTags} onChange={e => setFTags(e.target.value)} placeholder="e.g. policy, loans, faq" style={inp()} />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Body</label>
              <textarea
                value={fBody}
                onChange={e => setFBody(e.target.value)}
                rows={10}
                placeholder="Article content…"
                style={inp({ resize: 'vertical' })}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <input type="checkbox" id="kb-public" checked={fPublic} onChange={e => setFPublic(e.target.checked)} />
              <label htmlFor="kb-public" style={{ fontSize: 13, color: 'var(--txt)', cursor: 'pointer' }}>Visible to public (customer portal)</label>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '8px 18px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--bg)', color: 'var(--txt)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button
                onClick={save}
                disabled={!fTitle.trim() || saving}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', cursor: 'pointer', fontSize: 13, opacity: !fTitle.trim() || saving ? 0.5 : 1 }}
              >
                {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Article'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
