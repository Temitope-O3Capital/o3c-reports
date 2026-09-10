import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, DataTable, Tabs, Button, Input, Modal, StatusBadge, EmptyState, ErrBanner, Spinner, Badge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EBarH, EDonut } from '../../components/echarts'
import { PreviewStudio } from '../../components/PreviewStudio'
import { apiFetch, apiPost, apiExport } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, PURPLE, TEXT, FW, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

interface QResult {
  id: number; qtype: string; label: string; scale_min: number; scale_max: number
  avg?: number; count?: number
  distribution?: { value: number; n: number }[]
  breakdown?: { value: string; n: number }[]
  answers?: { text: string; customer_name: string; customer_cif: string; submitted_at: string }[]
}
interface Results {
  survey: any
  summary: {
    responses: number; sent: number; response_rate: number | null; avg_overall: number | null
    nps: { score: number | null; promoters: number; passives: number; detractors: number; count: number }
  }
  questions: QResult[]
}

export default function SurveyResults() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [tab, setTab] = useState('summary')
  const [data, setData] = useState<Results | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ survey: any; questions: any[] } | null>(null)

  function openPreview() {
    apiFetch(`/api/surveys/${id}`).then((d: any) => setPreview({ survey: d.data.survey, questions: d.data.questions })).catch(e => toast.error(e.message))
  }
  async function duplicate() {
    try { const d: any = await apiPost(`/api/surveys/${id}/clone`, {}); toast.success('Survey duplicated'); nav(`/feedback/surveys/${d.data.id}/edit`) }
    catch (e: any) { toast.error(e.message) }
  }

  const load = useCallback(() => {
    setLoading(true)
    apiFetch(`/api/surveys/${id}/results`)
      .then((d: any) => setData(d.data))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [id])
  useEffect(load, [load])

  async function setStatus(status: string) {
    try { await apiPost(`/api/surveys/${id}/status`, { status }); toast.success(`Survey ${status}`); load() }
    catch (e: any) { toast.error(e.message) }
  }

  if (loading && !data) return <Page title="Survey"><div style={{ padding: 40, display: 'grid', placeItems: 'center' }}><Spinner /></div></Page>
  if (!data) return <Page title="Survey">{err && <ErrBanner error={err} />}</Page>

  const s = data.survey
  const sum = data.summary
  const nps = sum.nps

  return (
    <Page title={s.title} subtitle={`${s.category || 'General'}${s.department ? ` · ${s.department}` : ''}`} back={{ to: '/feedback', label: 'All surveys' }}
      actions={<>
        <StatusBadge status={s.status} />
        <Button variant="secondary" icon="visibility" onClick={openPreview}>Preview</Button>
        <Button variant="secondary" icon="content_copy" onClick={duplicate}>Duplicate</Button>
        {sum.responses > 0 && <Button variant="secondary" icon="download" onClick={() => apiExport(`/api/surveys/${id}/export`, { fallbackName: 'survey_responses.csv' }).catch(e => toast.error(e.message))}>Export</Button>}
        {s.status !== 'active' && <Button variant="secondary" icon="play_arrow" onClick={() => setStatus('active')}>Activate</Button>}
        {s.status === 'active' && <Button variant="secondary" icon="stop_circle" onClick={() => setStatus('closed')}>Close</Button>}
        <Button variant="secondary" icon="edit" onClick={() => nav(`/feedback/surveys/${id}/edit`)}>Edit</Button>
      </>}>

      {err && <ErrBanner error={err} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 16 }}>
        <KpiCard label="Responses" value={fmtNum(sum.responses)} icon="rate_review" accent={NAVY} />
        <KpiCard label="Sent" value={fmtNum(sum.sent)} icon="outgoing_mail" accent={PURPLE}
          sub={sum.response_rate != null ? `${Math.round(sum.response_rate)}% response rate` : 'not sent yet'} />
        <KpiCard label="Avg satisfaction" value={sum.avg_overall != null ? `${sum.avg_overall.toFixed(1)} / 10` : '—'} icon="sentiment_satisfied"
          accent={sum.avg_overall != null && sum.avg_overall >= 7 ? GREEN : AMBER} />
        <KpiCard label="Net Promoter Score" value={nps.score != null ? String(nps.score) : '—'} icon="recommend"
          accent={nps.score != null && nps.score >= 0 ? GREEN : RED} sub={`${nps.count} rated`} />
      </div>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'summary', label: 'Summary' },
        { key: 'responses', label: 'Responses', badge: sum.responses },
        { key: 'distribute', label: 'Distribute' },
      ]} />

      {tab === 'summary' && <SummaryTab data={data} />}
      {tab === 'responses' && <ResponsesTab id={id!} nav={nav} />}
      {tab === 'distribute' && <DistributeTab id={id!} onChange={load} />}

      <PreviewStudio open={!!preview} onClose={() => setPreview(null)} survey={preview?.survey ?? { title: s.title }} questions={preview?.questions ?? []} />
    </Page>
  )
}

