import { useEffect, useState, useCallback, useRef } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, FilterBar, filterInputStyle, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, getCsrfToken } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime, today, monthStart } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EODUpload {
  id: number
  upload_date: string
  filename: string
  loaded_at: string
  loaded_by_name: string
  row_count: number
  status: string
}

interface EODSummary {
  txn_count: number
  days_covered: number
  active_accounts: number
  active_cifs: number
  total_dr: number
  total_cr: number
  total_volume: number
  avg_txn_value: number
  net_movement: number
  branches: number
  products: number
}

interface ByProductRow {
  product_code: string
  product_name: string
  volume: number
  count: number
  dr: number
  cr: number
}

interface ByBranchRow {
  branch_code: string
  branch_name: string
  volume: number
  count: number
  active_accounts: number
}

// ── Table columns ─────────────────────────────────────────────────────────────

const UPLOAD_COLS: TableCol<EODUpload>[] = [
  { key: 'upload_date', label: 'Date', sortable: true, width: 110,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.upload_date)}</span> },
  { key: 'filename', label: 'File',
    render: r => <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260, fontSize: TEXT.sm, fontWeight: FW.medium }}>{r.filename}</span> },
  { key: 'row_count', label: 'Rows', align: 'right', sortable: true,
    render: r => <span style={NUM}>{r.row_count?.toLocaleString()}</span> },
  { key: 'loaded_by_name', label: 'Uploaded by',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.loaded_by_name || '—'}</span> },
  { key: 'loaded_at', label: 'Loaded at',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.loaded_at)}</span> },
]

const PRODUCT_COLS: TableCol<ByProductRow>[] = [
  { key: 'product_code', label: 'Code', render: r => <span style={NUM}>{r.product_code}</span> },
  { key: 'product_name', label: 'Product', sortable: true },
  { key: 'count', label: 'Txns', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.count)}</span> },
  { key: 'cr', label: 'Credits ₦', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtKobo(r.cr)}</span> },
  { key: 'dr', label: 'Debits ₦', align: 'right', sortable: true, render: r => <span style={{ ...NUM, color: RED, fontWeight: FW.semibold }}>{fmtKobo(r.dr)}</span> },
  { key: 'volume', label: 'Volume ₦', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.volume)}</span> },
]

const BRANCH_COLS: TableCol<ByBranchRow>[] = [
  { key: 'branch_code', label: 'Code', render: r => <span style={NUM}>{r.branch_code}</span> },
  { key: 'branch_name', label: 'Branch', sortable: true },
  { key: 'active_accounts', label: 'Accounts', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.active_accounts)}</span> },
  { key: 'count', label: 'Txns', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.count)}</span> },
  { key: 'volume', label: 'Volume ₦', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.volume)}</span> },
]

// ── Upload button ─────────────────────────────────────────────────────────────

