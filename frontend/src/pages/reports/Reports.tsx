import { snake } from '../../lib/labels'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiFetch, apiExport } from '../../lib/api'
import { today, monthStart } from '../../lib/fmt'
import { Page, SectionCard, DataTable, DateFilter, ColDef, ErrBanner, NAVY } from '../../components/UI'

/* ── Report catalogue ───────────────────────────────────────────── */
interface ReportDef {
  id:       string
  name:     string
  desc:     string
  freq:     string
  icon:     string
  endpoint: string
  hasCif?:  boolean
  csvOnly?: boolean
}

const GROUPS: { label: string; icon: string; accent: string; reports: ReportDef[] }[] = [
  {
    label: 'Financial Reports',
    icon:  'account_balance',
    accent: NAVY,
    reports: [
      {
        id: 'monthly-business', name: 'Monthly Business Report',
        desc: 'New accounts, disbursements, collections, recoveries, NPL grouped by product',
        freq: 'Monthly', icon: 'bar_chart_4_bars', endpoint: '/api/reports/monthly-business',
      },
      {
        id: 'loan-portfolio', name: 'Loan Portfolio Report',
        desc: 'All loans: status, outstanding, tenor, interest-rate distribution, top 10 by balance',
        freq: 'Monthly', icon: 'account_balance_wallet', endpoint: '/api/reports/loan-portfolio',
      },
      {
        id: 'settlement-recon', name: 'Settlement Reconciliation',
        desc: 'Approved disbursements vs repayments received — identifies open exposure',
        freq: 'Monthly', icon: 'compare_arrows', endpoint: '/api/reports/settlement-recon',
      },
      {
        id: 'npl-return', name: 'CBN NPL Return',
        desc: 'Loans by DPD bucket, NPL ratio, provisions and write-offs (CBN format)',
        freq: 'Monthly', icon: 'gavel', endpoint: '/api/reports/npl-return',
      },
    ],
  },
  {
    label: 'Operational Reports',
    icon:  'groups',
    accent: '#2563EB',
    reports: [
      {
        id: 'collections-performance', name: 'Collections Performance',
        desc: 'Agent contact attempts, PTP count, kept rate, ₦ collected vs target by DPD bucket',
        freq: 'Monthly', icon: 'payments', endpoint: '/api/reports/collections-performance',
      },
      {
        id: 'agent-performance', name: 'Agent Performance Report',
        desc: 'Daily KPI summary per agent: contacts, PTPs, collected amount, target achievement',
        freq: 'Monthly', icon: 'person_search', endpoint: '/api/reports/agent-performance',
      },
    ],
  },
  {
    label: 'Customer Reports',
    icon:  'manage_accounts',
    accent: '#059669',
    reports: [
      {
        id: 'customer-statement', name: 'Customer Statement',
        desc: 'Account details and 90-day transaction history for a specific CIF number',
        freq: 'On-demand', icon: 'receipt_long',
        endpoint: '/api/reports/customer-statement', hasCif: true,
      },
    ],
  },
  {
    label: 'Regulatory & Audit',
    icon:  'policy',
    accent: '#7C3AED',
    reports: [
      {
        id: 'audit-trail', name: 'Audit Trail Export',
        desc: 'Full platform audit log with actor, action, resource and IP — for compliance review',
        freq: 'On-demand', icon: 'history',
        endpoint: '/api/reports/audit-trail-export', csvOnly: true,
      },
    ],
  },
]

const FREQ_STYLE: Record<string, { bg: string; color: string }> = {
  Monthly:    { bg: 'rgba(14,40,65,0.07)',    color: '#475569' },
  Quarterly:  { bg: 'rgba(37,99,235,0.08)',   color: '#2563EB' },
  'On-demand':{ bg: 'rgba(217,119,6,0.08)',   color: '#D97706' },
}

/* ── Preview table ──────────────────────────────────────────────── */
function PreviewTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="text-[13px] text-slate-400 py-4 text-center">No data returned.</p>
  const keys = Object.keys(rows[0])
  const cols: ColDef<any>[] = keys.map(k => ({
    key: k,
    label: snake(k),
  }))
  return (
    <div className="mt-4 rounded-xl overflow-hidden border" style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
      <DataTable cols={cols} rows={rows} emptyMsg="Empty result" />
    </div>
  )
}

