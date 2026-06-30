import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch, apiExport, API } from '../../lib/api'
import { fmt, fmtNum, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, ColDef,
  DateFilter, AreaChartCard, DonutCard, ExportBtn,
  ErrBanner, Sk, Spinner, StatusBadge, NAVY, RED,
} from '../../components/UI'

interface Cycle {
  id: number
  report_date: string
  uploaded_at: string
  uploaded_by: string
  types: string[]
  row_count: number
}

interface Account {
  cif: string
  name: string
  product: string
  interest: number
  charges: number
  balance: number
  loc: number
}

export default function Income() {
  const [from, setFrom]           = useState(monthStart())
  const [to, setTo]               = useState(today())
  const [summary, setSummary]     = useState<any>(null)
  const [byProduct, setByProduct] = useState<any[]>([])
  const [trend, setTrend]         = useState<any[]>([])
  const [cycles, setCycles]       = useState<Cycle[]>([])
  const [accounts, setAccounts]   = useState<Account[]>([])
  const [loading, setLoading]     = useState(true)
  const [accLoading, setAccLoading] = useState(false)
  const [error, setError]         = useState('')
  const [exporting, setExporting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [tab, setTab]             = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ date_from: from, date_to: to }).toString()
      const [rS, rBp, rTr, rCy] = await Promise.allSettled([
        apiFetch(`/api/income/summary?${qs}`),
        apiFetch(`/api/income/by-product?${qs}`),
        apiFetch('/api/income/trend'),
        apiFetch('/api/income/cycles'),
      ])
      if (rS.status === 'fulfilled') setSummary(rS.value.data ?? rS.value)
      if (rBp.status === 'fulfilled') setByProduct(rBp.value.data ?? rBp.value ?? [])
      if (rTr.status === 'fulfilled') setTrend(rTr.value.data ?? rTr.value ?? [])
      if (rCy.status === 'fulfilled') setCycles(rCy.value.data ?? rCy.value ?? [])
      if ([rS, rBp, rTr, rCy].every(r => r.status === 'rejected')) setError((rS as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  const loadAccounts = useCallback(async () => {
    setAccLoading(true)
    try {
      const qs = new URLSearchParams({ date_from: from, date_to: to }).toString()
      const res = await apiFetch(`/api/income/accounts?${qs}`)
      setAccounts(res.data ?? res ?? [])
    } catch { /* silent */ }
    finally { setAccLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === 2) loadAccounts() }, [tab, loadAccounts])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const form = new FormData()
      Array.from(files).forEach(f => form.append('files', f))
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}/api/income/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      })
      if (!res.ok) throw new Error('Upload failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function deleteCycle(id: number) {
    if (!confirm('Delete this cycle?')) return
    try {
      await apiFetch(`/api/income/cycles/${id}`, { method: 'DELETE' })
      setCycles(c => c.filter(x => x.id !== id))
    } catch (e: any) { setError(e.message) }
  }

  const s = summary ?? {}

  const TABS = ['Summary', 'Cycles', 'Accounts']

  const accountCols: ColDef<Account>[] = [
    { key: 'cif',      label: 'CIF' },
    { key: 'name',     label: 'Customer' },
    { key: 'product',  label: 'Product' },
    { key: 'interest', label: 'Interest', right: true, render: r => fmt(r.interest) },
    { key: 'charges',  label: 'Charges',  right: true, render: r => fmt(r.charges)  },
    { key: 'balance',  label: 'Balance',  right: true, render: r => fmt(r.balance)  },
    { key: 'loc',      label: 'LOC',      right: true, render: r => fmt(r.loc)      },
  ]

  return (
    <Page dept="Finance" title="Income" subtitle="Interest, charges and balance reporting"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium disabled:opacity-60"
            style={{ background: NAVY, color: '#fff', borderColor: NAVY }}>
            {uploading
              ? <><Spinner size={14} />Uploading…</>
              : <><span className="material-symbols-rounded text-[15px]">upload</span>Upload Cycles</>}
          </button>
          <input ref={fileRef} type="file" multiple accept=".txt,.csv" className="hidden" onChange={handleUpload} />
          <ExportBtn loading={exporting}
            onClick={async () => {
              setExporting(true)
              await apiExport(`/api/income/accounts/export?date_from=${from}&date_to=${to}`, 'income_accounts')
              setExporting(false)
            }} />
        </div>
      }>
      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Interest"   value={fmt(s.total_interest)}   icon="percent"       accent={NAVY} />
        <KpiCard loading={loading} label="Total Charges"    value={fmt(s.total_charges)}    icon="receipt"       accent={RED}  />
        <KpiCard loading={loading} label="Total Balance"    value={fmt(s.total_balance)}    icon="account_balance" accent="#059669" />
        <KpiCard loading={loading} label="Total LOC"        value={fmt(s.total_loc)}        icon="credit_card"   accent="#2563EB" />
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-5 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)}
            className="px-4 py-2.5 text-[13px] font-medium transition-colors"
            style={{
              borderBottom: tab === i ? `2px solid ${NAVY}` : '2px solid transparent',
              color: tab === i ? NAVY : '#64748B', marginBottom: '-1px',
            }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <AreaChartCard title="Income Trend" subtitle="Monthly interest + charges"
              data={trend} xKey="month" areaKey="total" currency height={220} loading={loading} />
          </div>
          <DonutCard title="By Product" data={byProduct} nameKey="product" valueKey="total" loading={loading} />
        </div>
      )}

      {tab === 1 && (
        <SectionCard title="Uploaded Cycles" subtitle="Income files processed" badge={cycles.length}
          actions={
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              className="flex items-center gap-1 text-[12px] font-medium px-2.5 py-1.5 rounded-lg"
              style={{ background: 'rgba(14,40,65,0.06)', color: NAVY }}>
              <span className="material-symbols-rounded text-[14px]">upload</span>Upload
            </button>
          }>
          {loading ? (
            <div className="p-5 space-y-3">{[...Array(4)].map((_, i) => <Sk key={i} />)}</div>
          ) : cycles.length === 0 ? (
            <div className="py-14 text-center">
              <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">upload_file</span>
              <p className="text-[13px] text-slate-400">No cycles uploaded yet. Click Upload Cycles to get started.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr style={{ background: NAVY }}>
                    {['Report Date', 'Types', 'Rows', 'Uploaded', 'By', ''].map(h => (
                      <th key={h} className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em]"
                        style={{ color: 'rgba(255,255,255,0.6)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cycles.map(c => (
                    <tr key={c.id} className="hover:bg-slate-50 transition-colors"
                      style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                      <td className="px-5 py-3 font-mono text-[12px]">{fmtDate(c.report_date)}</td>
                      <td className="px-5 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {(c.types || []).map(t => (
                            <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                              style={{ background: 'rgba(14,40,65,0.07)', color: '#475569' }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-3 font-mono text-right">{fmtNum(c.row_count)}</td>
                      <td className="px-5 py-3 text-slate-500">{fmtDate(c.uploaded_at)}</td>
                      <td className="px-5 py-3 text-slate-500">{c.uploaded_by}</td>
                      <td className="px-5 py-3">
                        <button onClick={() => deleteCycle(c.id)}
                          className="text-slate-400 hover:text-red-600 transition-colors p-1 rounded">
                          <span className="material-symbols-rounded text-[16px]">delete</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      {tab === 2 && (
        <SectionCard title="Account Detail" subtitle="Per-account income breakdown">
          <DataTable cols={accountCols} rows={accounts} loading={accLoading}
            emptyMsg="No accounts loaded" emptyIcon="person_search" />
        </SectionCard>
      )}
    </Page>
  )
}
