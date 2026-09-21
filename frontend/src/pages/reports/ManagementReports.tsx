import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, ErrBanner, ConfirmModal, Button, ActionRow, EmptyState, filterInputStyle, Sk,
} from '../../components/UI'
import type { TableCol, RowAction } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { GREEN, AMBER, RED, INTER, NUM, TEXT, FW, SP, RADIUS, SHADOW } from '../../lib/design'
import { useLiveData } from '../../hooks/useRealtime'
import { toast } from 'sonner'
import {
  canManageReports, useCatalogue, fmtWhen, howSent, firstLine, plural, ruleLabel, audienceLabel,
  AUDIENCE_COLOR, StatusPill, RecipientStack, Segmented, PreviewModal,
} from './management/shared'
import type { ReportRow, RunRow, Summary } from './management/shared'

/*
  Email Reports.

  Every scheduled email the workspace builds — the built-in management and sales reports
  and any report made here — as cards you can open, preview, test and send. The backend
  sends each one on its schedule by itself; this page is where you see that it did, and
  where a report is changed or made.
*/

type Filter = 'all' | 'active' | 'paused'

const eyebrow: CSSProperties = {
  fontSize: TEXT['2xs'], fontWeight: FW.semibold, letterSpacing: 0.7, textTransform: 'uppercase', fontFamily: INTER,
}

