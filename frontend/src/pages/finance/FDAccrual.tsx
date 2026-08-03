import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate, today } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AccrualRow {
  id:                    number
  customer_name:         string
  principal:             number
  rate:                  number
  start_date:            string
  maturity_date:         string
  tenor_days:            number
  days_elapsed:          number
  accrued_interest_kobo: number
  daily_interest_kobo:   number
}

// ── Tile ──────────────────────────────────────────────────────────────────────

function Tile({ label, value, sub, colour }: { label: string; value: string | number; sub?: string; colour?: string }) {
  return (
    <div style={{
      flex: 1, minWidth: 140,
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}`,
    }}>
      <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: colour ?? 'var(--txt)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function FDAccrual() {
  const [rows,    setRows]    = useState<AccrualRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [asOf,    setAsOf]    = useState(today())

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: AccrualRow[] }>(`/api/finance/fd-accrual?date=${asOf}`)
      setRows(Array.isArray(res.data) ? res.data : Array.isArray(res) ? (res as any) : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [asOf])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['finance','manual_postings'] })

  const totalAccrued = rows.reduce((s, r) => s + Number(r.accrued_interest_kobo ?? 0), 0)
  const totalDaily   = rows.reduce((s, r) => s + Number(r.daily_interest_kobo ?? 0), 0)

  const cols: TableCol<AccrualRow>[] = [
    {
      key: 'customer_name', label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.customer_name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>FD #{r.id}</div>
        </div>
      ),
    },
    {
      key: 'principal', label: 'Principal', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.principal)}</span>,
    },
    {
      key: 'rate', label: 'Rate (% p.a.)', align: 'right',
      render: r => <span style={NUM}>{Number(r.rate).toFixed(2)}%</span>,
    },
    {
      key: 'start_date', label: 'Start Date',
      render: r => <span style={{ fontSize: TEXT.sm }}>{fmtDate(r.start_date)}</span>,
    },
    {
      key: 'maturity_date', label: 'Maturity',
      render: r => <span style={{ fontSize: TEXT.sm }}>{fmtDate(r.maturity_date)}</span>,
    },
    {
      key: 'days_elapsed', label: 'Days Elapsed', align: 'right',
      render: r => (
        <span style={{ ...NUM, color: Number(r.days_elapsed) > Number(r.tenor_days) * 0.8 ? AMBER : 'var(--txt2)' }}>
          {Number(r.days_elapsed)} / {Number(r.tenor_days)}
        </span>
      ),
    },
    {
      key: 'daily_interest_kobo', label: 'Daily Accrual', align: 'right',
      render: r => <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtKobo(r.daily_interest_kobo)}</span>,
    },
    {
      key: 'accrued_interest_kobo', label: 'Total Accrued', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontWeight: FW.bold, color: Number(r.accrued_interest_kobo) > 0 ? NAVY : 'var(--txt3)' }}>
          {fmtKobo(r.accrued_interest_kobo)}
        </span>
      ),
    },
  ]

  return (
    <Page
      title="FD Interest Accrual"
      subtitle="Accrued and daily interest across all active fixed deposits"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
            As of
          </label>
          <input
            type="date"
            value={asOf}
            onChange={e => setAsOf(e.target.value)}
            style={{
              padding: '5px 10px', borderRadius: RADIUS.md,
              border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
              color: 'var(--txt)', fontSize: TEXT.sm, cursor: 'pointer',
            }}
          />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'flex', gap: SP[3], marginBottom: SP[4], flexWrap: 'wrap' }}>
        <Tile
          label="Active FDs"
          value={loading ? '—' : rows.length}
          colour={NAVY}
        />
        <Tile
          label="Total Accrued Interest"
          value={loading ? '—' : fmtKobo(totalAccrued)}
          colour={GREEN}
          sub={`as of ${asOf}`}
        />
        <Tile
          label="Daily Interest Burn"
          value={loading ? '—' : fmtKobo(totalDaily)}
          colour={AMBER}
          sub="per day across all FDs"
        />
      </div>

      <SectionCard title="FD Accrual Detail" badge={rows.length} padding={false}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
            <Spinner size={28} />
          </div>
        ) : (
          <DataTable
            cols={cols}
            rows={rows}
            keyFn={r => r.id}
            loading={false}
            skeletonRows={8}
            pageSize={25}
            searchKeys={['customer_name']}
            searchPlaceholder="Search customer…"
            emptyText="No active fixed deposits"
          />
        )}
      </SectionCard>
    </Page>
  )
}
