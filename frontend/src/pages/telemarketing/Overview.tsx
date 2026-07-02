import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'

type Stats = {
  totals: { total_leads: number; converted: number; pending: number; callbacks: number; dnc_count: number; called_today: number }
  agents: { id: number; full_name: string; calls_made: number; conversions: number; calls_today: number }[]
  outcomes: { outcome: string; count: number }[]
}

const OUTCOME_LABELS: Record<string, string> = {
  interested: 'Interested', not_interested: 'Not Interested', callback: 'Callback',
  no_answer: 'No Answer', voicemail: 'Voicemail', dnc: 'DNC', converted: 'Converted',
}

export default function TelemarketingOverview() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/api/telemarketing/stats').then(r => r.json()).then(setStats).finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 32, color: 'var(--txt2)' }}>Loading…</div>
  if (!stats) return null

  const t = stats.totals
  const convRate = t.total_leads > 0 ? ((t.converted / t.total_leads) * 100).toFixed(1) : '0.0'

  return (
    <div style={{ padding: '24px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 24, color: 'var(--txt)' }}>Telemarketing Overview</h1>

      {/* KPI Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 16, marginBottom: 32 }}>
        {[
          { label: 'Total Leads', value: fmtNum(t.total_leads) },
          { label: 'Called Today', value: fmtNum(t.called_today) },
          { label: 'Callbacks Due', value: fmtNum(t.callbacks), warn: t.callbacks > 0 },
          { label: 'Converted', value: fmtNum(t.converted), good: true },
          { label: 'Conv. Rate', value: `${convRate}%`, good: true },
          { label: 'DNC', value: fmtNum(t.dnc_count) },
        ].map(k => (
          <div key={k.label} style={{
            background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12,
            padding: '16px 20px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: k.good ? '#16a34a' : k.warn ? '#d97706' : 'var(--txt)', fontFamily: 'DM Mono, monospace' }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Agent Performance */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: 'var(--txt)' }}>Agent Performance</h2>
          {stats.agents.length === 0 ? (
            <p style={{ color: 'var(--txt2)', fontSize: 14 }}>No call activity yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                  {['Agent', 'Today', 'Total Calls', 'Converted'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600, fontSize: 11, color: 'var(--txt2)', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.agents.map(a => (
                  <tr key={a.id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '8px', color: 'var(--txt)', fontWeight: 500 }}>{a.full_name}</td>
                    <td style={{ padding: '8px', color: 'var(--txt2)' }}>{a.calls_today}</td>
                    <td style={{ padding: '8px', color: 'var(--txt2)' }}>{a.calls_made}</td>
                    <td style={{ padding: '8px', color: '#16a34a', fontWeight: 600 }}>{a.conversions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Disposition Breakdown */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: 'var(--txt)' }}>Disposition Breakdown</h2>
          {stats.outcomes.length === 0 ? (
            <p style={{ color: 'var(--txt2)', fontSize: 14 }}>No dispositions logged yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stats.outcomes.map(o => {
                const total = stats.outcomes.reduce((s, x) => s + Number(x.count), 0)
                const pct = total > 0 ? (Number(o.count) / total) * 100 : 0
                return (
                  <div key={o.outcome}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                      <span style={{ color: 'var(--txt)', fontWeight: 500 }}>{OUTCOME_LABELS[o.outcome] ?? o.outcome}</span>
                      <span style={{ color: 'var(--txt2)', fontFamily: 'DM Mono, monospace' }}>{fmtNum(o.count)} ({pct.toFixed(1)}%)</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bdr)', borderRadius: 3 }}>
                      <div style={{ height: 6, width: `${pct}%`, background: o.outcome === 'converted' ? '#16a34a' : o.outcome === 'dnc' ? '#dc2626' : '#0E2841', borderRadius: 3 }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
