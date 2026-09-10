import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Page, SectionCard, Spinner, ErrBanner, StatusBadge, btnDanger, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { RED, TEXT, FW, RADIUS, SP } from '../../lib/design'

interface DeleteRequest {
  id: number
  ticket_id: number
  reason: string
  status: string
  created_at: string
  decided_at?: string
  decision_note?: string
  requested_by_name: string
  decided_by_name?: string
  ticket_ref: string
  subject: string
  customer_name: string
  customer_email: string
  channel: string
}

type Scope = 'pending' | 'all'

// Lightweight relative-time — fmt.ts has no helper, so keep it local. Falls back
// to nothing meaningful for future/invalid dates (caller pairs it with fmtDatetime).
function relTime(s: string | null | undefined): string {
  if (!s) return '—'
  const t = new Date(s).getTime()
  if (!isFinite(t)) return fmtDatetime(s)
  const diff = Date.now() - t
  if (diff < 0) return fmtDatetime(s)
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return fmtDatetime(s)
}

export default function CareApprovals() {
  const [scope, setScope] = useState<Scope>('pending')
  const [rows, setRows] = useState<DeleteRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const raw = await apiFetch<any>(`/api/helpdesk/delete-requests?status=${scope}`)
      const list = Array.isArray(raw) ? raw : (raw?.data ?? [])
      setRows(list as DeleteRequest[])
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => { load() }, [load])

  const decide = useCallback(async (id: number, approve: boolean) => {
    setBusyId(id)
    try {
      const note = (notes[id] ?? '').trim()
      await apiPost(`/api/helpdesk/delete-requests/${id}/decide`, { approve, note: note || undefined })
      toast.success(approve ? 'Deletion approved.' : 'Request rejected.')
      setNotes(n => { const next = { ...n }; delete next[id]; return next })
      await load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusyId(null)
    }
  }, [notes, load])

  const seg = (key: Scope, label: string) => {
    const active = scope === key
    return (
      <button
        onClick={() => setScope(key)}
        style={{
          padding: '6px 16px', border: 'none', cursor: 'pointer',
          fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: 'var(--font-sans)',
          background: active ? RED : 'transparent',
          color: active ? '#fff' : 'var(--txt2)',
          borderRadius: RADIUS.sm,
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <Page title="Mail Deletion Approvals" subtitle="Deleting a mail needs one other team member's approval">
      <div style={{ marginBottom: SP[4] }}>
        <div style={{
          display: 'inline-flex', gap: 2, padding: 3,
          background: 'var(--input-bg)', border: '1px solid var(--bdr)',
          borderRadius: RADIUS.md,
        }}>
          {seg('pending', 'Pending')}
          {seg('all', 'All')}
        </div>
      </div>

      <ErrBanner error={err} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div>
      ) : rows.length === 0 ? (
        <SectionCard>
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
            {scope === 'pending'
              ? 'No deletion requests awaiting approval.'
              : 'No deletion requests yet.'}
          </div>
        </SectionCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {rows.map(r => {
            const pending = (r.status ?? '').toLowerCase() === 'pending'
            const busy = busyId === r.id
            return (
              <div key={r.id} style={{
                background: 'var(--card)', border: '1px solid var(--bdr)',
                borderRadius: RADIUS.lg, padding: '16px 18px',
              }}>
                {/* header row */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
                        {r.ticket_ref}
                      </span>
                      <span style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                        {r.subject || '(no subject)'}
                      </span>
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
                      {r.customer_name || 'Unknown'}
                      {r.customer_email ? ` · ${r.customer_email}` : ''}
                      {r.channel ? ` · ${r.channel}` : ''}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0 }}>
                    <StatusBadge status={r.status} />
                  </div>
                </div>

                {/* requested-by line */}
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 10 }}>
                  Requested by <strong style={{ color: 'var(--txt)' }}>{r.requested_by_name}</strong>
                  {' · '}
                  <span title={fmtDatetime(r.created_at)}>{relTime(r.created_at)}</span>
                </div>

                {/* reason quote */}
                {r.reason && (
                  <div style={{
                    marginTop: 10, padding: '10px 14px',
                    borderLeft: `3px solid var(--bdr)`,
                    background: 'var(--row-hvr)', borderRadius: RADIUS.sm,
                    fontSize: TEXT.sm, color: 'var(--txt2)', fontStyle: 'italic', lineHeight: 1.5,
                  }}>
                    “{r.reason}”
                  </div>
                )}

                {pending ? (
                  <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={notes[r.id] ?? ''}
                      onChange={e => setNotes(n => ({ ...n, [r.id]: e.target.value }))}
                      placeholder="Add a note (optional)"
                      disabled={busy}
                      style={{
                        flex: 1, minWidth: 200, padding: '8px 12px',
                        borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
                        background: 'var(--input-bg)', color: 'var(--txt)',
                        fontSize: TEXT.sm, fontFamily: 'var(--font-sans)', outline: 'none',
                      }}
                    />
                    <button
                      onClick={() => decide(r.id, true)}
                      disabled={busy}
                      style={{ ...btnDanger, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>delete</span>
                      Approve deletion
                    </button>
                    <button
                      onClick={() => decide(r.id, false)}
                      disabled={busy}
                      style={{ ...btnSecondary, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: 12, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                    {r.decided_by_name
                      ? <>Decided by <strong style={{ color: 'var(--txt2)' }}>{r.decided_by_name}</strong>{r.decided_at ? ` · ${fmtDatetime(r.decided_at)}` : ''}</>
                      : 'Not yet decided'}
                    {r.decision_note && (
                      <span style={{ display: 'block', marginTop: 4, color: 'var(--txt2)', fontStyle: 'italic' }}>
                        “{r.decision_note}”
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Page>
  )
}
