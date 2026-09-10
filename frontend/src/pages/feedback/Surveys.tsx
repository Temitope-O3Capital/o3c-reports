import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, DataTable, Modal, Button, Input, Textarea, StatusBadge, EmptyState, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, TEXT, FW, SP, RADIUS } from '../../lib/design'

interface SurveyRow {
  id: number
  title: string
  description: string
  category: string
  department: string
  status: string
  accent_color: string
  question_count: number
  sent_count: number
  response_count: number
  avg_score: number | null
  updated_at: string
}

const BLANK = {
  title: '', description: '', category: '', department: '',
  intro: 'Thank you for choosing O3 Capital. We value your feedback and use it to keep improving your experience. Please take a few minutes to complete this short survey.',
  thank_you: 'Thank you for taking the time to complete this survey. Your feedback helps us serve you better.',
  signoff_name: '', signoff_title: '', accent_color: '#C00000',
}

// Question shape matches the builder / PUT /questions payload.
interface TplQ { qtype: string; label: string; help_text?: string; required?: boolean; scale_min?: number; scale_max?: number; scale_min_label?: string; scale_max_label?: string; options?: string[] }
const rating = (label: string): TplQ => ({ qtype: 'rating', label, required: true, scale_min: 1, scale_max: 10, scale_min_label: 'Very Poor', scale_max_label: 'Excellent' })
const recommend: TplQ = { qtype: 'nps', label: 'How likely are you to recommend O3 Capital to a friend or colleague?', required: true, scale_min: 0, scale_max: 10, scale_min_label: 'Not at all likely', scale_max_label: 'Extremely likely' }

interface Template { key: string; name: string; desc: string; icon: string; accent: string; questions: TplQ[] }
const TEMPLATES: Template[] = [
  { key: 'blank', name: 'Blank', desc: 'Start from scratch', icon: 'draft', accent: '#C00000', questions: [] },
  {
    key: 'csat', name: 'Customer Satisfaction', desc: 'Rate key service areas + overall', icon: 'sentiment_satisfied', accent: '#C00000',
    questions: [
      { qtype: 'section', label: 'Service Evaluation', help_text: 'Rate each aspect from 1 (Very Poor) to 10 (Excellent).' },
      rating('Quality of customer service support'),
      rating('Professionalism and courtesy of staff'),
      rating('Responsiveness to inquiries and complaints'),
      rating('Reliability of our service'),
      rating('Overall satisfaction with O3 Capital'),
      { qtype: 'section', label: 'Overall Assessment' },
      recommend,
      { qtype: 'long_text', label: 'What did we do well, and where can we improve?' },
    ],
  },
  {
    key: 'nps', name: 'Net Promoter Score', desc: 'One recommend question + reason', icon: 'recommend', accent: '#0E2841',
    questions: [
      recommend,
      { qtype: 'long_text', label: "What's the main reason for your score?", required: true },
      { qtype: 'long_text', label: 'What one thing would make you more likely to recommend us?' },
    ],
  },
  {
    key: 'ces', name: 'Customer Effort', desc: 'How easy was it to get help?', icon: 'trending_flat', accent: '#0891B2',
    questions: [
      { qtype: 'rating', label: 'How easy was it to get your issue resolved?', required: true, scale_min: 1, scale_max: 7, scale_min_label: 'Very difficult', scale_max_label: 'Very easy' },
      { qtype: 'long_text', label: 'What made it easy or difficult?' },
    ],
  },
]

