import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'

type Stats = {
  pipeline: { stage: string; count: number; total_value_kobo: number }[]
  employers: { active: number; mou_signed: number; mou_expiring: number }
}

const STAGE_LABELS: Record<string, string> = {
  prospect: 'Prospect', qualified: 'Qualified', proposal: 'Proposal',
  negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
}
const STAGE_COLORS: Record<string, string> = {
  prospect: '#6b7280', qualified: '#2563eb', proposal: '#7c3aed',
  negotiation: '#d97706', won: '#16a34a', lost: '#dc2626',
}

export default function BDOverview() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/api/bd/stats').then(r => r.json()).then(setStats).finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 32, color: 'var(--txt-2)' }}>Loading…</div>
  if (!stats) return null

  const e = stats.employers
  const totalValue = stats.pipeline.reduce((s, p) => s + Number(p.total_value_kobo), 0)
  const wonValue = stats.pipeline.find(p => p.stage === 'won')?.total_value_kobo ?? 0

  return (
    <div style={{ padding: '24px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 24, color: 'var(--txt)' }}>Business Development</h1>

      {/* KPI Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 32 }}>
        {[
          { label: 'Pipeline Value', value: fmtKobo(totalValue), mono: true },
          { label: 'Won Value', value: fmtKobo(Number(wonValue)), mono: true, good: true },
          { label: 'Active Employers', value: fmtNum(e.active) },
          { label: 'MoU Signed', value: fmtNum(e.mou_signed), good: true },
          { label: 'MoU Expiring', value: fmtNum(e.mou_expiring), warn: e.mou_expiring > 0 },
        ].map(k => (
          <div key={k.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '16px 20px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt-2)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: k.mono ? 'DM Mono, monospace' : undefined, color: k.good ? '#16a34a' : k.warn ? '#d97706' : 'var(--txt)' }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Pipeline Funnel */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>Pipeline by Stage</h2>
        {stats.pipeline.length === 0 ? (
          <p style={{ color: 'var(--txt-2)', fontSize: 14 }}>No pipeline data yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {stats.pipeline.map(p => {
              const pct = totalValue > 0 ? (Number(p.total_value_kobo) / totalValue) * 100 : 0
              const color = STAGE_COLORS[p.stage] ?? '#6b7280'
              return (
                <div key={p.stage}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: 'var(--txt)' }}>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, marginRight: 8 }} />
                      {STAGE_LABELS[p.stage] ?? p.stage}
                    </span>
                    <span style={{ color: 'var(--txt-2)', fontFamily: 'DM Mono, monospace' }}>
                      {fmtNum(p.count)} leads · {fmtKobo(Number(p.total_value_kobo))}
                    </span>
                  </div>
                  <div style={{ height: 8, background: 'var(--bdr)', borderRadius: 4 }}>
                    <div style={{ height: 8, width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