function UploadButton({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    const form = new FormData()
    form.append('file', file)
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL || 'http://localhost:8000'}/api/eod/upload`, {
        method: 'POST', body: form, credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() },
      })
      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      toast.success('EOD file uploaded successfully')
      onUploaded()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} style={{ display: 'none' }} />
      <button onClick={() => inputRef.current?.click()} disabled={uploading} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 14px', borderRadius: RADIUS.md, border: 'none',
        background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
        cursor: uploading ? 'not-allowed' : 'pointer', opacity: uploading ? 0.7 : 1,
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>upload</span>
        {uploading ? 'Uploading…' : 'Upload EOD'}
      </button>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceEOD() {
  const [tab, setTab] = useState<'uploads' | 'product' | 'branch'>('uploads')
  const [uploads, setUploads] = useState<EODUpload[]>([])
  const [summary, setSummary] = useState<EODSummary | null>(null)
  const [byProduct, setByProduct] = useState<ByProductRow[]>([])
  const [byBranch, setByBranch] = useState<ByBranchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const qs = `date_from=${dateFrom}&date_to=${dateTo}`
    try {
      const [uploadsRes, sumRes, prodRes, branchRes] = await Promise.allSettled([
        apiFetch<{ data: EODUpload[] }>('/api/eod/uploads'),
        apiFetch<{ data: EODSummary }>(`/api/eod/summary?${qs}`),
        apiFetch<{ data: ByProductRow[] }>(`/api/eod/by-product?${qs}`),
        apiFetch<{ data: ByBranchRow[] }>(`/api/eod/by-branch?${qs}`),
      ])
      if (uploadsRes.status === 'fulfilled') setUploads(uploadsRes.value?.data ?? [])
      if (sumRes.status === 'fulfilled') setSummary(sumRes.value?.data ?? null)
      if (prodRes.status === 'fulfilled') setByProduct(prodRes.value?.data ?? [])
      if (branchRes.status === 'fulfilled') setByBranch(branchRes.value?.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  function exportUploadsCsv(data: EODUpload[]) {
    const header = ['Date', 'Filename', 'Rows', 'Uploaded By', 'Loaded At', 'Status']
    const lines = data.map(r => [
      r.upload_date ?? '',
      `"${String(r.filename ?? '').replace(/"/g, '""')}"`,
      r.row_count ?? 0,
      `"${String(r.loaded_by_name ?? '').replace(/"/g, '""')}"`,
      r.loaded_at ?? '',
      r.status ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `eod-uploads-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  function exportProductCsv(data: ByProductRow[]) {
    const header = ['Code', 'Product', 'Txns', 'Credits ₦', 'Debits ₦', 'Volume ₦']
    const lines = data.map(r => [
      r.product_code ?? '',
      `"${String(r.product_name ?? '').replace(/"/g, '""')}"`,
      r.count ?? 0,
      (r.cr / 100).toFixed(2),
      (r.dr / 100).toFixed(2),
      (r.volume / 100).toFixed(2),
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `eod-by-product-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  function exportBranchCsv(data: ByBranchRow[]) {
    const header = ['Code', 'Branch', 'Accounts', 'Txns', 'Volume ₦']
    const lines = data.map(r => [
      r.branch_code ?? '',
      `"${String(r.branch_name ?? '').replace(/"/g, '""')}"`,
      r.active_accounts ?? 0,
      r.count ?? 0,
      (r.volume / 100).toFixed(2),
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `eod-by-branch-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="EOD / EOB"
      subtitle={summary ? `${fmtNum(summary.active_accounts)} accounts · ${fmtNum(summary.txn_count)} transactions · ${summary.days_covered} days` : undefined}
      actions={<UploadButton onUploaded={load} />}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Total Volume" value={fmtKobo(summary?.total_volume ?? 0)} icon="swap_horiz" accent={NAVY} loading={loading} />
        <KpiCard label="Total Credits" value={fmtKobo(summary?.total_cr ?? 0)} icon="south_east" accent={GREEN} loading={loading} />
        <KpiCard label="Total Debits" value={fmtKobo(summary?.total_dr ?? 0)} icon="north_west" accent={RED} loading={loading} />
        <KpiCard label="Net Movement" value={fmtKobo(summary?.net_movement ?? 0)} icon="trending_up"
          accent={(summary?.net_movement ?? 0) >= 0 ? GREEN : RED} loading={loading} />
      </div>

      {/* Date filter */}
      <FilterBar onReset={() => { setDateFrom(monthStart()); setDateTo(today()) }}>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
        <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>Apply</button>
      </FilterBar>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--bdr)', marginBottom: SP[4] }}>
        {(['uploads', 'product', 'branch'] as const).map(t => {
          const labels: Record<string, string> = { uploads: 'Upload History', product: 'By Product', branch: 'By Branch' }
          const active = tab === t
          return (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '8px 14px', fontSize: TEXT.base, fontWeight: active ? FW.semibold : FW.medium,
              color: active ? 'var(--txt)' : 'var(--txt2)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: active ? `2px solid ${RED}` : '2px solid transparent',
              marginBottom: -1,
            }}>{labels[t]}</button>
          )
        })}
      </div>

      {tab === 'uploads' && (
        <SectionCard padding={false} actions={
          <button onClick={() => exportUploadsCsv(uploads)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            Export CSV
          </button>
        }>
          <DataTable
            cols={UPLOAD_COLS}
            rows={uploads}
            keyFn={r => r.id}
            loading={loading}
            emptyText="No EOD files uploaded yet"
            searchKeys={['filename', 'loaded_by_name', 'status']}
            searchPlaceholder="Search filename, uploader…"
            pageSize={20}
          />
        </SectionCard>
      )}

      {tab === 'product' && (
        <SectionCard padding={false} actions={
          <button onClick={() => exportProductCsv(byProduct)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            Export CSV
          </button>
        }>
          <DataTable
            cols={PRODUCT_COLS}
            rows={byProduct}
            keyFn={(r, i) => r.product_code ?? i}
            loading={loading}
            emptyText="No product breakdown available"
            searchKeys={['product_code', 'product_name']}
            searchPlaceholder="Search product…"
            pageSize={20}
          />
        </SectionCard>
      )}

      {tab === 'branch' && (
        <SectionCard padding={false} actions={
          <button onClick={() => exportBranchCsv(byBranch)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            Export CSV
          </button>
        }>
          <DataTable
            cols={BRANCH_COLS}
            rows={byBranch}
            keyFn={(r, i) => r.branch_code ?? i}
            loading={loading}
            emptyText="No branch breakdown available"
            searchKeys={['branch_code', 'branch_name']}
            searchPlaceholder="Search branch…"
            pageSize={20}
          />
        </SectionCard>
      )}
    </Page>
  )
}
