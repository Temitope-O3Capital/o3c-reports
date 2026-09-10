import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtKobo } from '../../lib/fmt'
import { AMBER, NAVY, BLUE, NUM, TEXT, FW, SP, RADIUS, INTER } from '../../lib/design'
import { ELine } from '../../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MobileSummaryRow {
  active_users: number
  txn_count: number
  total_volume: number
  avg_txn_size: number
}

interface TrendRow {
  month: string
  active_users: number
  txn_count: number
}

interface MobileAppResponse {
  summary: MobileSummaryRow[]
  trend: TrendRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isStub(data: MobileAppResponse | null): boolean {
  if (!data) return true
  const s = data.summary?.[0]
  if (!s) return true
  return (
    (Number(s.active_users) === 0) &&
    (Number(s.txn_count) === 0) &&
    (Number(s.total_volume) === 0)
  )
}

function ComingSoonBanner() {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: SP[3],
      padding: SP[4], borderRadius: RADIUS.md,
      background: 'rgba(217,119,6,.08)', border: `1.5px solid ${AMBER}22`,
      marginBottom: SP[4],
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 22, color: AMBER, flexShrink: 0, marginTop: 1 }}>
        info
      </span>
      <div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER, marginBottom: 4, fontFamily: INTER }}>
          Live data not yet available
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
          The Mobile App Analytics module connects to your core banking system to derive active users
          and transaction activity. No transaction data was found for the selected period — this may
          indicate the integration is not yet configured or the database snapshot is empty.
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function MobileAppDashboard() {
  const [data,    setData]    = useState<MobileAppResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const res = await apiFetch<MobileAppResponse>('/api/mobile-app/summary')
      setData((res as any)?.data ?? res)
    } catch (e: any) {
      if (e.status === 404) {
        setData(null)
      } else {
        setErr(e.message ?? 'Failed to load')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true))

  const stub = isStub(data)
  const s = data?.summary?.[0]
  const trend = (data?.trend ?? []).slice().reverse()

  return (
    <Page
      title="Mobile App Analytics"
      subtitle="Active users and transaction activity derived from core banking (no dedicated mobile-app telemetry yet)"
      loading={loading && !data}
      skeletonKpis={4}
    >
      <ErrBanner error={err} onRetry={load} />

      {!loading && stub && <ComingSoonBanner />}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard
          label="Active Users"
          value={fmtNum(s?.active_users)}
          icon="person"
          loading={loading}
        />
        <KpiCard
          label="Transactions"
          value={fmtNum(s?.txn_count)}
          icon="receipt_long"
          loading={loading}
        />
        <KpiCard
          label="Total Volume"
          value={fmtKobo(s?.total_volume != null ? Number(s.total_volume) * 100 : null)}
          icon="payments"
          loading={loading}
          accent="#2563EB"
        />
        <KpiCard
          label="Avg Txn Size"
          value={fmtKobo(s?.avg_txn_size != null ? Number(s.avg_txn_size) * 100 : null)}
          icon="bar_chart"
          loading={loading}
        />
      </div>

      {/* Trend chart */}
      {trend.length > 0 && (
        <SectionCard title="Monthly Activity Trend" style={{ marginBottom: SP[4] }}>
          <ELine
            data={trend}
            xKey="month"
            height={240}
            endLabel
            hideYAxis
            valueFmt={(v) => fmtNum(v)}
            series={[
              { key: 'active_users', name: 'Active Users', color: NAVY },
              { key: 'txn_count', name: 'Transactions', color: BLUE },
            ]}
          />
        </SectionCard>
      )}

      {trend.length === 0 && !loading && (
        <SectionCard title="Monthly Activity Trend">
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: SP[8], color: 'var(--txt3)', fontSize: TEXT.sm, fontFamily: INTER,
          }}>
            No trend data available
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
