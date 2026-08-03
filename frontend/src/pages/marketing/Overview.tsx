import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts'
import { Page, KpiCard, SectionCard, StatusBadge, EmptyState, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { useLiveData } from '../../hooks/useRealtime'
import { fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, BLUE, GREEN, AMBER, RED, PURPLE, MONO, TEXT, FW, SP } from '../../lib/design'

interface Overview {
  campaigns: { total: number; active: number; scheduled: number; completed: number; draft: number; paused: number; cancelled: number }
  performance_all: Perf
  performance_30d: Perf
  channel_mix: { type: string; campaigns: number; sent: number }[]
  audience: { lists: number; contacts: number; segments: number }
  templates: { channel: string; count: number }[]
  templates_total: number
  recent_campaigns: { id: number; name: string; type: string; status: string; total_contacts: number; sent: number; opened: number; created_at: string }[]
}
interface Perf { sent: number; delivered: number; opened: number; clicked: number; open_rate: number; delivery_rate: number }

const CHANNEL_COLOR: Record<string, string> = { email: BLUE, sms: GREEN, whatsapp: '#25D366', multi: PURPLE }
const chColor = (t: string) => CHANNEL_COLOR[t] ?? NAVY
const pct = (n: number) => `${(n ?? 0).toFixed(1)}%`
const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s

export default function MarketingOverview() {
  const navigate = useNavigate()
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    try {
      const res = await apiFetch('/api/campaigns/overview')
      setData(unwrap<Overview>(res))
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['campaigns'] })

  const c = data?.campaigns
  const p30 = data?.performance_30d
  const aud = data?.audience
  const mix = (data?.channel_mix ?? []).filter(m => m.sent > 0 || m.campaigns > 0).map(m => ({ ...m, label: cap(m.type) }))

  const newBtn = (
    <button onClick={() => navigate('/campaigns')}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>campaign</span>
      Campaigns
    </button>
  )

  return (
    <Page title="Marketing" subtitle="Campaigns, audience and messaging performance" actions={newBtn}>
      {err && <ErrBanner error={err} onRetry={() => load()} />}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 16 }}>
        <div onClick={() => navigate('/campaigns')} style={{ cursor: 'pointer' }}>
          <KpiCard label="Campaigns" value={fmtNum(c?.total ?? 0)} icon="campaign" accent={NAVY}
            sub={c ? `${c.active} active · ${c.scheduled} scheduled` : undefined} loading={loading} />
        </div>
        <div onClick={() => navigate('/campaigns/lists')} style={{ cursor: 'pointer' }}>
          <KpiCard label="Contacts reached" value={fmtNum(aud?.contacts ?? 0)} icon="groups" accent={BLUE}
            sub={aud ? `${aud.lists} lists · ${aud.segments} segments` : undefined} loading={loading} />
        </div>
        <div onClick={() => navigate('/campaigns/templates')} style={{ cursor: 'pointer' }}>
          <KpiCard label="Templates" value={fmtNum(data?.templates_total ?? 0)} icon="dashboard_customize" accent={AMBER}
            sub={(data?.templates ?? []).map(t => `${t.count} ${t.channel}`).join(' · ') || 'None yet'} loading={loading} />
        </div>
        <KpiCard label="30-day open rate" value={p30 ? pct(p30.open_rate) : '—'} icon="drafts" accent={GREEN}
          sub={p30 ? `${fmtNum(p30.sent)} sent (30d)` : undefined} loading={loading} />
      </div>

      {/* Charts + status */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 14, marginBottom: 16 }}>
        <SectionCard title="Channel mix" subtitle="Messages sent by channel">
          {loading ? <ChartLoad /> : mix.length === 0 ? (
            <EmptyState icon="bar_chart" title="No sends yet" description="Channel volume appears once campaigns go out." />
          ) : (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={mix} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} allowDecimals={false} width={38} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'var(--row-hvr)' }} />
                <Bar dataKey="sent" name="Sent" radius={[6, 6, 0, 0]} maxBarSize={64}>
                  {mix.map((m, i) => <Cell key={i} fill={chColor(m.type)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        <SectionCard title="Campaign status" subtitle="Across all campaigns">
          {loading ? <ChartLoad /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { k: 'active', label: 'Active', color: GREEN },
                { k: 'scheduled', label: 'Scheduled', color: BLUE },
                { k: 'completed', label: 'Completed', color: NAVY },
                { k: 'draft', label: 'Draft', color: '#8A95A1' },
                { k: 'paused', label: 'Paused', color: AMBER },
                { k: 'cancelled', label: 'Cancelled', color: RED },
              ].map(row => {
                const v = (c as any)?.[row.k] ?? 0
                const total = c?.total || 1
                return (
                  <div key={row.k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', width: 78 }}>{row.label}</span>
                    <div style={{ flex: 1, height: 8, background: 'var(--bg)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(100, (v / total) * 100)}%`, height: '100%', background: row.color, borderRadius: 4 }} />
                    </div>
                    <span style={{ fontFamily: MONO, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', width: 34, textAlign: 'right' }}>{fmtNum(v)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {/* 30-day funnel */}
      <SectionCard title="Last 30 days" subtitle="Delivery funnel across all channels" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
          {[
            { label: 'Sent', value: p30?.sent ?? 0, color: NAVY },
            { label: 'Delivered', value: p30?.delivered ?? 0, color: GREEN, rate: p30?.delivery_rate },
            { label: 'Opened', value: p30?.opened ?? 0, color: BLUE, rate: p30?.open_rate },
            { label: 'Clicked', value: p30?.clicked ?? 0, color: PURPLE },
          ].map((m, i) => (
            <div key={i} style={{ padding: '10px 12px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--bg)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
                <span style={{ fontSize: 11, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px' }}>{m.label}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1.1 }}>{fmtNum(m.value)}</div>
              {m.rate !== undefined && <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>{pct(m.rate)}</div>}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Recent campaigns */}
      <SectionCard title="Recent campaigns" padding={false}
        actions={<button onClick={() => navigate('/campaigns')} style={{ fontSize: TEXT.sm, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', fontWeight: FW.semibold }}>View all</button>}>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : (data?.recent_campaigns ?? []).length === 0 ? (
          <div style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No campaigns yet</div>
        ) : (
          <div>
            {(data?.recent_campaigns ?? []).map(c => (
              <div key={c.id} onClick={() => navigate(`/campaigns/${c.id}/report`)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <span style={{ width: 8, height: 8, borderRadius: 3, background: chColor(c.type), flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || '(untitled)'}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>{cap(c.type)} · {fmtNum(c.total_contacts)} contacts · {fmtNum(c.sent)} sent</div>
                </div>
                <StatusBadge status={c.status} size="sm" />
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--txt3)', flexShrink: 0 }}>{fmtDate(c.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}

function ChartLoad() {
  return <div style={{ height: 230, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>
}
