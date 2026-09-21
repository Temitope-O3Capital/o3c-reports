import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  ErrBanner, Modal, ConfirmModal, btnPrimary, btnDanger, KpiCard,
  ActionRow, EmptyState,
} from '../../components/UI'
import type { TableCol, RowAction } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, fmtCount } from '../../lib/fmt'
import { INTER, NAVY, NUM, GREEN, AMBER, RED, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DNCEntry {
  id: number
  phone: string
  reason: string
  added_by: string
  added_at: string
}

interface DncKPIs {
  total_dnc: number
  added_this_month: number
  from_calls: number
}

// ── Field style ───────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CallCenterDNC() {
  const [rows, setRows] = useState<DNCEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [kpis, setKpis] = useState<DncKPIs | null>(null)
  const [kpiLoading, setKpiLoading] = useState(true)

  const [dncSearch, setDncSearch] = useState('')

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())

  // Add modal
  const [addOpen, setAddOpen] = useState(false)
  const [addPhone, setAddPhone] = useState('')
  const [addReason, setAddReason] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)

  // Remove confirm
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const [removeLoading, setRemoveLoading] = useState(false)

  // Search on the server (phone-normalized, plus reason/added-by) so it spans the whole
  // list, not just the loaded page. Debounced to one request per pause.
  const dq = useDebouncedValue(dncSearch, 300)
  // The in-flight request. Without this a slower earlier response can land after a newer
  // one and repaint the list with stale rows — type quickly in the search box and what
  // you end up looking at is not necessarily the last thing you typed.
  const reqRef = useRef<AbortController | null>(null)
  const load = useCallback(async (silent = false) => {
    reqRef.current?.abort()
    const ctrl = new AbortController()
    reqRef.current = ctrl
    if (!silent) setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: '200' })
    if (dq.trim()) params.set('search', dq.trim())
    try {
      const res = await apiFetch<{ data: DNCEntry[] }>(`/api/call-center/dnc?${params}`, { signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      setRows(Array.isArray(res) ? res : (res?.data ?? []))
    } catch (e: any) {
      // A superseded request is not an error the user should see.
      if (ctrl.signal.aborted) return
      setErr(e.message ?? 'Failed to load DNC list')
    } finally {
      if (!ctrl.signal.aborted) setLoading(false)
    }
  }, [dq])

  useEffect(() => { load() }, [load])
  useEffect(() => () => reqRef.current?.abort(), [])
  useLiveData(() => load(true))

  // Reconcile the selection whenever the rows change. The search is served by the
  // backend, so typing replaces `rows` wholesale — and a selection made before the search
  // then pointed at ids no longer on screen. The bar still read "5 selected", the
  // confirmation still promised 5, and the request posted an empty list: "0 number(s)
  // removed" while every number stayed on the list. Keep only what is really selected.
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev
      const live = new Set<string | number>(rows.map(r => r.id))
      const next = new Set<string | number>()
      for (const id of prev) if (live.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [rows])

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: DncKPIs }>('/api/call-center/dnc-kpis')
      .then(r => setKpis((r as any)?.data ?? r))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [])

  async function handleAdd() {
    if (!addPhone.trim() || !addReason.trim()) return
    setAddLoading(true)
    setAddErr(null)
    try {
      await apiPost('/api/call-center/dnc', { phone: addPhone.trim(), reason: addReason.trim() })
      toast.success('Number added to DNC list')
      setAddPhone('')
      setAddReason('')
      setAddOpen(false)
      load()
    } catch (e: any) {
      setAddErr(e.message ?? 'Failed to add to DNC')
    } finally {
      setAddLoading(false)
    }
  }

  // The numbers the confirmation promises and the request actually sends — derived once,
  // from the rows on screen, so the two can never disagree.
  const selectedPhones = useMemo(
    () => rows.filter(r => selectedIds.has(r.id)).map(r => r.phone),
    [rows, selectedIds],
  )

  async function handleRemove() {
    // Never post an empty list while claiming a count.
    if (selectedPhones.length === 0) {
      toast.error('Nothing to remove — that selection is no longer in the list.')
      setSelectedIds(new Set())
      setRemoveConfirm(false)
      return
    }
    setRemoveLoading(true)
    try {
      await apiPost('/api/call-center/dnc/bulk-remove', { phones: selectedPhones })
      toast.success(`${fmtCount(selectedPhones.length)} number(s) removed from DNC`)
      setSelectedIds(new Set())
      setRemoveConfirm(false)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to remove from DNC')
    } finally {
      setRemoveLoading(false)
    }
  }


  // Server already applied the search; render the rows as returned.
  const displayedDnc = rows

  function confirmRemoveSingle(r: DNCEntry) {
    setSelectedIds(new Set([r.id]))
    setRemoveConfirm(true)
  }

  // A DNC number auto-captured from a call carries the "Agent disposition:" reason tag;
  // everything else was added by hand. Surfacing the source next to the reason tells a
  // supervisor at a glance whether opt-outs are coming off live calls or manual entry.
  const isFromCall = (r: DNCEntry) => (r.reason ?? '').toLowerCase().startsWith('agent disposition')

  const cols: TableCol<DNCEntry>[] = [
    {
      key: 'phone',
      label: 'Phone',
      sortable: true,
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.phone}</span>
      ),
    },
    {
      key: 'reason',
      label: 'Reason',
      sortable: true,
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {isFromCall(r) && (
            <span title="Captured from a call disposition" className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: 'var(--txt3)', flexShrink: 0 }}>call</span>
          )}
          <span style={{ fontSize: TEXT.base, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.reason || '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'added_by',
      label: 'Added By',
      sortable: true,
      render: r => (
        <span style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{r.added_by || '—'}</span>
      ),
    },
    {
      key: 'added_at',
      label: 'Added Date',
      sortable: true,
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.added_at)}</span>
      ),
    },
    { key: '_actions', label: '', sortable: false, align: 'right',
      render: r => {
        const actions: RowAction[] = [
          { icon: 'remove_circle', label: 'Remove', onClick: () => confirmRemoveSingle(r), danger: true },
        ]
        return <ActionRow actions={actions} />
      },
    },
  ]

  // DataTable already renders the "N selected" bar, its background and a Clear button —
  // bulkBar holds ONLY the action buttons (matches Employers/Pipeline). Passing a whole
  // re-styled bar here produced a bar-inside-a-bar with the count and close doubled.
  const bulkBar = (
    <button
      onClick={() => setRemoveConfirm(true)}
      style={{ ...btnDanger, padding: `${SP[1]} ${SP[3]}`, fontSize: TEXT.sm }}
    >
      Remove from DNC
    </button>
  )

  return (
    <Page
      title="Do Not Call List"
      subtitle="Manage numbers excluded from outbound calls"
      loading={loading && rows.length === 0}
      skeletonKpis={3}
      actions={
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
          Add to DNC
        </button>
      }
    >
      {/* onRetry passes its click event straight into load(silent?), and a MouseEvent is
          truthy — so Retry used to suppress the loading state and look like it did nothing. */}
      <ErrBanner error={err} onRetry={() => load()} />

      {/* KPI cards — auto-fit rather than a hard 3-up, which crushed at ~400px.
          Matches Forwards. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Total DNC" value={kpis ? fmtCount(kpis.total_dnc) : '—'} icon="do_not_disturb_on" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Added This Month" value={kpis ? fmtCount(kpis.added_this_month) : '—'} icon="add_circle" accent={AMBER} loading={kpiLoading} />
        <KpiCard label="From Call Opt-Outs" value={kpis ? fmtCount(kpis.from_calls) : '—'} icon="call" accent={RED} loading={kpiLoading} />
      </div>

      <SectionCard title="DNC Entries" badge={displayedDnc.length} padding={false}>
        <ExpandableFilterBar
          search={dncSearch}
          onSearch={setDncSearch}
          groups={[]}
          onReset={() => setDncSearch('')}
          resultCount={displayedDnc.length}
          totalCount={rows.length}
          placeholder="Search phone, reason…"
        />
        <DataTable
          cols={cols}
          rows={displayedDnc}
          keyFn={r => r.id}
          loading={loading}
          emptyText={
            <EmptyState
              icon="do_not_disturb_on"
              title="No DNC Entries Found"
              description={dncSearch.trim()
                ? 'No number on the list matches that search.'
                : 'Numbers customers ask to be excluded from outbound calls show up here.'}
            />
          }
          selectable
          selectedIds={selectedIds}
          onSelect={setSelectedIds}
          bulkBar={bulkBar}
          skeletonRows={8}
          pageSize={20}
        />
      </SectionCard>

      {/* Add to DNC modal */}
      <Modal
        open={addOpen}
        onClose={() => { setAddOpen(false); setAddPhone(''); setAddReason(''); setAddErr(null) }}
        title="Add to DNC List"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setAddOpen(false); setAddPhone(''); setAddReason(''); setAddErr(null) }}
              style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={addLoading || !addPhone.trim() || !addReason.trim()}
              style={{
                ...btnPrimary,
                opacity: addLoading || !addPhone.trim() || !addReason.trim() ? 0.6 : 1,
                cursor: addLoading || !addPhone.trim() || !addReason.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {addLoading ? 'Adding…' : 'Add to DNC'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ErrBanner error={addErr} />
          <div>
            <label htmlFor="dnc-add-phone" style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              Phone Number <span style={{ color: '#C00000' }}>*</span>
            </label>
            <input
              id="dnc-add-phone"
              type="text"
              value={addPhone}
              onChange={e => setAddPhone(e.target.value)}
              placeholder="e.g. 08012345678"
              style={{ ...fieldStyle, height: 36 }}
            />
          </div>
          <div>
            <label htmlFor="dnc-add-reason" style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              Reason <span style={{ color: '#C00000' }}>*</span>
            </label>
            <input
              id="dnc-add-reason"
              type="text"
              value={addReason}
              onChange={e => setAddReason(e.target.value)}
              placeholder="e.g. Customer requested opt-out"
              style={{ ...fieldStyle, height: 36 }}
            />
          </div>
        </div>
      </Modal>

      {/* Remove confirm modal */}
      <ConfirmModal
        open={removeConfirm}
        title="Remove from DNC"
        body={`Remove ${fmtCount(selectedPhones.length)} number(s) from the DNC list? They will be eligible for outbound calls again.`}
        confirmLabel="Remove"
        danger
        loading={removeLoading}
        onConfirm={handleRemove}
        onClose={() => setRemoveConfirm(false)}
      />
    </Page>
  )
}
