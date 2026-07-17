import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SettlementsOverview {
  settled_today_kobo: number
  pending_kobo: number
  failed_count: number
  success_rate_pct: number
  nip: {
    total: number
    matched: number
    unmatched: number
    exception_count: number
    exception_value_kobo: number
    reconciliation_rate_pct: number
  }
  paystack: {
    configured: boolean
    wallet_balance_kobo: number
    last_sync_at: string | null
    open_disputes: number
  }
  interswitch: {
    configured: boolean
  }
}

// ── Channel card ──────────────────────────────────────────────────────────────

function ChannelCard({ children, onClick, title, icon, statusDot, statusLabel, statusColor }: {
  children: React.ReactNode
  onClick: () => void
  title: string
  icon: string
  statusDot: string
  statusLabel: string
  statusColor: string
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--card)', border: '1px solid var(--card-bdr)',
        borderRadius: RADIUS.xl, padding: SP[5], cursor: 'pointer',
        transition: 'box-shadow 150ms',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: RADIUS.md, background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: NAVY }}>{icon}</span>
          </div>
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{title}</span>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold, color: statusColor }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
          {statusLabel}
        </span>
      </div>
      {children}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: SP[1], color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
        <span>View details</span>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>chevron_right</span>
      </div>
    </div>
  )
}

function StatRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{label}</span>
      <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: valueColor ?? 'var(--txt)' }}>{value}</span>
    </div>
  )
}

// ── Recent batches strip ───────────────────────────────────────────────────────

interface RecentBatch {
  id: number
  batch_ref: string
  batch_date: string
  txn_count: number
  total_amount_kobo: number
  status: string
}