export default function ManagementReports() {
  const navigate = useNavigate()
  const { catalogue } = useCatalogue()
  const canManage = canManageReports()

  const [reports, setReports] = useState<ReportRow[]>([])
  const [runs, setRuns]       = useState<RunRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [filter, setFilter]   = useState<Filter>('all')
  const [historyFor, setHistoryFor] = useState('')
  const [busyKey, setBusyKey]       = useState<string | null>(null)
  const [preview, setPreview]       = useState<{ runId: number; title: string } | null>(null)
  const [confirmSend, setConfirmSend]     = useState<ReportRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ReportRow | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [rep, sum, hist] = await Promise.all([
        apiFetch<ReportRow[]>('/api/management-reports'),
        apiFetch<Summary>('/api/management-reports/summary'),
        apiFetch<RunRow[]>(`/api/management-reports/runs?limit=100${historyFor ? `&report_key=${encodeURIComponent(historyFor)}` : ''}`),
      ])
      setReports(Array.isArray(rep) ? rep : [])
      setSummary(sum)
      setRuns(Array.isArray(hist) ? hist : [])
    } catch (e: any) {
      if (!silent) setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [historyFor])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['management_reports'] })

  // The change feed announces a finished send, but a run can finish between its polls;
  // while anything is in flight, check directly as well.
  const inFlight = runs.some(r => r.status === 'running')
  useEffect(() => {
    if (!inFlight) return
    const t = setInterval(() => load(true), 5000)
    return () => clearInterval(t)
  }, [inFlight, load])

  const counts = useMemo(() => ({
    all: reports.length,
    active: reports.filter(r => r.is_active).length,
    paused: reports.filter(r => !r.is_active).length,
  }), [reports])
  const shown = reports.filter(r => filter === 'all' || (filter === 'active' ? r.is_active : !r.is_active))

  async function act(r: ReportRow, fn: () => Promise<void>) {
    setBusyKey(r.report_key)
    try { await fn() } catch (e: any) { toast.error(e.message) } finally { setBusyKey(null) }
  }
  const path = (r: ReportRow) => `/api/management-reports/${encodeURIComponent(r.report_key)}`

  const sendTest = (r: ReportRow) => act(r, async () => {
    await apiPost(`${path(r)}/send`, { mode: 'test' })
    toast.success(`Building ${r.name} and sending a test to you. It arrives in about a minute.`)
    load(true)
  })
  const sendNow = (r: ReportRow) => act(r, async () => {
    await apiPost(`${path(r)}/send`, { mode: 'send' })
    toast.success(`Sending ${r.name} to ${plural(r.recipients.length, 'recipient')}.`)
    setConfirmSend(null)
    load(true)
  })
  const toggleActive = (r: ReportRow) => act(r, async () => {
    await apiPut(path(r), { is_active: !r.is_active })
    toast.success(r.is_active ? `${r.name} paused. It will not be sent until resumed.` : `${r.name} resumed.`)
    load(true)
  })
  const duplicate = (r: ReportRow) => act(r, async () => {
    const copy = await apiPost<ReportRow>(`${path(r)}/duplicate`, {})
    toast.success(`Made a paused copy of ${r.name}.`)
    navigate(`/reports/management/${encodeURIComponent(copy.report_key)}`)
  })
  const remove = (r: ReportRow) => act(r, async () => {
    await apiDelete(path(r))
    toast.success(`${r.name} deleted. Its send history is kept.`)
    setConfirmDelete(null)
    load(true)
  })
  const openPreview = (r: ReportRow) => {
    if (r.preview_run_id) setPreview({ runId: r.preview_run_id, title: r.name })
    else navigate(`/reports/management/${encodeURIComponent(r.report_key)}?preview=1`)
  }

  const historyCols: TableCol<RunRow>[] = [
    { key: 'started_at', label: 'When', render: r => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'nowrap' }}>{fmtWhen(r.started_at)}</span>
    ) },
    { key: 'name', label: 'Report', render: r => (
      <div style={{ minWidth: 180 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{r.name}</div>
        {r.subject && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{r.subject}</div>}
      </div>
    ) },
    { key: 'run_trigger', label: 'How', render: r => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{howSent(r.run_trigger, r.requested_by_name)}</span>
    ) },
    { key: 'status', label: 'Outcome', render: r => (
      <div title={r.error ?? undefined}>
        <StatusPill status={r.status} trigger={r.run_trigger} />
        {r.status === 'failed' && r.error && (
          <div style={{ fontSize: TEXT.xs, color: RED, marginTop: 3, maxWidth: 280 }}>{firstLine(r.error)}</div>
        )}
      </div>
    ) },
    { key: 'recipients', label: 'Recipients', align: 'right', render: r => (
      <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.run_trigger === 'preview' ? '—' : fmtNum(r.recipients.length)}</span>
    ) },
    { key: 'body_kb', label: 'Size', align: 'right', render: r => (
      <span style={{ ...NUM, fontSize: TEXT.sm, color: r.body_kb != null && r.body_kb > 102 ? AMBER : 'var(--txt2)', whiteSpace: 'nowrap' }}
        title={r.body_kb != null && r.body_kb > 102 ? 'Over 102 KB: Gmail shows this email clipped' : undefined}>
        {r.body_kb == null ? '—' : `${r.body_kb.toFixed(1)} KB`}
      </span>
    ) },
    { key: '_view', label: '', align: 'right', render: r => r.has_preview ? (
      <Button type="button" variant="secondary" size="sm" icon="visibility"
        onClick={() => setPreview({ runId: r.id, title: r.name })}>View</Button>
    ) : null },
  ]

  return (
    <Page
      title="Email Reports"
      subtitle="Email reports the workspace builds and sends on a schedule"
      actions={canManage ? (
        <Button type="button" variant="primary" icon="add" onClick={() => navigate('/reports/management/new')}>New Report</Button>
      ) : undefined}
    >
      <ErrBanner error={error} onRetry={() => load()} />

      <StatStrip summary={summary} loading={loading && !summary && !error} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SP[3], flexWrap: 'wrap', margin: `${SP[6]} 0 ${SP[3]}` }}>
        <Segmented<Filter>
          ariaLabel="Show reports"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'active', label: `Sending ${counts.active}` },
            { value: 'paused', label: `Paused ${counts.paused}` },
          ]}
        />
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Times are West Africa Time</span>
      </div>

      {loading && !reports.length ? (
        <div style={gridStyle}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ ...cardShell, padding: SP[5], display: 'grid', gap: SP[3] }}>
              <Sk w={90} h={10} /><Sk w="70%" h={18} /><Sk h={12} /><Sk w="55%" h={12} /><Sk w="40%" h={12} />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon="forward_to_inbox"
          title={filter === 'paused' ? 'No Paused Reports' : 'No Reports Yet'}
          description={filter === 'paused' ? 'Every report is sending on its schedule.' : 'Make a report from a template or from scratch, and choose when it goes and who gets it.'}
          action={canManage && filter !== 'paused'
            ? { label: 'New Report', icon: 'add', onClick: () => navigate('/reports/management/new') }
            : undefined}
        />
      ) : (
        <div style={gridStyle}>
          {shown.map(r => (
            <ReportCard
              key={r.report_key}
              r={r}
              ruleText={ruleLabel(catalogue, r.due_rule)}
              audienceText={audienceLabel(catalogue, r.audience)}
              sectionTitles={r.sections.map(id => catalogue?.sections.find(s => s.id === id)?.title ?? id)}
              canManage={canManage}
              busy={busyKey === r.report_key}
              onOpen={() => navigate(`/reports/management/${encodeURIComponent(r.report_key)}`)}
              onPreview={() => openPreview(r)}
              onTest={() => sendTest(r)}
              onSendNow={() => setConfirmSend(r)}
              onToggle={() => toggleActive(r)}
              onDuplicate={() => duplicate(r)}
              onDelete={() => setConfirmDelete(r)}
            />
          ))}
        </div>
      )}

      <SectionCard
        title="Send History"
        subtitle="Every scheduled send, send on demand, test and preview, newest first."
        style={{ marginTop: SP[8] }}
        actions={
          <select id="mr-history-filter" value={historyFor} onChange={e => setHistoryFor(e.target.value)}
            aria-label="Show history for" style={{ ...filterInputStyle, minWidth: 190 }}>
            <option value="">All Reports</option>
            {reports.map(r => <option key={r.report_key} value={r.report_key}>{r.name}</option>)}
          </select>
        }
      >
        <DataTable cols={historyCols} rows={runs} keyFn={r => r.id} pageSize={15}
          loading={loading && !runs.length} emptyText="Nothing has been sent from the workspace yet." />
      </SectionCard>

      {preview && <PreviewModal runId={preview.runId} title={preview.title} onClose={() => setPreview(null)} />}

      <ConfirmModal
        open={!!confirmSend}
        title={confirmSend ? `Send ${confirmSend.name} Now?` : 'Send Now?'}
        body={confirmSend
          ? `It is built with today's figures and emailed straight away to ${plural(confirmSend.recipients.length, 'recipient')}. The scheduled send still goes out as normal.`
          : ''}
        confirmLabel="Send Now"
        loading={!!confirmSend && busyKey === confirmSend.report_key}
        onConfirm={() => { if (confirmSend) sendNow(confirmSend) }}
        onClose={() => setConfirmSend(null)}
      />
      <ConfirmModal
        open={!!confirmDelete}
        danger
        title={confirmDelete ? `Delete ${confirmDelete.name}?` : 'Delete Report?'}
        body="It stops sending and leaves this page. Everything it has already sent stays in the send history."
        confirmLabel="Delete Report"
        loading={!!confirmDelete && busyKey === confirmDelete.report_key}
        onConfirm={() => { if (confirmDelete) remove(confirmDelete) }}
        onClose={() => setConfirmDelete(null)}
      />
    </Page>
  )
}

