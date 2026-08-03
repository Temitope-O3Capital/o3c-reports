import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  Modal, ConfirmModal, ErrBanner, btnPrimary, btnSecondary, DateFilter, NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol, RowAction, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'
import { toast } from 'sonner'
import { fmtDatetime, monthStart, today } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, NUM, INTER, TEXT, FW, RADIUS } from '../../lib/design'
import { blocksToHtml, type Block } from '../../components/EmailBlockEditor'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Template {
  id: number
  name: string
  channel: string
  category: string
  sms_body?: string
  email_subject?: string
  email_body_html?: string
  email_blocks?: Block[]
  created_at: string
  created_by_name?: string
}

// ── Pills ─────────────────────────────────────────────────────────────────────

const CHANNEL_COLOR: Record<string, string> = { email: BLUE, sms: PURPLE }
const CATEGORY_COLOR: Record<string, string> = {
  marketing: GREEN, collections: NAVY, general: '#6B7280',
  onboarding: BLUE, repayment_reminder: '#D97706',
}

function ChannelPill({ channel }: { channel: string }) {
  const c = CHANNEL_COLOR[channel] ?? '#6B7280'
  return <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}14`, color: c }}>{channel.toUpperCase()}</span>
}

function CategoryPill({ category }: { category: string }) {
  const c = CATEGORY_COLOR[category] ?? '#6B7280'
  const label = category.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}10`, color: c }}>{label}</span>
}

// ── Access guard ──────────────────────────────────────────────────────────────

const CAMPAIGN_READ_ONLY = new Set(['bd_officer', 'bd_head'])

// ── Main component ─────────────────────────────────────────────────────────────

