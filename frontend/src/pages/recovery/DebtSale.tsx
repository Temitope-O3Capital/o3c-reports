import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, Modal, ConfirmModal, ErrBanner, Spinner, filterInputStyle, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiDelete } from '../../lib/api'
import { fmtKobo, fmtDate, monthStart, today } from '../../lib/fmt'
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
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
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
      toast.success('Debt sale recorded')
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

function makeCols(onDelete: (id: number) => void): TableCol<DebtSale>[] {
  return [
    { key: 'buyer_name',    label: 'Buyer',        render: r => r.buyer_name },
    { key: 'sale_date',     label: 'Sale Date',    render: r => fmtDate(r.sale_date) },
    { key: 'account_count', label: 'Accounts',     render: r => <span style={NUM}>{r.account_count.toLocaleString()}</span> },
    {
      key: 'face_value_kobo', label: 'Face Value',
      render: r => <span style={NUM}>{fmtKobo(r.face_value_kobo)}</span>,
    },
    {
      key: 'sale_price_kobo', label: 'Sale Price',
      render: r => <span style={{ ...NUM, color: GREEN }}>{fmtKobo(r.sale_price_kobo)}</span>,
    },
    {
      key: 'recovery_post_sale_kobo', label: 'Post-Sale Recovery',
      render: r => <span style={NUM}>{fmtKobo(r.recovery_post_sale_kobo)}</span>,
    },
    {
      key: 'recovery_rate', label: 'Recovery Rate',
      render: r => <RateBadge pct={recoveryRate(r)} />,
    },
    {
      key: 'notes', label: 'Notes',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', maxWidth: 180, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.notes || '—'}</span>,
    },
    {
      key: 'actions', label: '',
      render: r => (
        <button
          onClick={() => onDelete(r.id)}
          style={{
            padding: '4px 10px', borderRadius: RADIUS.sm, border: `1px solid ${RED}30`,
            background: `${RED}0A`, color: RED, fontSize: TEXT.sm, fontWeight: FW.semibold,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>delete</span>
          Delete
        </button>
      ),
    },
  ]
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DebtSales() {
  const [sales,       setSales]       = useState<DebtSale[]>([])
  const [loading,     setLoading]     = useState(true)
  const [err,         setErr]         = useState<string | null>(null)
  const [createOpen,  setCreateOpen]  = useState(false)
  const [deleteId,    setDeleteId]    = useState<number | null>(null)
  const [deleting,    setDeleting]    = useState(false)
  const [dateFrom,    setDateFrom]    = useState(monthStart())
  const [dateTo,      setDateTo]      = useState(today())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const qs = `from=${dateFrom}&to=${dateTo}`
      const res = await apiFetch<DebtSale[] | { data: DebtSale[] }>(`/api/recovery/debt-sales?${qs}`)
      setSales(Array.isArray(res) ? res : (res as any).data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load debt sales')
    } finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

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

  // Summary totals
  const totalFaceValue  = sales.reduce((s, r) => s + r.face_value_kobo, 0)
  const totalSalePrice  = sales.reduce((s, r) => s + r.sale_price_kobo, 0)

  const cols = makeCols((id) => setDeleteId(id))

  return (
    <Page
      title="Debt Sales"
      subtitle="Portfolio of accounts sold to third-party buyers"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
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
          { label: 'Total Face Value',  value: fmtKobo(totalFaceValue),        mono: true },
          { label: 'Total Sale Price',  value: fmtKobo(totalSalePrice),        mono: true },
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
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10, color: 'var(--txt2)', fontSize: TEXT.md }}>
          <Spinner size={18} color={NAVY} /> Loading…
        </div>
      ) : (
        <SectionCard>
          <DataTable<DebtSale>
            cols={cols}
            rows={sales}
            keyFn={r => r.id}
            emptyText="No debt sales recorded yet."
            searchKeys={['buyer_name', 'notes']}
            searchPlaceholder="Search by buyer name or notes…"
          />
        </SectionCard>
      )}

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
    </Page>
  )
}