// ── Summary strip ─────────────────────────────────────────────────────────────

function StatStrip({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  const cells = [
    { label: 'Reports Sending', value: summary ? `${summary.active} of ${summary.total}` : '—', sub: 'A paused report is not sent' },
    {
      label: 'Sent Today', value: summary ? fmtNum(summary.sent_today) : '—',
      sub: summary?.last_sent ? `Last: ${summary.last_sent.name}, ${fmtWhen(summary.last_sent.finished_at)}` : 'Nothing sent yet today',
    },
    {
      label: 'Failed, Last 7 Days', value: summary ? fmtNum(summary.failed_7d) : '—',
      sub: summary && summary.failed_7d ? 'The send history gives the reason' : 'Every send delivered',
      tone: summary ? (summary.failed_7d ? RED : GREEN) : undefined,
    },
    {
      label: 'Next Send', value: summary?.next_due ? fmtWhen(summary.next_due.at) : '—',
      sub: summary?.next_due ? summary.next_due.name : 'Nothing scheduled',
    },
  ]
  return (
    // A 1px gap over a border-coloured ground draws the dividers, so they stay correct
    // when the four cells wrap onto two rows on a narrow screen.
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 1,
      background: 'var(--card-bdr)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl,
      overflow: 'hidden', boxShadow: 'var(--card-shadow)',
    }}>
      {cells.map(c => (
        <div key={c.label} style={{ background: 'var(--card)', padding: `${SP[4]} ${SP[5]}`, minWidth: 0 }}>
          <div style={{ ...eyebrow, color: 'var(--txt3)' }}>{c.label}</div>
          {loading ? <div style={{ margin: '10px 0 6px' }}><Sk w="60%" h={22} /></div> : (
            <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.semibold, color: c.tone ?? 'var(--txt)', margin: '6px 0 4px', letterSpacing: -0.3 }}>
              {c.value}
            </div>
          )}
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.sub}>
            {c.sub}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Report card ───────────────────────────────────────────────────────────────

const gridStyle: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 330px), 1fr))', gap: SP[4],
}

