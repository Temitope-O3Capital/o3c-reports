import { useState, useEffect, useCallback, useMemo } from 'react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { SectionCard, KpiCard, Spinner, ErrBanner, Modal, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtDate, today } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, MONO, INTER, SORA, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { QAConfig, BAND_COLOR, qaBand } from '../../lib/qa'
import { toast } from 'sonner'

type Tab = 'dashboard' | 'evaluations' | 'coaching' | 'report' | 'settings'
const num = (v: any) => Number(v ?? 0) || 0
function scoreColor(s: number) { return BAND_COLOR[qaBand(s)] ?? NAVY }

function Pill({ text, color }: { text: string; color: string }) {
  return <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.full, background: `${color}18`, color, whiteSpace: 'nowrap' }}>{text}</span>
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard() {
  const [from, setFrom] = useState(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))
  const [to, setTo] = useState(today())
  const [d, setD] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try { setD(await apiFetch<any>(`/api/qa/stats?from=${from}&to=${to}`)) }
    catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { load() }, [load])

  const s = d?.summary ?? {}
  const evals = num(s.evaluations)
  const passRate = evals > 0 ? Math.round((num(s.passed) / evals) * 100) : 0
  const trend = useMemo(() => (d?.trend ?? []).map((t: any) => ({ day: (t.day || '').slice(5), score: num(t.avg_score) })), [d])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      </div>
      <ErrBanner error={err} onRetry={load} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3] }}>
        <KpiCard label="Evaluations" value={num(s.evaluations).toLocaleString()} icon="fact_check" accent={NAVY} loading={loading} sub={`${num(s.agents_evaluated)} agents`} />
        <KpiCard label="Avg QA Score" value={`${num(s.avg_score)}%`} icon="grade" accent={scoreColor(num(s.avg_score))} loading={loading} sub={qaBand(num(s.avg_score))} />
        <KpiCard label="Pass Rate" value={`${passRate}%`} icon="check_circle" accent={GREEN} loading={loading} sub={`${num(s.passed)} passed`} />
        <KpiCard label="Failed" value={num(s.failed).toLocaleString()} icon="cancel" accent={RED} loading={loading} />
        <KpiCard label="Critical Errors" value={num(s.critical_errors).toLocaleString()} icon="report" accent={AMBER} loading={loading} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: SP[4] }}>
        <SectionCard title="Average QA Score" subtitle="Trend over the selected range">
          {trend.length === 0 ? <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)' }}>No evaluations in range</div> : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <defs><linearGradient id="qaG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={NAVY} stopOpacity={0.28} /><stop offset="100%" stopColor={NAVY} stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis domain={[0, 100]} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }} />
                <Area type="monotone" dataKey="score" name="Avg score" stroke={NAVY} strokeWidth={2.4} fill="url(#qaG)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
        <SectionCard title="Rating Distribution">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
            {['Outstanding', 'Excellent', 'Good', 'Fair', 'Needs Improvement'].map(band => {
              const row = (d?.by_band ?? []).find((b: any) => b.rating_band === band)
              const c = num(row?.count)
              const max = Math.max(1, ...(d?.by_band ?? []).map((b: any) => num(b.count)))
              return (
                <div key={band} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 116, fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.medium }}>{band}</span>
                  <div style={{ flex: 1, height: 16, background: 'var(--th-bg)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(c / max) * 100}%`, background: BAND_COLOR[band], borderRadius: 4, minWidth: c > 0 ? 4 : 0 }} />
                  </div>
                  <span style={{ ...NUM, width: 32, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{c}</span>
                </div>
              )
            })}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="By Agent" badge={(d?.by_agent ?? []).length} padding={false}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Agent', 'Evals', 'Avg Score', 'Pass', 'Critical'].map((h, i) => (
              <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '9px 16px', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {(d?.by_agent ?? []).length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 40, color: 'var(--txt2)' }}>No evaluations yet</td></tr>
              ) : (d?.by_agent ?? []).map((a: any) => {
                const avg = num(a.avg_score)
                return (
                  <tr key={a.agent_id || a.agent_name}>
                    <td style={{ padding: '10px 16px', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)' }}>{a.agent_name}</td>
                    <td style={{ ...NUM, padding: '10px 16px', textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{num(a.evaluations)}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}><span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(avg) }}>{avg}%</span></td>
                    <td style={{ ...NUM, padding: '10px 16px', textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{num(a.passed)}/{num(a.evaluations)}</td>
                    <td style={{ ...NUM, padding: '10px 16px', textAlign: 'right', fontSize: TEXT.sm, color: num(a.critical_errors) > 0 ? RED : 'var(--txt3)', borderBottom: '1px solid var(--bdr)' }}>{num(a.critical_errors)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  )
}

// ── Evaluations list + detail ────────────────────────────────────────────────
function EvalDetail({ id, config, onClose }: { id: number; config: QAConfig | null; onClose: () => void }) {
  const [e, setE] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => { apiFetch<any>(`/api/qa/evaluations/${id}`).then(setE).catch(() => {}).finally(() => setLoading(false)) }, [id])
  const scores = e?.scores ?? {}
  return (
    <Modal open onClose={onClose} title={`QA Scorecard`} width={640} maxHeight="88vh">
      {loading || !e ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={22} /></div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SORA }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
            <span style={{ ...NUM, fontSize: 30, fontWeight: FW.extrabold, color: scoreColor(num(e.total_score)) }}>{num(e.total_score)}%</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Pill text={e.rating_band} color={scoreColor(num(e.total_score))} />
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: e.passed ? GREEN : RED }}>{e.passed ? 'PASS' : 'FAIL'}{e.critical_error ? ' · Critical error' : ''}</span>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right', fontSize: TEXT.xs, color: 'var(--txt2)' }}>
              <div><b>{e.agent_name || '—'}</b></div>
              <div>by {e.evaluator_name} · {fmtDatetime(e.created_at)}</div>
            </div>
          </div>
          {config?.sections.map(sec => (
            <div key={sec.key}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{sec.label} · {sec.weight}%</div>
              {sec.params.map(p => {
                const sc = scores[p.param_key]
                const na = !sc || sc.na || sc.rating == null
                return (
                  <div key={p.param_key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--bdr)' }}>
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)' }}>{p.param_label}</span>
                    {sc?.comment && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontStyle: 'italic', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sc.comment}</span>}
                    <span style={{ ...NUM, width: 44, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.bold, color: na ? 'var(--txt3)' : NAVY }}>{na ? 'N/A' : `${sc.rating}/5`}</span>
                  </div>
                )
              })}
            </div>
          ))}
          {(e.strengths || e.improvements || e.coaching_notes) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: `${AMBER}08`, border: `1px solid ${AMBER}30`, borderRadius: RADIUS.md, fontSize: TEXT.sm }}>
              {e.strengths && <div><b style={{ color: GREEN }}>Strengths:</b> {e.strengths}</div>}
              {e.improvements && <div><b style={{ color: AMBER }}>Areas for improvement:</b> {e.improvements}</div>}
              {e.coaching_notes && <div><b style={{ color: NAVY }}>Coaching:</b> {e.coaching_notes}</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function Evaluations({ config }: { config: QAConfig | null }) {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const p = new URLSearchParams({ limit: '200' }); if (result) p.set('result', result); setRows(await apiFetch<any[]>(`/api/qa/evaluations?${p}`)) }
    catch { setRows([]) } finally { setLoading(false) }
  }, [result])
  useEffect(() => { load() }, [load])

  return (
    <SectionCard title="Evaluations" badge={rows.length} padding={false}
      actions={
        <select value={result} onChange={e => setResult(e.target.value)} style={{ height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)', cursor: 'pointer' }}>
          <option value="">All results</option><option value="pass">Passed</option><option value="fail">Failed</option>
        </select>
      }>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Date', 'Agent', 'Customer', 'Score', 'Result', 'Evaluator', ''].map((h, i) => (
            <th key={i} style={{ textAlign: i === 3 || i === 4 ? 'center' : 'left', padding: '9px 16px', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
          ))}</tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40 }}><Spinner size={18} /></td></tr>
              : rows.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: 'var(--txt2)' }}>No evaluations yet</td></tr>
              : rows.map(r => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} style={{ cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '10px 16px', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{fmtDate(r.created_at)}</td>
                  <td style={{ padding: '10px 16px', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)' }}>{r.agent_name || '—'}</td>
                  <td style={{ padding: '10px 16px', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{r.customer_name || 'Unknown'}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'center', borderBottom: '1px solid var(--bdr)' }}><span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(num(r.total_score)) }}>{num(r.total_score)}%</span></td>
                  <td style={{ padding: '10px 16px', textAlign: 'center', borderBottom: '1px solid var(--bdr)' }}>
                    <Pill text={r.passed ? 'Pass' : 'Fail'} color={r.passed ? GREEN : RED} />{r.critical_error ? <span title="Critical error" style={{ marginLeft: 4, color: RED }}>⚠</span> : null}
                  </td>
                  <td style={{ padding: '10px 16px', fontSize: TEXT.xs, color: 'var(--txt3)', borderBottom: '1px solid var(--bdr)' }}>{r.evaluator_name}</td>
                  <td style={{ padding: '10px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}><span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)' }}>chevron_right</span></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {openId && <EvalDetail id={openId} config={config} onClose={() => setOpenId(null)} />}
    </SectionCard>
  )
}

