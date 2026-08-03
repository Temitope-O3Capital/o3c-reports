import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, Modal, ConfirmModal, ErrBanner, btnPrimary, btnSecondary,
} from '../../components/UI'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'
import { toast } from 'sonner'
import { fmtDate } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { blocksToHtml, type Block } from '../../components/EmailBlockEditor'
import { STARTER_TEMPLATES, type StarterTemplate } from './starterTemplates'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Template {
  id: number
  name: string
  channel: string
  category: string
  sms_body?: string
  whatsapp_body?: string
  email_subject?: string
  email_body_html?: string
  email_blocks?: Block[]
  created_at: string
  created_by_name?: string
}

type Channel = 'email' | 'sms' | 'whatsapp'

// ── Channel / category styling ─────────────────────────────────────────────────

const CHANNEL_META: Record<string, { color: string; icon: string; label: string }> = {
  email:    { color: BLUE,      icon: 'mail',       label: 'Email' },
  sms:      { color: PURPLE,    icon: 'smartphone', label: 'SMS' },
  whatsapp: { color: '#25D366', icon: 'chat',       label: 'WhatsApp' },
}
const CATEGORY_COLOR: Record<string, string> = {
  marketing: GREEN, collections: NAVY, general: '#6B7280',
  onboarding: BLUE, repayment_reminder: '#D97706',
}
const catLabel = (c: string) => (c || '').replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())

function ChannelPill({ channel }: { channel: string }) {
  const m = CHANNEL_META[channel] ?? { color: '#6B7280', icon: 'campaign', label: channel }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${m.color}16`, color: m.color }}>
      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{m.icon}</span>
      {m.label}
    </span>
  )
}
function CategoryPill({ category }: { category: string }) {
  const c = CATEGORY_COLOR[category] ?? '#6B7280'
  return <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}10`, color: c }}>{catLabel(category)}</span>
}

function snippet(t: Template | StarterTemplate): string {
  if (t.channel === 'email') return t.email_subject || 'Email template'
  if (t.channel === 'whatsapp') return (t.whatsapp_body || '').replace(/\*/g, '').slice(0, 120)
  return (t.sms_body || '').slice(0, 120)
}

const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

// ── Main ────────────────────────────────────────────────────────────────────