const cardShell: CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl,
  boxShadow: 'var(--card-shadow)', minWidth: 0,
}

function ReportCard({
  r, ruleText, audienceText, sectionTitles, canManage, busy,
  onOpen, onPreview, onTest, onSendNow, onToggle, onDuplicate, onDelete,
}: {
  r: ReportRow
  ruleText: string
  audienceText: string
  sectionTitles: string[]
  canManage: boolean
  busy: boolean
  onOpen: () => void
  onPreview: () => void
  onTest: () => void
  onSendNow: () => void
  onToggle: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [hover, setHover] = useState(false)
  const accent = AUDIENCE_COLOR[r.audience] ?? '#6B7280'
  const overdue = r.is_active && !!r.next_due_at && new Date(r.next_due_at).getTime() < Date.now()

  const actions: RowAction[] = canManage ? [
    { icon: 'send', label: r.recipients.length ? 'Send now to everyone on the list' : 'Add recipients before sending', onClick: () => { if (r.recipients.length) onSendNow() } },
    { icon: 'content_copy', label: 'Duplicate', onClick: onDuplicate },
    { icon: r.is_active ? 'pause_circle' : 'play_circle', label: r.is_active ? 'Pause sending' : 'Resume sending', onClick: onToggle },
    ...(r.is_builtin ? [] : [{ icon: 'delete', label: 'Delete', onClick: onDelete, danger: true }]),
  ] : []

  return (
    <article
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      tabIndex={0}
      aria-label={`${r.name}. ${r.is_active ? 'Sending' : 'Paused'}. Open to edit.`}
      style={{
        ...cardShell,
        display: 'flex', flexDirection: 'column', cursor: 'pointer', overflow: 'hidden',
        boxShadow: hover ? SHADOW.md : 'var(--card-shadow)',
        borderColor: hover ? 'var(--input-bdr)' : 'var(--card-bdr)',
        transition: 'box-shadow 160ms ease, border-color 160ms ease',
        opacity: busy ? 0.7 : 1,
      }}
    >
      <div style={{ padding: `${SP[5]} ${SP[5]} ${SP[4]}`, display: 'flex', flexDirection: 'column', gap: SP[4], flex: 1 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SP[2] }}>
            <span style={{ ...eyebrow, color: accent }}>
              {audienceText}{r.is_builtin ? <span style={{ color: 'var(--txt3)' }}> · Built-in</span> : null}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, fontWeight: FW.medium, color: r.is_active ? GREEN : AMBER }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: RADIUS.full, background: r.is_active ? GREEN : AMBER }} />
              {r.is_active ? 'Sending' : 'Paused'}
            </span>
          </div>
          <h3 style={{ margin: `${SP[2]} 0 ${SP[1]}`, fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1.3 }}>
            {r.name}
          </h3>
          {r.description && (
            <p style={{
              margin: 0, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{r.description}</p>
          )}
        </div>

        <dl style={{ margin: 0, display: 'grid', gap: SP[3] }}>
          <Fact icon="schedule" label="Schedule">
            <div style={{ color: 'var(--txt)' }}>{ruleText} · {r.send_time}</div>
            <div style={{ color: !r.is_active ? AMBER : overdue ? RED : 'var(--txt3)', fontSize: TEXT.xs, marginTop: 1 }}>
              {!r.is_active ? 'Paused'
                : !r.next_due_at ? 'Not scheduled'
                : overdue ? `Due ${fmtWhen(r.next_due_at)}, not sent yet`
                : `Next ${fmtWhen(r.next_due_at)}`}
            </div>
          </Fact>
          <Fact icon="view_agenda" label="Contents">
            <div style={{ color: 'var(--txt)' }}>{plural(r.sections.length, 'section')}</div>
            <div style={{ color: 'var(--txt3)', fontSize: TEXT.xs, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={sectionTitles.join(', ')}>
              {sectionTitles.slice(0, 3).join(', ')}{sectionTitles.length > 3 ? ', …' : ''}
            </div>
          </Fact>
          <Fact icon="group" label="Recipients">
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
              {r.recipients.length ? <RecipientStack recipients={r.recipients} /> : null}
              <span style={{ color: r.recipients.length ? 'var(--txt)' : RED }}>
                {r.recipients.length ? plural(r.recipients.length, 'recipient') : 'No recipients yet'}
              </span>
            </div>
          </Fact>
        </dl>
      </div>

      <div onClick={e => e.stopPropagation()} style={{ borderTop: '1px solid var(--bdr)', padding: `${SP[3]} ${SP[5]} ${SP[4]}`, display: 'grid', gap: SP[3], cursor: 'default' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap', minHeight: 24 }} title={r.last_run_error ?? undefined}>
          {r.last_run_status ? (
            <>
              <StatusPill status={r.last_run_status} trigger={r.last_run_trigger} />
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                {fmtWhen(r.last_run_finished_at ?? r.last_run_started_at)} · {howSent(r.last_run_trigger, r.last_run_requested_by_name)}
              </span>
            </>
          ) : <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Not sent from the workspace yet</span>}
        </div>
        {r.last_run_status === 'failed' && r.last_run_error && (
          <div style={{ fontSize: TEXT.xs, color: RED, marginTop: -4 }}>{firstLine(r.last_run_error)}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
          <Button type="button" size="sm" variant="secondary" icon="visibility" disabled={busy} onClick={onPreview}>Preview</Button>
          {canManage && (
            <Button type="button" size="sm" variant="ghost" icon="outgoing_mail" disabled={busy} onClick={onTest}>Test to Me</Button>
          )}
          <span style={{ flex: 1 }} />
          {actions.length > 0 && <ActionRow actions={actions} />}
        </div>
      </div>
    </article>
  )
}

function Fact({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', gap: SP[3], alignItems: 'start' }}>
      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18, color: 'var(--txt3)', marginTop: 1 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <dt style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{label}</dt>
        <dd style={{ margin: 0, fontSize: TEXT.sm, lineHeight: 1.45 }}>{children}</dd>
      </div>
    </div>
  )
}
