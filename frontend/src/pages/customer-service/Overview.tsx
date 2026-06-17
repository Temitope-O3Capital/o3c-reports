import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, ErrBanner, Spinner,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'
import { apiFetch } from '../../lib/api'

/* ── Types ─────────────────────────────────────────────────────── */

interface CSKpis {
  calls_today: number
  open_tickets: number
  resolved_mtd: number
  avg_handle_minutes: number
}

/* ── Component ─────────────────────────────────────────────────── */

export default function CSOverview() {
  const [kpis, setKpis] = useState<CSKpis | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    setLoading(true)
    setErr('')
    apiFetch<{ data: CSKpis }>('/api/customer-service/overview')
      .then(res => setKpis(res.data ?? (res as any)))
      .catch((e: any) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  const k = kpis

  return (
    <Page
      dept="Customer Service"
      title="CS Overview"
      subtitle="Call centre activity and ticket management"
      actions={
        <button
          onClick={() => navigate('/customer-service/calls')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: NAVY, color: '#fff' }}
        >
          <span className="material-symbols-rounded text-[15px]">call</span>
          Log a Call
        </button>
      }
    >
      <ErrBanner msg={err} />

      {/* KPI row */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <KpiCard
          label="Calls Today"
          value={loading ? '—' : String(k?.calls_today ?? 0)}
          icon="call"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Open Tickets"
          value={loading ? '—' : String(k?.open_tickets ?? 0)}
          sub={(k?.open_tickets ?? 0) > 0 ? 'Require attention' : 'All clear'}
          icon="confirmation_number"
          accent={(k?.open_tickets ?? 0) > 0 ? RED : GREEN}
          loading={loading}
        />
        <KpiCard
          label="Resolved MTD"
          value={loading ? '—' : String(k?.resolved_mtd ?? 0)}
          sub="Last 30 days"
          icon="task_alt"
          accent={GREEN}
          loading={loading}
        />
        <KpiCard
          label="Avg Handle Time"
          value={loading ? '—' : `${Number(k?.avg_handle_minutes ?? 0).toFixed(1)}m`}
          sub="Per interaction"
          icon="timer"
          accent={AMBER}
          loading={loading}
        />
      </div>

      {/* Zoho integration status */}
      <SectionCard
        title="Zoho Integration"
        subtitle="Call centre API"
      >
        {loading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <div className="px-5 py-5 flex items-center gap-4">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: `${NAVY}12` }}
            >
              <span className="material-symbols-rounded text-[20px]" style={{ color: NAVY }}>
                hub
              </span>
            </div>
            <div>
              <p className="text-[14px] font-semibold text-slate-800">Zoho Voice is configured and active</p>
              <p className="text-[12px] text-slate-400 mt-0.5">
                Call logs are synced from Zoho Desk. Use the Call Log page to browse interactions and log manual calls.
              </p>
            </div>
            <div className="ml-auto flex-shrink-0">
              <span
                className="inline-flex items-center text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{ background: 'rgba(5,150,105,0.08)', color: GREEN }}
              >
                <span className="material-symbols-rounded text-[13px] mr-1">circle</span>
                Connected
              </span>
            </div>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