/* ── Generate modal ─────────────────────────────────────────────── */
function GenerateModal({ report, onClose }: { report: ReportDef; onClose: () => void }) {
  const [from,        setFrom]        = useState(monthStart())
  const [to,          setTo]          = useState(today())
  const [cif,         setCif]         = useState('')
  const [format,      setFormat]      = useState<'json' | 'csv'>(report.csvOnly ? 'csv' : 'json')
  const [loading,     setLoading]     = useState(false)
  const [previewRows, setPreviewRows] = useState<any[] | null>(null)
  const [error,       setError]       = useState('')

  async function generate() {
    setLoading(true); setError(''); setPreviewRows(null)
    try {
      const params = new URLSearchParams({ date_from: from, date_to: to, format })
      if (report.hasCif && cif.trim()) params.set('cif', cif.trim())

      if (format === 'csv') {
        await apiExport(`${report.endpoint}?${params}`, report.id)
        toast.success('Report downloaded.')
        onClose()
      } else {
        const res = await apiFetch(`${report.endpoint}?${params}`)
        const data = res.data ?? res
        const rows: any[] = Array.isArray(data) ? data : [data]
        setPreviewRows(rows)
        toast.success(`${rows.length} row(s) returned.`)
      }
    } catch (e: any) {
      setError(e.message)
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      style={{ background: 'rgba(0,0,0,0.35)' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(14,40,65,0.07)' }}>
              <span className="material-symbols-rounded text-[18px]" style={{ color: NAVY }}>{report.icon}</span>
            </div>
            <div>
              <h3 className="text-[15px] font-semibold text-slate-800">{report.name}</h3>
              <p className="text-[12px] text-slate-400">{report.desc}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 transition-colors">
            <span className="material-symbols-rounded text-[20px] text-slate-400">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <ErrBanner msg={error} />

          <div>
            <label className="block text-[12px] font-semibold text-slate-600 mb-2">Date Range</label>
            <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          </div>

          {report.hasCif && (
            <div>
              <label className="block text-[12px] font-semibold text-slate-600 mb-1.5">CIF Number</label>
              <input
                value={cif}
                onChange={e => setCif(e.target.value)}
                placeholder="e.g. 0001234"
                className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-slate-400 transition-colors"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }}
              />
            </div>
          )}

          {!report.csvOnly && (
            <div>
              <label className="block text-[12px] font-semibold text-slate-600 mb-2">Output Format</label>
              <div className="inline-flex rounded-lg border overflow-hidden" style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                {(['json', 'csv'] as const).map(f => (
                  <button key={f} onClick={() => setFormat(f)}
                    className="px-4 py-1.5 text-[12px] font-semibold transition-colors"
                    style={{
                      background: format === f ? NAVY : 'transparent',
                      color:      format === f ? '#fff' : '#64748B',
                    }}>
                    {f === 'json' ? 'JSON Preview' : 'CSV Download'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={generate}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold text-white transition-opacity disabled:opacity-60"
            style={{ background: NAVY }}>
            {loading
              ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Generating…</>
              : <><span className="material-symbols-rounded text-[16px]">
                  {format === 'csv' ? 'download' : 'table_view'}
                </span>Generate Report</>
            }
          </button>

          {previewRows !== null && (
            <div>
              <p className="text-[12px] font-semibold text-slate-500 mb-1">{previewRows.length} row(s) returned</p>
              <PreviewTable rows={previewRows} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Report card ────────────────────────────────────────────────── */
function ReportCard({ report, onGenerate }: { report: ReportDef; onGenerate: () => void }) {
  const freqStyle = FREQ_STYLE[report.freq] ?? FREQ_STYLE.Monthly
  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl border transition-all hover:shadow-md bg-white"
      style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
      <div className="flex items-start justify-between">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(14,40,65,0.07)' }}>
          <span className="material-symbols-rounded text-[18px]" style={{ color: NAVY }}>{report.icon}</span>
        </div>
        <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full"
          style={{ background: freqStyle.bg, color: freqStyle.color }}>
          {report.freq}
        </span>
      </div>
      <div className="flex-1">
        <p className="text-[13px] font-semibold text-slate-800 leading-snug">{report.name}</p>
        <p className="text-[12px] text-slate-400 mt-1 leading-relaxed">{report.desc}</p>
      </div>
      <button
        onClick={onGenerate}
        className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg text-[12px] font-semibold transition-colors"
        style={{ background: 'rgba(14,40,65,0.06)', color: NAVY }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(14,40,65,0.12)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(14,40,65,0.06)')}>
        <span className="material-symbols-rounded text-[14px]">play_arrow</span>
        Generate
      </button>
    </div>
  )
}

/* ── Page ───────────────────────────────────────────────────────── */
export default function Reports() {
  const [active, setActive] = useState<ReportDef | null>(null)

  const totalReports = GROUPS.reduce((s, g) => s + g.reports.length, 0)

  return (
    <Page
      dept="Platform"
      title="Standard Reports"
      subtitle={`${totalReports} reports across ${GROUPS.length} categories — generate, preview, and export`}>

      <div className="space-y-6">
        {GROUPS.map(group => (
          <SectionCard
            key={group.label}
            title={group.label}
            badge={group.reports.length}
            actions={
              <span className="material-symbols-rounded text-[18px]" style={{ color: group.accent }}>
                {group.icon}
              </span>
            }>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-5">
              {group.reports.map(r => (
                <ReportCard key={r.id} report={r} onGenerate={() => setActive(r)} />
              ))}
            </div>
          </SectionCard>
        ))}
      </div>

      {active && <GenerateModal report={active} onClose={() => setActive(null)} />}
    </Page>
  )
}