// ── Coaching tracker ─────────────────────────────────────────────────────────
function Coaching() {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('open')

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await apiFetch<any[]>(`/api/qa/coaching?status=${status}`)) } catch { setRows([]) } finally { setLoading(false) }
  }, [status])
  useEffect(() => { load() }, [load])

  async function toggle(id: number, done: boolean) {
    try { await apiFetch(`/api/qa/evaluations/${id}/coaching`, { method: 'PATCH', body: JSON.stringify({ coaching_status: done ? 'done' : 'open' }) }); toast.success(done ? 'Marked done' : 'Reopened'); load() }
    catch (e: any) { toast.error(e.message) }
  }

  return (
    <SectionCard title="Coaching Tracker" subtitle="Evaluations needing follow-up (failed, critical error, or with coaching notes)" badge={rows.length}
      actions={
        <div style={{ display: 'inline-flex', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 3 }}>
          {(['open', 'done'] as const).map(s => (
            <button key={s} onClick={() => setStatus(s)} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '4px 12px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer', textTransform: 'capitalize', background: status === s ? 'var(--card)' : 'transparent', color: status === s ? NAVY : 'var(--txt2)', boxShadow: status === s ? '0 1px 2px rgba(0,0,0,.08)' : 'none' }}>{s}</button>
          ))}
        </div>
      }>
      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}><Spinner size={20} /></div>
        : rows.length === 0 ? <div style={{ textAlign: 'center', padding: 34, color: 'var(--txt2)' }}>Nothing {status === 'open' ? 'open' : 'completed'}</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map(r => (
              <div key={r.id} style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '11px 14px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{r.agent_name || '—'}</span>
                    <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(num(r.total_score)) }}>{num(r.total_score)}%</span>
                    <Pill text={r.passed ? 'Pass' : 'Fail'} color={r.passed ? GREEN : RED} />
                    {r.critical_error && <Pill text="Critical" color={RED} />}
                  </div>
                  {r.improvements && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: 2 }}><b style={{ color: AMBER }}>Improve:</b> {r.improvements}</div>}
                  {r.coaching_notes && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}><b style={{ color: NAVY }}>Plan:</b> {r.coaching_notes}</div>}
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3 }}>{r.evaluator_name} · {fmtDate(r.created_at)}</div>
                </div>
                <button onClick={() => toggle(r.id, r.coaching_status !== 'done')}
                  style={{ flexShrink: 0, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '5px 12px', borderRadius: RADIUS.md, cursor: 'pointer', fontFamily: SORA,
                    border: `1px solid ${r.coaching_status === 'done' ? 'var(--bdr)' : GREEN + '50'}`, background: r.coaching_status === 'done' ? 'var(--card)' : `${GREEN}12`, color: r.coaching_status === 'done' ? 'var(--txt2)' : GREEN }}>
                  {r.coaching_status === 'done' ? 'Reopen' : 'Mark done'}
                </button>
              </div>
            ))}
          </div>
        )}
    </SectionCard>
  )
}