export default function Surveys() {
  const nav = useNavigate()
  const [rows, setRows] = useState<SurveyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ ...BLANK })
  const [tpl, setTpl] = useState('blank')
  const [saving, setSaving] = useState(false)

  function load() {
    setLoading(true)
    apiFetch('/api/surveys')
      .then((d: any) => setRows(d.data ?? []))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  async function create() {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      const template = TEMPLATES.find(t => t.key === tpl)
      const d: any = await apiPost('/api/surveys', form)
      const id = d.data?.id
      if (id && template && template.questions.length) {
        await apiPut(`/api/surveys/${id}/questions`, { questions: template.questions })
      }
      setShowNew(false)
      setForm({ ...BLANK }); setTpl('blank')
      if (id) nav(`/feedback/surveys/${id}/edit`)
      else load()
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const totalResponses = rows.reduce((a, r) => a + (r.response_count || 0), 0)
  const active = rows.filter(r => r.status === 'active').length
  const scored = rows.filter(r => r.avg_score != null)
  const avgSat = scored.length ? scored.reduce((a, r) => a + (r.avg_score || 0), 0) / scored.length : null

  const cols: TableCol<SurveyRow>[] = [
    {
      key: 'title', label: 'Survey', render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 8, height: 34, borderRadius: 4, background: r.accent_color || RED, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
              {r.category || 'General'}{r.department ? ` · ${r.department}` : ''} · {r.question_count} question{r.question_count !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'status', label: 'Status', width: 96, render: r => <StatusBadge status={r.status} /> },
    { key: 'sent_count', label: 'Sent', width: 80, align: 'right', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.sent_count)}</span> },
    { key: 'response_count', label: 'Responses', width: 100, align: 'right', render: r => <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: FW.semibold }}>{fmtNum(r.response_count)}</span> },
    {
      key: 'rate', label: 'Rate', width: 80, align: 'right', render: r => {
        const rate = r.sent_count ? Math.round((r.response_count / r.sent_count) * 100) : null
        return <span style={{ color: 'var(--txt2)', fontVariantNumeric: 'tabular-nums' }}>{rate == null ? '—' : `${rate}%`}</span>
      },
    },
    {
      key: 'avg_score', label: 'Avg score', width: 110, align: 'right', render: r =>
        r.avg_score == null ? <span style={{ color: 'var(--txt3)' }}>—</span> : (
          <span style={{ fontWeight: FW.bold, fontVariantNumeric: 'tabular-nums', color: r.avg_score >= 7 ? GREEN : r.avg_score >= 5 ? AMBER : RED }}>
            {r.avg_score.toFixed(1)}<span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}> / 10</span>
          </span>
        ),
    },
    { key: 'updated_at', label: 'Updated', width: 110, align: 'right', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtDate(r.updated_at)}</span> },
  ]

  return (
    <Page title="Customer Feedback" subtitle="Design surveys, send them to customers, and see the responses flow into the CRM"
      loading={loading && rows.length === 0}
      skeletonKpis={4}
      actions={<Button icon="add" onClick={() => setShowNew(true)}>New Survey</Button>}>

      {err && <ErrBanner error={err} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
        <KpiCard label="Surveys" value={fmtNum(rows.length)} icon="reviews" accent={NAVY} sub={`${active} active`} />
        <KpiCard label="Total responses" value={fmtNum(totalResponses)} icon="rate_review" accent={GREEN} />
        <KpiCard label="Avg satisfaction" value={avgSat == null ? '—' : `${avgSat.toFixed(1)} / 10`} icon="sentiment_satisfied" accent={avgSat != null && avgSat >= 7 ? GREEN : AMBER} />
        <KpiCard label="Active surveys" value={fmtNum(active)} icon="campaign" accent={RED} />
      </div>

      <SectionCard title="All surveys" badge={rows.length} padding={false}>
        {loading ? (
          <div style={{ padding: 40, display: 'grid', placeItems: 'center' }}><Spinner /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon="reviews" title="No surveys yet" description="Create your first customer feedback survey — start from a blank canvas or the seeded Card Services template."
            action={{ label: 'New Survey', icon: 'add', onClick: () => setShowNew(true) }} />
        ) : (
          <DataTable cols={cols} rows={rows} keyFn={r => r.id} onRowClick={r => nav(`/feedback/surveys/${r.id}`)} pageSize={15} />
        )}
      </SectionCard>

      <Modal open={showNew} onClose={() => setShowNew(false)} title="New survey" width={560}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button icon="arrow_forward" iconRight="arrow_forward" loading={saving} disabled={!form.title.trim()} onClick={create}>Create &amp; add questions</Button>
          </div>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Start from</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
              {TEMPLATES.map(t => {
                const on = tpl === t.key
                return (
                  <button key={t.key} onClick={() => { setTpl(t.key); setForm(f => ({ ...f, accent_color: t.accent })) }}
                    style={{ textAlign: 'left', padding: '11px 12px', borderRadius: RADIUS.lg, cursor: 'pointer',
                      border: `1.5px solid ${on ? t.accent : 'var(--bdr)'}`, background: on ? `${t.accent}0E` : 'var(--card)' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 20, color: on ? t.accent : 'var(--txt2)' }}>{t.icon}</span>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginTop: 4 }}>{t.name}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.35 }}>{t.desc}</div>
                  </button>
                )
              })}
            </div>
          </div>
          <Input label="Survey title" required placeholder="e.g. Card Services Customer Satisfaction Survey" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="Category" placeholder="card_services" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} />
            <Input label="Department" placeholder="Card Services" value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} />
          </div>
          <Textarea label="Intro message" hint="Shown at the top of the survey and email." rows={3} value={form.intro} onChange={e => setForm({ ...form, intro: e.target.value })} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="Sign-off name" placeholder="Folusho Atobatele" value={form.signoff_name} onChange={e => setForm({ ...form, signoff_name: e.target.value })} />
            <Input label="Sign-off title" placeholder="Head, Card Services" value={form.signoff_title} onChange={e => setForm({ ...form, signoff_title: e.target.value })} />
          </div>
          <Field label="Accent colour">
            <div style={{ display: 'flex', gap: 8 }}>
              {['#C00000', '#0E2841', '#16A34A', '#7C3AED', '#0891B2', '#D97706'].map(c => (
                <button key={c} onClick={() => setForm({ ...form, accent_color: c })}
                  style={{ width: 30, height: 30, borderRadius: 8, background: c, cursor: 'pointer', border: form.accent_color === c ? '2px solid var(--txt)' : '2px solid transparent', outline: form.accent_color === c ? `2px solid ${c}` : 'none' }} />
              ))}
            </div>
          </Field>
        </div>
      </Modal>
    </Page>
  )
}

// Local minimal Field (the UI Field is only exported bundled with inputs).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
      <label style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt2)' }}>{label}</label>
      {children}
    </div>
  )
}