export default function CampaignTemplates() {
  const navigate = useNavigate()
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [search, setSearch]       = useState('')
  const [fChannel, setFChannel]   = useState<string>('')
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null)
  const [preview, setPreview]     = useState<Template | StarterTemplate | null>(null)
  const [pickChannel, setPickChannel] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<Template[]>('/api/message-templates')
      setTemplates(Array.isArray(res) ? res : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load)

  const displayed = useMemo(() => {
    let ts = templates
    if (fChannel) ts = ts.filter(t => t.channel === fChannel)
    if (search) {
      const q = search.toLowerCase()
      ts = ts.filter(t => t.name.toLowerCase().includes(q) || (t.created_by_name ?? '').toLowerCase().includes(q) || snippet(t).toLowerCase().includes(q))
    }
    return ts
  }, [templates, fChannel, search])

  const starters = useMemo(() => fChannel ? STARTER_TEMPLATES.filter(s => s.channel === fChannel) : STARTER_TEMPLATES, [fChannel])

  async function doDelete() {
    if (!deleteTarget) return
    try { await apiDelete(`/api/message-templates/${deleteTarget.id}`); setDeleteTarget(null); load() }
    catch (ex: any) { setErr(ex.message) }
  }

  async function duplicate(r: Template) {
    try {
      await apiPost('/api/message-templates', {
        name: `${r.name} (copy)`, channel: r.channel, category: r.category,
        sms_body: r.sms_body, whatsapp_body: r.whatsapp_body,
        email_subject: r.email_subject, email_body_html: r.email_body_html, email_blocks: r.email_blocks,
      })
      toast.success('Template duplicated'); load()
    } catch (ex: any) { toast.error(ex.message) }
  }

  function useStarter(s: StarterTemplate) {
    navigate('/campaigns/templates/new', { state: { starter: {
      name: s.name, channel: s.channel, category: s.category,
      sms_body: s.sms_body, whatsapp_body: s.whatsapp_body,
      email_subject: s.email_subject, email_blocks: s.email_blocks,
    } } })
  }

  function startNew(ch: Channel) {
    setPickChannel(false)
    navigate(`/campaigns/templates/new?channel=${ch}`)
  }

  const channelFilters: { v: string; label: string }[] = [
    { v: '', label: 'All' },
    { v: 'email', label: 'Email' },
    { v: 'sms', label: 'SMS' },
    { v: 'whatsapp', label: 'WhatsApp' },
  ]

  return (
    <Page
      title="Message Templates"
      subtitle="Reusable email, SMS and WhatsApp templates"
      actions={canWrite && (
        <button onClick={() => setPickChannel(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Template
        </button>
      )}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Filter row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 3 }}>
          {channelFilters.map(f => (
            <button key={f.v} onClick={() => setFChannel(f.v)}
              style={{ padding: '5px 14px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                background: fChannel === f.v ? 'var(--card)' : 'transparent', color: fChannel === f.v ? 'var(--txt)' : 'var(--txt3)',
                boxShadow: fChannel === f.v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative', flex: 1, maxWidth: 300 }}>
          <span className="material-symbols-rounded" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 18, color: 'var(--txt3)' }}>search</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px 8px 34px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.base, outline: 'none' }} />
        </div>
      </div>

      {/* Your templates */}
      <SectionCard title="Your templates" badge={displayed.length}>
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {Array.from({ length: 6 }).map((_, i) => <div key={i} style={{ height: 120, background: 'var(--bg)', border: '1px solid var(--bdr)', borderRadius: 12 }} />)}
          </div>
        ) : displayed.length === 0 ? (
          <div style={{ padding: '32px 18px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
            {canWrite ? 'No templates yet — create one, or start from a starter below.' : 'No templates have been created yet.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {displayed.map(t => (
              <div key={t.id} style={cardStyle} onClick={() => setPreview(t)}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--txt3)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--bdr)')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <ChannelPill channel={t.channel} />
                  <CategoryPill category={t.category} />
                </div>
                <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', lineHeight: 1.5, height: 40, overflow: 'hidden' }}>{snippet(t)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bdr)' }}>
                  <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{t.created_by_name ?? '—'} · {fmtDate(t.created_at)}</span>
                  {canWrite && (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                      <IconBtn icon="edit" title="Edit" onClick={e => { e.stopPropagation(); navigate(`/campaigns/templates/${t.id}/edit`) }} />
                      <IconBtn icon="content_copy" title="Duplicate" onClick={e => { e.stopPropagation(); duplicate(t) }} />
                      <IconBtn icon="delete" title="Delete" danger onClick={e => { e.stopPropagation(); setDeleteTarget(t) }} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Starter gallery */}
      {canWrite && (
        <div style={{ marginTop: 16 }}>
          <SectionCard title="Start from a starter" subtitle="Prebuilt templates you can edit and save as your own">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {starters.map(s => (
                <div key={s.id} style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <ChannelPill channel={s.channel} />
                    <CategoryPill category={s.category} />
                  </div>
                  <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>{s.name}</div>
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', lineHeight: 1.5, height: 40, overflow: 'hidden' }}>{s.description}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bdr)' }}>
                    <button onClick={() => setPreview(s)} style={{ ...miniBtn, background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)' }}>Preview</button>
                    <button onClick={() => useStarter(s)} style={{ ...miniBtn, background: NAVY, color: '#fff', border: 'none', marginLeft: 'auto' }}>Use starter</button>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      )}

      {/* Channel picker modal */}
      <Modal open={pickChannel} onClose={() => setPickChannel(false)} title="New template — choose a channel" width={460}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {(['email', 'sms', 'whatsapp'] as Channel[]).map(ch => {
            const m = CHANNEL_META[ch]
            return (
              <button key={ch} onClick={() => startNew(ch)}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '20px 10px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = m.color; e.currentTarget.style.background = `${m.color}0c` }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--bdr)'; e.currentTarget.style.background = 'var(--card)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 30, color: m.color }}>{m.icon}</span>
                <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{m.label}</span>
              </button>
            )
          })}
        </div>
      </Modal>

      {/* Preview modal */}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? ''} width={520}
        footer={
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <button onClick={() => setPreview(null)} style={btnSecondary}>Close</button>
            {preview && 'id' in preview && canWrite && (
              <button onClick={() => { const p = preview as Template; setPreview(null); navigate(`/campaigns/templates/${p.id}/edit`) }} style={{ ...btnPrimary, marginLeft: 'auto' }}>Edit</button>
            )}
            {preview && !('id' in preview) && canWrite && (
              <button onClick={() => { const s = preview as StarterTemplate; setPreview(null); useStarter(s) }} style={{ ...btnPrimary, marginLeft: 'auto' }}>Use starter</button>
            )}
          </div>
        }>
        {preview && <PreviewBody t={preview} />}
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete Template"
        body={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        onConfirm={doDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </Page>
  )
}

// ── Preview body ──────────────────────────────────────────────────────────────

function PreviewBody({ t }: { t: Template | StarterTemplate }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <ChannelPill channel={t.channel} />
        <CategoryPill category={t.category} />
      </div>
      {t.channel === 'email' && t.email_subject && (
        <div>
          <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }}>Subject</div>
          <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.semibold }}>{t.email_subject}</div>
        </div>
      )}
      <div>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>
          {t.channel === 'email' ? 'Email Body' : t.channel === 'whatsapp' ? 'WhatsApp Message' : 'SMS Body'}
        </div>
        {t.channel === 'email' ? (
          <iframe
            srcDoc={(t.email_blocks?.length ?? 0) > 0 ? blocksToHtml(Array.isArray(t.email_blocks) ? t.email_blocks : []) : ((t as Template).email_body_html ?? '')}
            style={{ width: '100%', height: 340, border: 'none', borderRadius: RADIUS.md, background: '#F4F6FA' }}
            title="Email preview" sandbox="allow-same-origin" />
        ) : (
          <div style={{ fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6, background: 'var(--th-bg)', padding: '12px 14px', borderRadius: RADIUS.md, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {(t.channel === 'whatsapp' ? t.whatsapp_body : t.sms_body) || '(no body)'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Small UI bits ─────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12,
  padding: '14px 16px', cursor: 'pointer', transition: 'border-color .12s',
  display: 'flex', flexDirection: 'column',
}
const miniBtn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 7, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
}

function IconBtn({ icon, title, onClick, danger }: { icon: string; title: string; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button title={title} onClick={onClick}
      style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: danger ? '#C00000' : 'var(--txt2)', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )
}