// ── Summary ───────────────────────────────────────────────────────────────────
function SummaryTab({ data }: { data: Results }) {
  const nps = data.summary.nps
  const ratingQs = data.questions.filter(q => (q.qtype === 'rating') && q.count)
  const textQs = data.questions.filter(q => (q.qtype === 'long_text' || q.qtype === 'short_text') && q.answers?.length)
  const choiceQs = data.questions.filter(q => (q.qtype === 'single_choice' || q.qtype === 'multi_choice') && q.breakdown?.length)

  const ratingBars = ratingQs.map(q => ({ name: q.label.length > 42 ? q.label.slice(0, 40) + '…' : q.label, avg: Number((q.avg || 0).toFixed(2)) }))

  if (data.summary.responses === 0) {
    return <EmptyState icon="insights" title="No responses yet" description="Once customers start completing the survey, their ratings and comments appear here — and on each customer's 360 timeline." />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 16 }} className="fb-grid">
        {ratingBars.length > 0 && (
          <SectionCard title="Average rating by service area" subtitle="Scale of 1–10">
            <EBarH data={ratingBars} catKey="name" series={[{ key: 'avg', name: 'Average', color: NAVY }]}
              height={Math.max(180, ratingBars.length * 34)} valueFmt={v => `${v.toFixed(1)}`} axisFmt={v => String(v)} />
          </SectionCard>
        )}
        {nps.count > 0 && (
          <SectionCard title="Net Promoter Score">
            <div style={{ display: 'grid', placeItems: 'center', paddingTop: 6 }}>
              <EDonut
                data={[
                  { name: 'Promoters', v: nps.promoters },
                  { name: 'Passives', v: nps.passives },
                  { name: 'Detractors', v: nps.detractors },
                ]}
                valueKey="v" nameKey="name" size={170} legend
                colorFn={(_, i) => [GREEN, AMBER, RED][i]}
                centerValue={nps.score != null ? String(nps.score) : '—'} centerLabel="NPS" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: 4, fontSize: TEXT.xs }}>
              <NpsStat label="Promoters" n={nps.promoters} color={GREEN} />
              <NpsStat label="Passives" n={nps.passives} color={AMBER} />
              <NpsStat label="Detractors" n={nps.detractors} color={RED} />
            </div>
          </SectionCard>
        )}
      </div>

      {choiceQs.map(q => (
        <SectionCard key={q.id} title={q.label}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {q.breakdown!.map(b => {
              const total = q.breakdown!.reduce((a, x) => a + x.n, 0)
              const pct = total ? Math.round((b.n / total) * 100) : 0
              return (
                <div key={b.value}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, marginBottom: 3 }}>
                    <span style={{ color: 'var(--txt)' }}>{b.value}</span>
                    <span style={{ color: 'var(--txt2)', fontVariantNumeric: 'tabular-nums' }}>{b.n} · {pct}%</span>
                  </div>
                  <div style={{ height: 8, background: 'var(--th-bg)', borderRadius: 4 }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: NAVY, borderRadius: 4 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>
      ))}

      {textQs.map(q => (
        <SectionCard key={q.id} title={q.label} badge={q.answers!.length} padding={false}>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            {q.answers!.map((a, i) => (
              <div key={i} style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.55 }}>"{a.text}"</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 4 }}>
                  {a.customer_name || 'Anonymous'}{a.customer_cif ? ` · CIF ${a.customer_cif}` : ''} · {fmtDatetime(a.submitted_at)}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      ))}
    </div>
  )
}
function NpsStat({ label, n, color }: { label: string; n: number; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontWeight: FW.bold, color, fontSize: TEXT.md, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
      <div style={{ color: 'var(--txt2)' }}>{label}</div>
    </div>
  )
}