// ── Settings ─────────────────────────────────────────────────────────────────
function Settings({ config, onSaved }: { config: QAConfig | null; onSaved: () => void }) {
  const [secs, setSecs] = useState(config?.sections ?? [])
  const [pass, setPass] = useState(config?.settings.pass_threshold ?? 70)
  const [autoFail, setAutoFail] = useState(config?.settings.critical_error_auto_fail ?? true)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (config) { setSecs(config.sections); setPass(config.settings.pass_threshold); setAutoFail(config.settings.critical_error_auto_fail) } }, [config])

  const totalWeight = secs.reduce((s, x) => s + num(x.weight), 0)

  function setWeight(k: string, w: number) { setSecs(s => s.map(sec => sec.key === k ? { ...sec, weight: w } : sec)) }
  function setPoints(pk: string, mp: number) { setSecs(s => s.map(sec => ({ ...sec, params: sec.params.map(p => p.param_key === pk ? { ...p, max_points: mp } : p) }))) }

  async function save() {
    setSaving(true)
    try {
      await apiFetch('/api/qa/config', {
        method: 'PUT',
        body: JSON.stringify({
          sections: secs.map(s => ({ key: s.key, weight: num(s.weight) })),
          params: secs.flatMap(s => s.params.map(p => ({ param_key: p.param_key, param_label: p.param_label, max_points: num(p.max_points) }))),
          settings: { pass_threshold: num(pass), critical_error_auto_fail: autoFail },
        }),
      })
      toast.success('QA settings saved')
      onSaved()
    } catch (e: any) { toast.error(e.message ?? 'Save failed') } finally { setSaving(false) }
  }

  const inp: React.CSSProperties = { width: 64, height: 30, padding: '0 8px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.sm, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)', textAlign: 'right', fontFamily: MONO }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <SectionCard title="Pass rule">
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm, color: 'var(--txt)' }}>
            Pass threshold <input type="number" min={0} max={100} value={pass} onChange={e => setPass(Number(e.target.value))} style={inp} /> %
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm, color: 'var(--txt)', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoFail} onChange={e => setAutoFail(e.target.checked)} style={{ accentColor: RED, width: 16, height: 16 }} />
            A critical error auto-fails the evaluation
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Section weights & parameter points"
        subtitle={`Section weights should total 100%, currently ${totalWeight}%`}
        actions={totalWeight !== 100 ? <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: AMBER }}>{totalWeight}% (not 100)</span> : <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: GREEN }}>✓ 100%</span>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {secs.map(sec => (
            <div key={sec.key} style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', background: `${NAVY}08` }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>{sec.label}</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)' }}>Weight <input type="number" min={0} max={100} value={sec.weight} onChange={e => setWeight(sec.key, Number(e.target.value))} style={inp} /> %</label>
              </div>
              <div style={{ padding: '2px 14px' }}>
                {sec.params.map((p, i) => (
                  <div key={p.param_key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: i < sec.params.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)' }}>{p.param_label}</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt3)' }}>points <input type="number" min={1} value={p.max_points} onChange={e => setPoints(p.param_key, Number(e.target.value))} style={{ ...inp, width: 54 }} /></label>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={save} disabled={saving} style={{ padding: '9px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: SORA }}>
            {saving && <Spinner size={13} color="#fff" />}Save Settings
          </button>
        </div>
      </SectionCard>
    </div>
  )
}

// ── Monthly report ───────────────────────────────────────────────────────────
function MonthlyReport() {
  const now = new Date()
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [d, setD] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const range = useMemo(() => {
    const [y, m] = month.split('-').map(Number)
    return { from: `${month}-01`, to: new Date(y, m, 0).toISOString().slice(0, 10) }
  }, [month])
  const load = useCallback(async () => {
    setLoading(true)
    try { setD(await apiFetch<any>(`/api/qa/stats?from=${range.from}&to=${range.to}`)) } catch { setD(null) } finally { setLoading(false) }
  }, [range])
  useEffect(() => { load() }, [load])

  const s = d?.summary ?? {}
  const evals = num(s.evaluations)
  const passRate = evals > 0 ? Math.round((num(s.passed) / evals) * 100) : 0


  const kpi = (label: string, value: string, color: string) => (
    <div style={{ padding: '12px 14px', borderRadius: RADIUS.lg, border: '1px solid var(--card-bdr)', background: 'var(--card)', boxShadow: 'var(--card-shadow)' }}>
      <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ ...NUM, fontSize: 22, fontWeight: FW.extrabold, color, marginTop: 4 }}>{value}</div>
    </div>
  )

  return (
    <SectionCard title="Monthly Report" subtitle="Per-month QA summary, exportable for records"
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={{ height: 32, padding: '0 8px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)' }} />
          </div>
      }>
      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={22} /></div>
        : evals === 0 ? <div style={{ textAlign: 'center', padding: 40, color: 'var(--txt2)' }}>No evaluations in {month}</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3] }}>
              {kpi('Evaluations', evals.toLocaleString(), NAVY)}
              {kpi('Avg Score', `${num(s.avg_score)}%`, scoreColor(num(s.avg_score)))}
              {kpi('Pass Rate', `${passRate}%`, GREEN)}
              {kpi('Failed', num(s.failed).toLocaleString(), RED)}
              {kpi('Critical Errors', num(s.critical_errors).toLocaleString(), AMBER)}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Agent', 'Evals', 'Avg Score', 'Passed', 'Critical'].map((h, i) => (
                  <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '9px 16px', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.04em', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
                ))}</tr></thead>
                <tbody>
                  {(d?.by_agent ?? []).map((a: any) => (
                    <tr key={a.agent_id || a.agent_name}>
                      <td style={{ padding: '9px 16px', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)' }}>{a.agent_name}</td>
                      <td style={{ ...NUM, padding: '9px 16px', textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{num(a.evaluations)}</td>
                      <td style={{ padding: '9px 16px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}><span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: scoreColor(num(a.avg_score)) }}>{num(a.avg_score)}%</span></td>
                      <td style={{ ...NUM, padding: '9px 16px', textAlign: 'right', fontSize: TEXT.sm, color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{num(a.passed)}/{num(a.evaluations)}</td>
                      <td style={{ ...NUM, padding: '9px 16px', textAlign: 'right', fontSize: TEXT.sm, color: num(a.critical_errors) > 0 ? RED : 'var(--txt3)', borderBottom: '1px solid var(--bdr)' }}>{num(a.critical_errors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </SectionCard>
  )
}

// ── Hub ──────────────────────────────────────────────────────────────────────
export default function QAHub() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [config, setConfig] = useState<QAConfig | null>(null)
  const loadConfig = useCallback(() => { apiFetch<QAConfig>('/api/qa/config').then(setConfig).catch(() => {}) }, [])
  useEffect(() => { loadConfig() }, [loadConfig])

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: 'dashboard', label: 'Dashboard', icon: 'monitoring' },
    { key: 'evaluations', label: 'Evaluations', icon: 'fact_check' },
    { key: 'coaching', label: 'Coaching', icon: 'school' },
    { key: 'report', label: 'Monthly Report', icon: 'summarize' },
    { key: 'settings', label: 'Settings', icon: 'tune' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--bdr)' }}>
        {tabs.map(t => {
          const on = tab === t.key
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', fontSize: TEXT.sm, fontWeight: on ? FW.bold : FW.medium, color: on ? NAVY : 'var(--txt2)', background: 'none', border: 'none', borderBottom: `2px solid ${on ? NAVY : 'transparent'}`, marginBottom: -1, cursor: 'pointer', fontFamily: SORA }}>
              <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{t.icon}</span>{t.label}
            </button>
          )
        })}
      </div>
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'evaluations' && <Evaluations config={config} />}
      {tab === 'coaching' && <Coaching />}
      {tab === 'report' && <MonthlyReport />}
      {tab === 'settings' && <Settings config={config} onSaved={loadConfig} />}
    </div>
  )
}
