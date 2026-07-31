import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, NUM, TEXT, FW, SP, RADIUS, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface StatusRow {
  status: string
  count: number
  product?: string
}

interface BlinkSummary {
  status_breakdown: StatusRow[]
  total_cards?: number
}

// ── Feature-in-progress card ──────────────────────────────────────────────────

function FeatureCard() {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: SP[4],
      padding: SP[5], borderRadius: RADIUS.lg,
      background: 'var(--card)', border: '1.5px solid var(--bdr)',
      marginBottom: SP[4],
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: RADIUS.md,
        background: `${NAVY}10`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 26, color: NAVY }}>credit_card</span>
      </div>
      <div>
        <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 6, fontFamily: INTER }}>
          Feature in progress
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6, fontFamily: INTER, maxWidth: 520 }}>
          The Blink Card virtual card issuing module is currently being built. Check back soon.
          This module will provide full lifecycle management for Blink virtual cards — issuance,
          activation, spending controls, and real-time transaction monitoring.
        </div>
      </div>
    </div>
  )
}

// ── Status breakdown table ─────────────────────────────────────────────────────

function StatusTable({ rows }: { rows: StatusRow[] }) {
  if (rows.length === 0) return null
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
        <thead>
          <tr style={{ background: 'var(--th-bg)', textAlign: 'left' }}>
            {rows[0].product !== undefined && (
              <th style={{ padding: '8px 12px', color: 'var(--txt2)', fontWeight: FW.semibold, fontFamily: INTER }}>Product</th>
            )}
            <th style={{ padding: '8px 12px', color: 'var(--txt2)', fontWeight: FW.semibold, fontFamily: INTER }}>Status</th>
            <th style={{ padding: '8px 12px', color: 'var(--txt2)', fontWeight: FW.semibold, textAlign: 'right', fontFamily: INTER }}>Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--bdr)' }}>
              {r.product !== undefined && (
                <td style={{ padding: '8px 12px', color: 'var(--txt)', fontFamily: INTER }}>{r.product ?? '—'}</td>
              )}
              <td style={{ padding: '8px 12px', color: 'var(--txt)', fontFamily: INTER }}>
                {r.status ?? '—'}
              </td>
              <td style={{ padding: '8px 12px', textAlign: 'right', ...NUM, fontWeight: FW.semibold }}>
                {fmtNum(r.count)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function BlinkCard() {
  const [summary, setSummary] = useState<BlinkSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)
  const [stub,    setStub]    = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<BlinkSummary>('/api/blink-card/summary')
      setSummary(res)
      // If the response has no rows or total is 0, treat as stub
      const rows = (res as any).status_breakdown as StatusRow[] | undefined
      const total = rows?.reduce((s, r) => s + Number(r.count ?? 0), 0) ?? 0
      setStub(total === 0)
    } catch (e: any) {
      if (e.status === 404) {
        setStub(true)
      } else {
        setErr(e.message ?? 'Failed to load')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load] )

  const rows: StatusRow[] = (summary as any)?.status_breakdown ?? []
  const total = rows.reduce((s, r) => s + Number(r.count ?? 0), 0)

  return (
    <Page
      title="Blink Card"
      subtitle="Virtual card issuing module — card accounts and status overview"
    >
      <ErrBanner error={err} onRetry={load} />

      <FeatureCard />

      {/* KPI strip — only shown when we have data */}
      {!stub && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
          <KpiCard
            label="Total Blink Cards"
            value={fmtNum(total)}
            icon="credit_card"
            loading={loading}
            accent={NAVY}
          />
          <KpiCard
            label="Active Cards"
            value={fmtNum(rows.find(r => /^active$/i.test(r.status ?? ''))?.count)}
            icon="check_circle"
            loading={loading}
            accent="#16A34A"
          />
          <KpiCard
            label="Inactive / Blocked"
            value={fmtNum(rows.filter(r => !/^active$/i.test(r.status ?? '')).reduce((s, r) => s + Number(r.count ?? 0), 0))}
            icon="block"
            loading={loading}
            accent="#C00000"
          />
        </div>
      )}

      {/* Status breakdown */}
      {!loading && rows.length > 0 && (
        <SectionCard title="Account Status Breakdown" badge={rows.length}>
          <StatusTable rows={rows} />
        </SectionCard>
      )}

      {!loading && rows.length === 0 && !err && (
        <SectionCard title="Account Status Breakdown">
          <div style={{
            padding: SP[8], textAlign: 'center',
            color: 'var(--txt3)', fontSize: TEXT.sm, fontFamily: INTER,
          }}>
            No card account data available yet.
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