// ── Responses ─────────────────────────────────────────────────────────────────
function ResponsesTab({ id, nav }: { id: string; nav: (to: string) => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<{ response: any; answers: any[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    apiFetch(`/api/surveys/${id}/responses`).then((d: any) => setRows(d.data ?? [])).finally(() => setLoading(false))
  }, [id])

  function openDetail(rid: number) {
    setDetail(null); setDetailLoading(true)
    apiFetch(`/api/surveys/${id}/responses/${rid}`)
      .then((d: any) => setDetail(d.data))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }

  const cols: TableCol<any>[] = [
    { key: 'customer_name', label: 'Customer', render: r => <span style={{ fontWeight: FW.medium }}>{r.customer_name || 'Anonymous'}</span> },
    { key: 'customer_cif', label: 'CIF', width: 120, render: r => r.customer_cif ? <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--txt2)' }}>{r.customer_cif}</span> : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'overall_score', label: 'Overall', width: 100, align: 'right', render: r => r.overall_score == null ? '—' : <span style={{ fontWeight: FW.bold, color: r.overall_score >= 7 ? GREEN : r.overall_score >= 5 ? AMBER : RED }}>{r.overall_score.toFixed(1)}</span> },
    { key: 'nps_score', label: 'Recommend', width: 110, align: 'right', render: r => r.nps_score == null ? '—' : <Badge variant={r.nps_score >= 9 ? 'success' : r.nps_score >= 7 ? 'warning' : 'danger'}>{r.nps_score}/10</Badge> },
    { key: 'submitted_at', label: 'Submitted', width: 170, align: 'right', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDatetime(r.submitted_at)}</span> },
  ]

  return (
    <>
      <SectionCard title="Individual responses" badge={rows.length} padding={false}>
        {loading ? <div style={{ padding: 40, display: 'grid', placeItems: 'center' }}><Spinner /></div>
          : rows.length === 0 ? <EmptyState icon="inbox" title="No responses yet" />
            : <DataTable cols={cols} rows={rows} keyFn={r => r.id} pageSize={20}
              onRowClick={r => openDetail(r.id)} />}
      </SectionCard>

      <Modal open={detailLoading || !!detail} onClose={() => setDetail(null)} title="Response detail" width={560} maxHeight="86vh"
        footer={detail?.response?.customer_cif ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="secondary" icon="person" onClick={() => nav(`/customers/${detail!.response.customer_cif}`)}>Open Customer 360</Button>
          </div>
        ) : undefined}>
        {detailLoading || !detail ? (
          <div style={{ padding: 30, display: 'grid', placeItems: 'center' }}><Spinner /></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, paddingBottom: 12, borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>{detail.response.customer_name || 'Anonymous'}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                  {detail.response.customer_cif ? `CIF ${detail.response.customer_cif}` : 'no CIF'}{detail.response.customer_email ? ` · ${detail.response.customer_email}` : ''}
                </div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDatetime(detail.response.submitted_at)}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {detail.response.overall_score != null && <MiniStat label="Overall" value={`${detail.response.overall_score.toFixed(1)}/10`} color={detail.response.overall_score >= 7 ? GREEN : detail.response.overall_score >= 5 ? AMBER : RED} />}
                {detail.response.nps_score != null && <MiniStat label="Recommend" value={`${detail.response.nps_score}/10`} color={detail.response.nps_score >= 9 ? GREEN : detail.response.nps_score >= 7 ? AMBER : RED} />}
              </div>
            </div>
            {detail.answers.map((a: any) => (
              <div key={a.question_id}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)' }}>{a.label}</div>
                <div style={{ fontSize: TEXT.base, color: 'var(--txt)', marginTop: 2 }}>
                  {a.rating_value != null ? <strong>{a.rating_value}</strong>
                    : a.text_value ? `"${a.text_value}"`
                      : a.choice_value && a.choice_value !== '[]' ? String(a.choice_value).replace(/[[\]"]/g, '')
                        : <span style={{ color: 'var(--txt3)' }}>—</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}
function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '4px 10px', borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
      <div style={{ fontWeight: FW.bold, color, fontSize: TEXT.md }}>{value}</div>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{label}</div>
    </div>
  )
}

// ── Distribute ────────────────────────────────────────────────────────────────
function DistributeTab({ id, onChange }: { id: string; onChange: () => void }) {
  const [testEmail, setTestEmail] = useState('')
  const [testing, setTesting] = useState(false)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<any[]>([])
  const [picked, setPicked] = useState<Record<string, { cif: string; name: string; email: string }>>({})
  const [staging, setStaging] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)
  const [sends, setSends] = useState<{ by_status: { status: string; n: number }[]; recent: any[] } | null>(null)

  const loadSends = useCallback(() => {
    apiFetch(`/api/surveys/${id}/sends`).then((d: any) => setSends(d.data)).catch(() => {})
  }, [id])
  useEffect(loadSends, [loadSends])

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return }
    const t = setTimeout(() => {
      apiFetch(`/api/surveys/${id}/recipient-search?q=${encodeURIComponent(q)}`).then((d: any) => setFound(d.data ?? [])).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [q, id])

  async function testSend() {
    if (!testEmail.includes('@')) { toast.error('Enter a valid email'); return }
    setTesting(true)
    try { await apiPost(`/api/surveys/${id}/test-send`, { email: testEmail, name: 'Preview' }); toast.success(`Test sent to ${testEmail}`) }
    catch (e: any) { toast.error(e.message) }
    finally { setTesting(false) }
  }

  const pickedList = Object.values(picked)
  async function stage() {
    if (pickedList.length === 0) return
    setStaging(true)
    try {
      const d: any = await apiPost(`/api/surveys/${id}/recipients`, { recipients: pickedList })
      toast.success(`Staged ${d.data?.added ?? 0} recipient(s)`)
      setPicked({}); setQ(''); setFound([]); loadSends()
    } catch (e: any) { toast.error(e.message) } finally { setStaging(false) }
  }

  async function dispatch() {
    setDispatching(true)
    try {
      const d: any = await apiPost(`/api/surveys/${id}/dispatch`, {})
      toast.success(`Sending ${d.data?.queued ?? 0} invitation(s)`)
      setConfirmSend(false); loadSends(); onChange()
    } catch (e: any) { toast.error(e.message) } finally { setDispatching(false) }
  }

  const byStatus: Record<string, number> = {}
  sends?.by_status?.forEach(s => { byStatus[s.status] = s.n })
  const draftCount = byStatus['draft'] || 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionCard title="Send a test" subtitle="Email yourself a live copy to preview the invitation and the survey.">
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <Input label="Test email" placeholder="you@o3cards.com" value={testEmail} onChange={e => setTestEmail(e.target.value)} prefix="mail" />
          </div>
          <Button variant="secondary" icon="send" loading={testing} onClick={testSend}>Send test</Button>
        </div>
      </SectionCard>

      <SectionCard title="Add recipients" subtitle="Search customers with an email on file, then stage them for sending.">
        <Input placeholder="Search by name, CIF or email…" value={q} onChange={e => setQ(e.target.value)} prefix="search" />
        {found.length > 0 && (
          <div style={{ marginTop: 8, border: '1px solid var(--bdr)', borderRadius: RADIUS.md, maxHeight: 240, overflow: 'auto' }}>
            {found.map(c => (
              <button key={c.cif} onClick={() => setPicked(p => ({ ...p, [c.cif]: { cif: c.cif, name: c.full_name, email: c.email } }))}
                style={{ width: '100%', textAlign: 'left', padding: '9px 12px', borderBottom: '1px solid var(--bdr)', background: picked[c.cif] ? 'var(--th-bg)' : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span><span style={{ fontWeight: FW.medium, color: 'var(--txt)' }}>{c.full_name}</span> <span style={{ color: 'var(--txt2)', fontSize: TEXT.xs }}>· {c.email}</span></span>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: picked[c.cif] ? GREEN : 'var(--txt3)' }}>{picked[c.cif] ? 'check_circle' : 'add_circle'}</span>
              </button>
            ))}
          </div>
        )}
        {pickedList.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {pickedList.map(p => (
                <span key={p.cif} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: 20, padding: '3px 6px 3px 10px', fontSize: TEXT.xs }}>
                  {p.name}
                  <button onClick={() => setPicked(prev => { const n = { ...prev }; delete n[p.cif]; return n })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', display: 'grid', placeItems: 'center' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
                  </button>
                </span>
              ))}
            </div>
            <Button icon="group_add" loading={staging} onClick={stage}>Stage {pickedList.length} recipient{pickedList.length > 1 ? 's' : ''}</Button>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Distribution status">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          {['draft', 'queued', 'sent', 'opened', 'responded', 'failed'].map(st => (
            <div key={st} style={{ padding: '8px 14px', borderRadius: RADIUS.md, background: 'var(--th-bg)', minWidth: 90 }}>
              <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>{byStatus[st] || 0}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', textTransform: 'capitalize' }}>{st}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: `1px solid ${draftCount ? RED : 'var(--bdr)'}`, borderRadius: RADIUS.md, background: draftCount ? `${RED}08` : 'transparent' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 22, color: draftCount ? RED : 'var(--txt3)' }}>outgoing_mail</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
              {draftCount ? `${draftCount} recipient${draftCount > 1 ? 's' : ''} staged and ready to send` : 'No staged recipients'}
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>Nothing is emailed until you send. Each recipient gets a unique, one-time link.</div>
          </div>
          <Button icon="send" disabled={!draftCount} onClick={() => setConfirmSend(true)}>Send now</Button>
        </div>
      </SectionCard>

      <Modal open={confirmSend} onClose={() => setConfirmSend(false)} title="Send survey invitations" width={440}
        footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={() => setConfirmSend(false)}>Cancel</Button>
          <Button icon="send" loading={dispatching} onClick={dispatch}>Send to {draftCount}</Button>
        </div>}>
        <p style={{ margin: 0, fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6 }}>
          This will email the survey invitation to <strong>{draftCount}</strong> staged recipient{draftCount > 1 ? 's' : ''} from the O3 Capital branded mailbox. This action cannot be undone.
        </p>
      </Modal>
    </div>
  )
}
