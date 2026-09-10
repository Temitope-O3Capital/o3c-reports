import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, DataTable, Modal, ConfirmModal, ErrBanner, Spinner, filterInputStyle,
  ExpandableFilterBar, NameCell, ActionRow,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { useFocusParam } from '../../hooks/useFocusParam'
import { fmtKoboExact, fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DebtSale {
  id: number
  buyer_name: string
  sale_date: string
  account_count: number
  face_value_kobo: number
  sale_price_kobo: number
  recovery_post_sale_kobo: number
  notes: string
  created_at: string
  status: string
  stage_label: string
  required_role: string
}

const FINAL_ROLE = 'cfo'
function getUser(): { role?: string } {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') } catch { return {} }
}

// The debt sale's position in the HOP → COO → CFO chain.
function StageBadge({ sale, mine }: { sale: DebtSale; mine: boolean }) {
  if (sale.status === 'approved') return <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${GREEN}1F`, color: GREEN }}>Approved</span>
  if (sale.status === 'rejected') return <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${RED}1F`, color: RED }}>Rejected</span>
  const color = mine ? GREEN : AMBER
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${color}1F`, color, whiteSpace: 'nowrap' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{mine ? 'how_to_reg' : 'schedule'}</span>
      {(sale.stage_label ?? '').replace('Awaiting ', '')}
    </span>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function recoveryRate(sale: DebtSale): number {
  if (!sale.sale_price_kobo) return 0
  return (sale.recovery_post_sale_kobo / sale.sale_price_kobo) * 100
}

function RateBadge({ pct }: { pct: number }) {
  const color = pct >= 80 ? GREEN : pct >= 50 ? AMBER : RED
  return (
    <span style={{
      ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 9px',
      borderRadius: RADIUS['2xl'], background: `${color}18`, color, whiteSpace: 'nowrap',
    }}>
      {pct.toFixed(1)}%
    </span>
  )
}

// ── Shared form styles ────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5,
}

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateModal({ open, onClose, onDone }: {
  open: boolean; onClose: () => void; onDone: () => void
}) {
  const [buyerName,    setBuyerName]    = useState('')
  const [saleDate,     setSaleDate]     = useState('')
  const [accountCount, setAccountCount] = useState('')
  const [faceValue,    setFaceValue]    = useState('')
  const [salePrice,    setSalePrice]    = useState('')
  const [notes,        setNotes]        = useState('')
  const [saving,       setSaving]       = useState(false)
  const [err,          setErr]          = useState<string | null>(null)

  function reset() {
    setBuyerName(''); setSaleDate(''); setAccountCount('')
    setFaceValue(''); setSalePrice(''); setNotes(''); setErr(null)
  }

  function handleClose() { reset(); onClose() }

  async function submit() {
    if (!buyerName.trim() || !saleDate) return
    setSaving(true); setErr(null)
    try {
      await apiPost('/api/recovery/debt-sales', {
        buyer_name: buyerName.trim(),
        sale_date: saleDate,
        account_count: accountCount ? Number(accountCount) : 0,
        face_value_kobo: faceValue ? Math.round(parseFloat(faceValue) * 100) : 0,
        sale_price_kobo: salePrice ? Math.round(parseFloat(salePrice) * 100) : 0,
        notes: notes.trim(),
      })
      toast.success('Debt sale submitted — pending approval')
      reset(); onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to record sale')
    } finally { setSaving(false) }
  }

  const canSubmit = buyerName.trim().length > 0 && saleDate.length > 0

  return (
    <Modal open={open} onClose={handleClose} title="Record Debt Sale" width={500}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />

        <div>
          <label style={labelStyle}>Buyer Name <span style={{ color: RED }}>*</span></label>
          <input value={buyerName} onChange={e => setBuyerName(e.target.value)}
            placeholder="e.g. Debt Recovery Partners Ltd"
            style={{ ...fieldStyle, height: 36 }} />
        </div>

        <div>
          <label style={labelStyle}>Sale Date <span style={{ color: RED }}>*</span></label>
          <input type="date" value={saleDate} onChange={e => setSaleDate(e.target.value)}
            style={{ ...fieldStyle, height: 36 }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={labelStyle}>Account Count</label>
            <input type="number" value={accountCount} onChange={e => setAccountCount(e.target.value)}
              placeholder="0" style={{ ...fieldStyle, height: 36 }} />
          </div>
          <div>
            <label style={labelStyle}>Face Value (₦)</label>
            <input type="number" value={faceValue} onChange={e => setFaceValue(e.target.value)}
              placeholder="0.00" style={{ ...fieldStyle, height: 36 }} />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Sale Price (₦)</label>
          <input type="number" value={salePrice} onChange={e => setSalePrice(e.target.value)}
            placeholder="0.00" style={{ ...fieldStyle, height: 36 }} />
        </div>

        <div>
          <label style={labelStyle}>Notes</label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} rows={3}
            placeholder="Additional notes…" style={{ ...fieldStyle, resize: 'vertical' }} />
        </div>

        <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
          <button
            onClick={submit}
            disabled={saving || !canSubmit}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 18px', borderRadius: RADIUS.md, border: 'none',
              background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: saving || !canSubmit ? 'not-allowed' : 'pointer',
              opacity: saving || !canSubmit ? 0.6 : 1,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            Record Sale
          </button>
          <button onClick={handleClose} style={{
            padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Table columns ─────────────────────────────────────────────────────────────

function makeCols(role: string, onApprove: (r: DebtSale) => void, onReject: (r: DebtSale) => void, onDelete: (id: number) => void): TableCol<DebtSale>[] {
  const canApprove = (r: DebtSale) => (role === r.required_role || role === 'admin') && r.status !== 'approved' && r.status !== 'rejected'
  return [
    { key: 'buyer_name', label: 'Buyer', render: r => <NameCell name={r.buyer_name} /> },
    { key: 'sale_date',  label: 'Sale Date', render: r => fmtDate(r.sale_date) },
    { key: 'sale_price_kobo', label: 'Sale Price', render: r => <span style={{ ...NUM, color: GREEN }}>{fmtKoboExact(r.sale_price_kobo)}</span> },
    { key: 'face_value_kobo', label: 'Face Value', render: r => <span style={NUM}>{fmtKoboExact(r.face_value_kobo)}</span> },
    { key: 'recovery_rate', label: 'Recovery Rate', render: r => <RateBadge pct={recoveryRate(r)} /> },
    { key: 'status', label: 'Approval Stage', render: r => <StageBadge sale={r} mine={role === r.required_role || role === 'admin'} /> },
    {
      key: 'actions', label: '', width: 116,
      render: r => (
        <ActionRow actions={[
          ...(canApprove(r) ? [
            { icon: 'check_circle', label: r.required_role === FINAL_ROLE ? 'Approve & post debt sale' : 'Approve — send to next approver', onClick: () => onApprove(r), danger: true },
            { icon: 'cancel',       label: 'Reject debt sale', onClick: () => onReject(r) },
          ] : []),
          { icon: 'delete', label: 'Delete', onClick: () => onDelete(r.id), danger: true },
        ]} />
      ),
    },
  ]
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DebtSales() {
  const role = getUser().role ?? ''
  const focus = useFocusParam()
  const [sales,       setSales]       = useState<DebtSale[]>([])
  const [loading,     setLoading]     = useState(true)
  const [err,         setErr]         = useState<string | null>(null)
  const [createOpen,  setCreateOpen]  = useState(false)
  const [deleteId,    setDeleteId]    = useState<number | null>(null)
  const [deleting,    setDeleting]    = useState(false)
  const [search,      setSearch]      = useState('')
  const [action,      setAction]      = useState<{ sale: DebtSale; type: 'approve' | 'reject' } | null>(null)
  const [acting,      setActing]      = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const res = await apiFetch<DebtSale[] | { data: DebtSale[] }>(`/api/recovery/debt-sales`)
      setSales(Array.isArray(res) ? res : (res as any).data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load debt sales')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['debt_sales', 'recovery'] })

  const displayed = useMemo(() => {
    if (!search.trim()) return sales
    const q = search.toLowerCase()
    return sales.filter(r =>
      [r.buyer_name, r.notes].some(v => v != null && String(v).toLowerCase().includes(q))
    )
  }, [sales, search])

  async function confirmDelete() {
    if (deleteId == null) return
    setDeleting(true)
    try {
      await apiDelete(`/api/recovery/debt-sales/${deleteId}`)
      toast.success('Debt sale deleted')
      setDeleteId(null); load()
    } catch (e: any) {
      toast.error(e.message ?? 'Delete failed')
    } finally { setDeleting(false) }
  }

  async function runAction() {
    if (!action) return
    setActing(true)
    try {
      if (action.type === 'approve') {
        await apiPut(`/api/recovery/debt-sales/${action.sale.id}/approve`, {})
        toast.success(action.sale.required_role === FINAL_ROLE ? 'Debt sale approved & posted' : 'Approved — sent to the next approver')
      } else {
        await apiPut(`/api/recovery/debt-sales/${action.sale.id}/reject`, { rejection_reason: 'Rejected on review' })
        toast.success('Debt sale rejected')
      }
      setAction(null); load()
    } catch (e: any) { toast.error(e.message ?? 'Action failed') }
    finally { setActing(false) }
  }

  // Summary totals
  const totalFaceValue  = sales.reduce((s, r) => s + r.face_value_kobo, 0)
  const totalSalePrice  = sales.reduce((s, r) => s + r.sale_price_kobo, 0)

  const cols = makeCols(role, r => setAction({ sale: r, type: 'approve' }), r => setAction({ sale: r, type: 'reject' }), id => setDeleteId(id))
  const isFinalAction = action?.type === 'approve' && action.sale.required_role === FINAL_ROLE

  return (
    <Page
      title="Debt Sales"
      subtitle="Portfolio of accounts sold to third-party buyers"
      loading={loading && sales.length === 0}
      skeletonKpis={3}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setCreateOpen(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: 'none',
              background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
            Record Sale
          </button>
        </div>
      }
    >
      {/* Summary strip */}
      <div style={{ display: 'flex', gap: SP[3], flexWrap: 'wrap', marginBottom: SP[5] }}>
        {[
          { label: 'Total Sales',       value: sales.length.toLocaleString(),  mono: false },
          { label: 'Total Face Value',  value: fmtKoboExact(totalFaceValue),        mono: true },
          { label: 'Total Sale Price',  value: fmtKoboExact(totalSalePrice),        mono: true },
        ].map(tile => (
          <div key={tile.label} style={{
            flex: 1, minWidth: 160, padding: '14px 16px',
            background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg,
          }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6 }}>
              {tile.label}
            </div>
            <div style={{ ...(tile.mono ? NUM : {}), fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', letterSpacing: '-0.4px' }}>
              {tile.value}
            </div>
          </div>
        ))}
      </div>

      {/* Error */}
      {err && <ErrBanner error={err} onRetry={load} />}

      {/* Table */}
      <SectionCard padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[]}
          onReset={() => setSearch('')}
          resultCount={displayed.length}
          totalCount={sales.length}
          placeholder="Search by buyer name or notes…"
        />
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10, color: 'var(--txt2)', fontSize: TEXT.md }}>
            <Spinner size={18} color={NAVY} /> Loading…
          </div>
        ) : (
          <DataTable<DebtSale>
            cols={cols}
            rows={displayed}
            keyFn={r => r.id}
            focusId={focus}
            emptyText="No debt sales recorded yet."
          />
        )}
      </SectionCard>

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); load() }}
      />

      <ConfirmModal
        open={deleteId != null}
        title="Delete Debt Sale"
        body="This will permanently delete this debt sale record. This action cannot be undone."
        confirmLabel="Delete"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setDeleteId(null)}
      />

      <ConfirmModal
        open={action != null}
        title={action?.type === 'approve' ? (isFinalAction ? 'Approve & Post Debt Sale' : 'Approve Debt Sale') : 'Reject Debt Sale'}
        body={action == null ? '' : action.type === 'approve'
          ? (isFinalAction
              ? `Final approval. This posts a GL entry of ${fmtKoboExact(action.sale.sale_price_kobo)} (Dr Cash / Cr Loan Receivable) for the sale to ${action.sale.buyer_name}. This cannot be undone.`
              : `Approve the debt sale to ${action.sale.buyer_name} and send it to the next approver in the chain?`)
          : `Reject the debt sale to ${action.sale.buyer_name}?`}
        confirmLabel={action?.type === 'approve' ? (isFinalAction ? 'Approve & Post' : 'Approve') : 'Reject'}
        danger={action?.type === 'approve' && isFinalAction}
        loading={acting}
        onConfirm={runAction}
        onClose={() => setAction(null)}
      />
    </Page>
  )
}