function StatusDot({ status }: { status: string }) {
  const s = status.toLowerCase()
  const color = s === 'settled' ? GREEN : s === 'failed' ? RED : AMBER
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettlementsOverview() {
  const navigate = useNavigate()
  const [data, setData] = useState<SettlementsOverview | null>(null)
  const [batches, setBatches] = useState<RecentBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [ovRes, batchRes] = await Promise.all([
        apiFetch<SettlementsOverview>('/api/settlements/overview'),
        apiFetch<{ data: RecentBatch[] }>('/api/settlements?limit=5'),
      ])
      setData(ovRes)
      setBatches(batchRes.data ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const nip = data?.nip
  const ps = data?.paystack
  const sw = data?.interswitch
  const nipReconRate = nip ? Number(nip.reconciliation_rate_pct) : 0
  const nipColor = nipReconRate >= 99 ? GREEN : nipReconRate >= 95 ? AMBER : RED
  const psConfigured = ps?.configured ?? false

  return (
    <Page
      title="Settlements"
      subtitle="Daily settlement health across all payment channels"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Top KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[6] }}>
        <KpiCard label="Settled Today ₦" value={fmtKobo(data?.settled_today_kobo)} icon="check_circle" accent={GREEN} loading={loading && !data} />
        <KpiCard label="Pending ₦" value={fmtKobo(data?.pending_kobo)} icon="hourglass_empty" accent={AMBER} loading={loading && !data} />
        <KpiCard label="Failed Count" value={fmtNum(data?.failed_count)} icon="cancel" accent={RED} loading={loading && !data} />
        <KpiCard label="Success Rate" value={data ? `${Number(data.success_rate_pct).toFixed(1)}%` : '—'} icon="trending_up" accent={NAVY} loading={loading && !data} />
      </div>

      {/* Channel cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[4], marginBottom: SP[6] }}>

        {/* NIP */}
        <ChannelCard
          title="NIP Inflows"
          icon="compare_arrows"
          statusDot={nipColor}
          statusLabel={nipReconRate >= 99 ? 'Reconciled' : nipReconRate >= 95 ? 'Partial exceptions' : 'Exceptions pending'}
          statusColor={nipColor}
          onClick={() => navigate('/settlements/nip')}
        >
          {nip ? (
            <div>
              <StatRow label="Total entries today" value={fmtNum(nip.total)} />
              <StatRow label="Matched" value={fmtNum(nip.matched)} valueColor={GREEN} />
              <StatRow label="Unmatched" value={fmtNum(nip.unmatched)} valueColor={nip.unmatched > 0 ? AMBER : undefined} />
              <StatRow label="Exceptions" value={fmtNum(nip.exception_count)} valueColor={nip.exception_count > 0 ? RED : undefined} />
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: SP[1] }}>
                  <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>Reconciliation rate</span>
                  <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: nipColor }}>{nipReconRate.toFixed(1)}%</span>
                </div>
                <div style={{ height: 5, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${nipReconRate}%`, background: nipColor, borderRadius: 3, transition: 'width 0.5s ease' }} />
                </div>
              </div>
              {nip.exception_count > 0 && (
                <div style={{ marginTop: 10, padding: '7px 10px', borderRadius: RADIUS.md, background: 'rgba(192,0,0,0.06)', border: '1px solid rgba(192,0,0,0.12)', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: TEXT.sm, color: RED, fontWeight: FW.semibold }}>{nip.exception_count} open exceptions</span>
                  <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: RED }}>{fmtKobo(nip.exception_value_kobo)}</span>
                </div>
              )}
            </div>
          ) : (
            <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              {loading ? 'Loading…' : '—'}
            </div>
          )}
        </ChannelCard>

        {/* Paystack */}
        <ChannelCard
          title="Paystack"
          icon="payments"
          statusDot={psConfigured ? GREEN : AMBER}
          statusLabel={psConfigured ? 'Connected' : 'Not configured'}
          statusColor={psConfigured ? GREEN : AMBER}
          onClick={() => navigate('/settlements/reconciliation')}
        >
          {ps ? (
            <div>
              {psConfigured ? (
                <>
                  <StatRow label="Live wallet balance" value={fmtKobo(ps.wallet_balance_kobo)} />
                  <StatRow label="Open disputes" value={fmtNum(ps.open_disputes)} valueColor={ps.open_disputes > 0 ? AMBER : undefined} />
                  {ps.last_sync_at && (
                    <div style={{ marginTop: 10, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                      Last sync: {new Date(ps.last_sync_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                </>
              ) : (
                <div style={{ padding: '16px 0', textAlign: 'center' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: 'var(--txt3)', display: 'block', marginBottom: 6 }}>vpn_key</span>
                  <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0 }}>Set PAYSTACK_SECRET_KEY to activate</p>
                </div>
              )}
            </div>
          ) : (
            <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              {loading ? 'Loading…' : '—'}
            </div>
          )}
        </ChannelCard>

        {/* Interswitch */}
        <ChannelCard
          title="Interswitch"
          icon="account_balance"
          statusDot={sw?.configured ? GREEN : AMBER}
          statusLabel={sw?.configured ? 'Connected' : 'Awaiting credentials'}
          statusColor={sw?.configured ? GREEN : AMBER}
          onClick={() => navigate('/settlements/reconciliation')}
        >
          <div style={{ padding: '12px 0', textAlign: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: 'var(--txt3)', display: 'block', marginBottom: 6 }}>pending</span>
            <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0 }}>Web, POS &amp; ATM reconciliation pending merchant credentials</p>
          </div>
        </ChannelCard>
      </div>

      {/* Recent batches */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>Recent Batches</span>
          <button
            onClick={() => navigate('/settlements/batches')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, display: 'flex', alignItems: 'center', gap: 3 }}
          >
            View all <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>chevron_right</span>
          </button>
        </div>
        {batches.length === 0 ? (
          <div style={{ padding: '24px 18px', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
            {loading ? 'Loading…' : 'No recent batches'}
          </div>
        ) : (
          <div>
            {batches.slice(0, 5).map((b, i) => (
              <div key={b.id} style={{
                display: 'flex', alignItems: 'center', gap: SP[3], padding: '11px 18px',
                borderBottom: i < batches.length - 1 ? '1px solid var(--bdr)' : 'none',
              }}>
                <StatusDot status={b.status} />
                <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, flex: 1 }}>{b.batch_ref}</span>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{b.batch_date}</span>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtNum(b.txn_count)} txns</span>
                <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, minWidth: 110, textAlign: 'right' }}>{fmtKobo(b.total_amount_kobo)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Page>
  )
}