export default function CampaignTemplates() {
  const navigate = useNavigate()
  const role = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}').role ?? '' } catch { return '' } })()
  const canWrite = !CAMPAIGN_READ_ONLY.has(role)

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [search,      setSearch]      = useState('')
  const [fChannels,   setFChannels]   = useState(new Set<string>())
  const [fCategories, setFCategories] = useState(new Set<string>())
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null)
  const [preview, setPreview]     = useState<Template | null>(null)
  const [dateFrom, setDateFrom]   = useState(monthStart())
  const [dateTo,   setDateTo]     = useState(today())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (fChannels.size)   p.set('channel',  [...fChannels].join(','))
      if (fCategories.size) p.set('category', [...fCategories].join(','))
      if (dateFrom)         p.set('from',     dateFrom)
      if (dateTo)           p.set('to',       dateTo)
      const res = await apiFetch<Template[]>(`/api/message-templates?${p}`)
      setTemplates(Array.isArray(res) ? res : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [fChannels, fCategories, dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(load)

  const displayed = useMemo(() =>
    search
      ? templates.filter(t => t.name.toLowerCase().includes(search.toLowerCase()) || (t.created_by_name ?? '').toLowerCase().includes(search.toLowerCase()))
      : templates
  , [templates, search])

  async function doDelete() {
    if (!deleteTarget) return
    try { await apiDelete(`/api/message-templates/${deleteTarget.id}`); setDeleteTarget(null); load() }
    catch (ex: any) { setErr(ex.message) }
  }

  async function duplicate(r: Template) {
    try {
      await apiPost('/api/message-templates', {
        name: `${r.name} (copy)`,
        channel: r.channel,
        category: r.category,
        sms_body: r.sms_body,
        email_subject: r.email_subject,
        email_body_html: r.email_body_html,
        email_blocks: r.email_blocks,
      })
      toast.success('Template duplicated')
      load()
    } catch (ex: any) { toast.error(ex.message) }
  }

  function exportCsv(data: Template[]) {
    const hdr = ['Name', 'Channel', 'Category', 'Created By', 'Created At']
    const rows = data.map(r => [
      `"${(r.name ?? '').replace(/"/g, '""')}"`, r.channel ?? '', r.category ?? '',
      `"${(r.created_by_name ?? '').replace(/"/g, '""')}"`, r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[hdr.join(','), ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `templates-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove()
  }

  const cols: TableCol<Template>[] = [
    {
      key: 'name', label: 'Template',
      render: r => <NameCell name={r.name} sub={r.email_subject ?? (r.sms_body ? r.sms_body.slice(0, 60) : undefined)} avatar={false} />,
    },
    { key: 'channel',  label: 'Channel',  render: r => <ChannelPill  channel={r.channel} /> },
    { key: 'category', label: 'Category', render: r => <CategoryPill category={r.category} /> },
    { key: 'created_by_name', label: 'Created By', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.created_by_name ?? '—'}</span> },
    { key: 'created_at', label: 'Created', render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDatetime(r.created_at)}</span> },
    { key: '_actions', label: '', sortable: false,
      render: r => {
        const actions: RowAction[] = [
          { icon: 'preview', label: 'Preview', onClick: () => setPreview(r) },
          ...(canWrite ? [
            { icon: 'edit', label: 'Edit', onClick: () => navigate(`/campaigns/templates/${r.id}/edit`) },
            { icon: 'content_copy', label: 'Duplicate', onClick: () => duplicate(r) },
            { icon: 'delete', label: 'Delete', onClick: () => setDeleteTarget(r), danger: true },
          ] : []),
        ]
        return <ActionRow actions={actions} />
      },
    },
  ]

  return (
    <Page
      title="Message Templates"
      subtitle="Reusable SMS and email campaign templates"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          {canWrite && (
            <button onClick={() => navigate('/campaigns/templates/new')} style={btnPrimary}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
              New Template
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="Templates" badge={displayed.length} padding={false} actions={<button onClick={() => exportCsv(displayed)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'channel',
              label: 'Channel',
              options: Object.entries(CHANNEL_COLOR).map(([v, color]) => ({ value: v, label: v.toUpperCase(), color })),
              selected: fChannels,
              onChange: setFChannels,
            },
            {
              key: 'category',
              label: 'Category',
              options: Object.entries(CATEGORY_COLOR).map(([v, color]) => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), color })),
              selected: fCategories,
              onChange: setFCategories,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFChannels(new Set()); setFCategories(new Set()) }}
          onApply={load}
          resultCount={displayed.length}
          totalCount={templates.length}
          placeholder="Search templates…"
        />
        <DataTable<Template>
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          emptyText={
            canWrite
              ? 'No templates yet — click "New Template" to create your first one.'
              : 'No templates have been created yet.'
          }
          skeletonRows={loading ? 6 : 0}
          pageSize={20}
        />
      </SectionCard>

      {/* Preview modal */}
      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? ''} width={520}
        footer={<button onClick={() => setPreview(null)} style={btnSecondary}>Close</button>}>
        {preview && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <ChannelPill channel={preview.channel} />
              <CategoryPill category={preview.category} />
            </div>
            {preview.email_subject && (
              <div>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }}>Subject</div>
                <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.semibold }}>{preview.email_subject}</div>
              </div>
            )}
            <div>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>
                {preview.channel === 'sms' ? 'SMS Body' : 'Email Body'}
              </div>
              {preview.channel === 'sms' ? (
                <div style={{ fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6, background: 'var(--th-bg)', padding: '12px 14px', borderRadius: RADIUS.md, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {preview.sms_body || '(no body)'}
                </div>
              ) : (
                <iframe
                  srcDoc={
                    (preview.email_blocks?.length ?? 0) > 0
                      ? blocksToHtml(Array.isArray(preview.email_blocks) ? preview.email_blocks : [])
                      : preview.email_body_html ?? ''
                  }
                  style={{ width: '100%', height: 340, border: 'none', borderRadius: RADIUS.md, background: '#F4F6FA' }}
                  title="Email preview"
                  sandbox="allow-same-origin"
                />
              )}
            </div>
          </div>
        )}
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
