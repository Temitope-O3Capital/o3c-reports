import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { fmtDate, fmtNum } from '../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef,
  KpiCard, ErrBanner, StatusBadge, NAVY, GREEN,
} from '../components/UI'

interface Campaign {
  id: number
  name: string
  type: 'sms' | 'email'
  status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'
  channel: string
  recipient_count: number
  sent_count: number
  delivered_count: number
  failed_count: number
  open_count: number
  scheduled_at: string | null
  started_at: string | null
  created_at: string
  created_by: string
}

interface WizardData {
  // Step 1 — Details
  name: string
  type: 'sms' | 'email'
  goal: string
  // Step 2 — Audience
  recipient_filter: string
  // Step 3 — Message
  message: string
  subject: string
  template_id: number | null
  // Step 4 — Schedule
  send_when: 'now' | 'later'
  scheduled_at: string
}

const EMPTY: WizardData = {
  name: '', type: 'sms', goal: '',
  recipient_filter: 'all',
  message: '', subject: '', template_id: null,
  send_when: 'now', scheduled_at: '',
}

const STEPS = ['Details', 'Audience', 'Message', 'Schedule', 'Review']

const AUDIENCE_OPTIONS = [
  { value: 'all',      label: 'All Active Customers',      desc: 'Everyone with an active account',           icon: 'group' },
  { value: 'overdue',  label: 'Overdue Borrowers',          desc: 'Customers with outstanding payments',       icon: 'warning' },
  { value: 'inactive', label: 'Inactive Cards (90d+)',       desc: 'Cards with no transactions in 90 days',    icon: 'credit_card_off' },
  { value: 'new',      label: 'New Customers (30d)',         desc: 'Customers who joined in the last 30 days', icon: 'person_add' },
]

const GOAL_OPTIONS = [
  { value: 'repayment',    label: 'Repayment Reminder' },
  { value: 'activation',   label: 'Card Activation' },
  { value: 'promotional',  label: 'Promotional Offer' },
  { value: 'reactivation', label: 'Re-engagement' },
  { value: 'other',        label: 'Other' },
]

/* ── Stepper ─────────────────────────────────────────────────────── */
function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center flex-1">
          <div className="flex flex-col items-center gap-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold transition-all"
              style={{
                background: i < step ? '#166534' : i === step ? NAVY : 'rgba(15,23,42,0.08)',
                color: i <= step ? '#fff' : '#94A3B8',
              }}
            >
              {i < step
                ? <span className="material-symbols-rounded text-[14px]">check</span>
                : i + 1}
            </div>
            <span
              className="text-[10px] font-semibold whitespace-nowrap"
              style={{ color: i === step ? '#0F172A' : '#94A3B8' }}
            >
              {label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div
              className="flex-1 h-0.5 mx-1 mt-[-12px]"
              style={{ background: i < step ? '#166534' : 'rgba(15,23,42,0.1)' }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

/* ── Field ─────────────────────────────────────────────────────────── */
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-[12px] font-semibold text-slate-600 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </div>
  )
}

const INPUT = 'w-full px-3 py-2 rounded-lg border text-[13px] outline-none focus:border-slate-400 transition-colors'
const IBRD  = { borderColor: 'rgba(15,23,42,0.15)' }

/* ── Wizard modal ─────────────────────────────────────────────────── */
function CampaignWizard({
  onClose,
  onDone,
}: { onClose: () => void; onDone: () => void }) {
  const [step, setStep]   = useState(0)
  const [data, setData]   = useState<WizardData>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [err, setErr]     = useState('')

  function set<K extends keyof WizardData>(k: K, v: WizardData[K]) {
    setData(d => ({ ...d, [k]: v }))
  }

  function canAdvance() {
    if (step === 0) return data.name.trim() !== ''
    if (step === 2) return data.message.trim() !== ''
    return true
  }

  async function submit() {
    setSaving(true); setErr('')
    try {
      await apiFetch('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          type: data.type,
          goal: data.goal,
          recipient_filter: data.recipient_filter,
          message: data.message,
          subject: data.subject,
          template_id: data.template_id,
          scheduled_at: data.send_when === 'later' ? data.scheduled_at : null,
        }),
      })
      onDone()
    } catch (e: any) { setErr(e.message) }
    finally { setSaving(false) }
  }

  const audience = AUDIENCE_OPTIONS.find(o => o.value === data.recipient_filter)!

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-10 px-4"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h3 className="text-[15px] font-semibold text-slate-800">New Campaign</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100">
            <span className="material-symbols-rounded text-[20px] text-slate-400">close</span>
          </button>
        </div>

        <div className="px-6 pt-6 pb-4">
          <Stepper step={step} />

          {err && <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-[12px]">{err}</div>}

          {/* ── Step 0: Details ── */}
          {step === 0 && (
            <div className="space-y-4">
              <Field label="Campaign Name" hint="Give it a clear internal name">
                <input
                  autoFocus
                  value={data.name}
                  onChange={e => set('name', e.target.value)}
                  placeholder="e.g. June Repayment Reminder"
                  className={INPUT} style={IBRD}
                />
              </Field>
              <Field label="Channel">
                <div className="grid grid-cols-2 gap-3">
                  {(['sms', 'email'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => set('type', t)}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all text-left"
                      style={{
                        borderColor: data.type === t ? NAVY : 'rgba(15,23,42,0.12)',
                        background: data.type === t ? 'rgba(14,40,65,0.04)' : '#fff',
                      }}
                    >
                      <span className="material-symbols-rounded text-[22px]" style={{ color: data.type === t ? NAVY : '#94A3B8' }}>
                        {t === 'sms' ? 'sms' : 'mail'}
                      </span>
                      <div>
                        <p className="text-[13px] font-semibold" style={{ color: data.type === t ? '#0F172A' : '#64748B' }}>
                          {t.toUpperCase()}
                        </p>
                        <p className="text-[11px] text-slate-400">{t === 'sms' ? 'Text message' : 'HTML email'}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Campaign Goal">
                <select value={data.goal} onChange={e => set('goal', e.target.value)} className={INPUT} style={IBRD}>
                  <option value="">Select a goal…</option>
                  {GOAL_OPTIONS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                </select>
              </Field>
            </div>
          )}

          {/* ── Step 1: Audience ── */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-[12px] text-slate-500 mb-1">Choose who receives this campaign.</p>
              {AUDIENCE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set('recipient_filter', opt.value)}
                  className="w-full flex items-center gap-4 px-4 py-3 rounded-xl border-2 transition-all text-left"
                  style={{
                    borderColor: data.recipient_filter === opt.value ? NAVY : 'rgba(15,23,42,0.12)',
                    background: data.recipient_filter === opt.value ? 'rgba(14,40,65,0.04)' : '#fff',
                  }}
                >
                  <span
                    className="material-symbols-rounded text-[22px] shrink-0"
                    style={{ color: data.recipient_filter === opt.value ? NAVY : '#94A3B8' }}
                  >{opt.icon}</span>
                  <div>
                    <p className="text-[13px] font-semibold text-slate-800">{opt.label}</p>
                    <p className="text-[11px] text-slate-400">{opt.desc}</p>
                  </div>
                  {data.recipient_filter === opt.value && (
                    <span className="material-symbols-rounded text-[18px] ml-auto" style={{ color: NAVY }}>check_circle</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* ── Step 2: Message ── */}
          {step === 2 && (
            <div className="space-y-4">
              {data.type === 'email' && (
                <Field label="Subject Line">
                  <input
                    value={data.subject}
                    onChange={e => set('subject', e.target.value)}
                    placeholder="e.g. Your payment is due soon"
                    className={INPUT} style={IBRD}
                  />
                </Field>
              )}
              <Field
                label={data.type === 'sms' ? 'Message' : 'Email Body'}
                hint={data.type === 'sms' ? `${data.message.length}/160 chars — keep concise` : 'Use {{first_name}} for personalisation'}
              >
                <textarea
                  value={data.message}
                  onChange={e => set('message', e.target.value)}
                  rows={6}
                  placeholder={
                    data.type === 'sms'
                      ? 'Dear {{first_name}}, your repayment of ₦{{amount}} is due on {{date}}. Pay now to avoid charges. Reply STOP to opt out.'
                      : 'Dear {{first_name}},\n\nWe wanted to remind you that your repayment is due.\n\nThank you,\nO3C Cards Team'
                  }
                  className={`${INPUT} resize-none`}
                  style={IBRD}
                />
              </Field>
              <div className="p-3 rounded-xl" style={{ background: 'rgba(14,40,65,0.04)' }}>
                <p className="text-[11px] font-semibold text-slate-600 mb-1.5">Available variables</p>
                <div className="flex flex-wrap gap-1.5">
                  {['first_name', 'last_name', 'amount', 'date', 'account_no'].map(v => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => set('message', data.message + `{{${v}}}`)}
                      className="text-[11px] font-mono px-2 py-0.5 rounded border transition-colors hover:bg-white"
                      style={{ borderColor: 'rgba(14,40,65,0.2)', color: '#334155' }}
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 3: Schedule ── */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {(['now', 'later'] as const).map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => set('send_when', opt)}
                    className="flex flex-col items-center gap-2 px-4 py-5 rounded-xl border-2 transition-all"
                    style={{
                      borderColor: data.send_when === opt ? NAVY : 'rgba(15,23,42,0.12)',
                      background: data.send_when === opt ? 'rgba(14,40,65,0.04)' : '#fff',
                    }}
                  >
                    <span
                      className="material-symbols-rounded text-[28px]"
                      style={{ color: data.send_when === opt ? NAVY : '#94A3B8' }}
                    >
                      {opt === 'now' ? 'send' : 'schedule_send'}
                    </span>
                    <p className="text-[13px] font-semibold" style={{ color: data.send_when === opt ? '#0F172A' : '#64748B' }}>
                      {opt === 'now' ? 'Send Immediately' : 'Schedule for Later'}
                    </p>
                    <p className="text-[11px] text-slate-400 text-center">
                      {opt === 'now' ? 'Campaign starts right after creation' : 'Pick a date and time to send'}
                    </p>
                  </button>
                ))}
              </div>
              {data.send_when === 'later' && (
                <Field label="Send Date & Time">
                  <input
                    type="datetime-local"
                    value={data.scheduled_at}
                    onChange={e => set('scheduled_at', e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    className={INPUT} style={IBRD}
                  />
                </Field>
              )}
            </div>
          )}

          {/* ── Step 4: Review ── */}
          {step === 4 && (
            <div className="space-y-3">
              <p className="text-[12px] text-slate-500">Review your campaign before launching.</p>
              <div className="rounded-xl border divide-y" style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
                {[
                  { label: 'Name',     value: data.name },
                  { label: 'Channel',  value: data.type.toUpperCase() },
                  { label: 'Goal',     value: GOAL_OPTIONS.find(g => g.value === data.goal)?.label || '—' },
                  { label: 'Audience', value: audience.label },
                  { label: 'Message',  value: data.message.slice(0, 80) + (data.message.length > 80 ? '…' : '') },
                  { label: 'Sending',  value: data.send_when === 'now' ? 'Immediately' : data.scheduled_at || '—' },
                ].map(row => (
                  <div key={row.label} className="flex gap-4 px-4 py-2.5">
                    <span className="text-[11px] font-semibold text-slate-400 w-20 shrink-0">{row.label}</span>
                    <span className="text-[12px] text-slate-700 break-words">{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer nav */}
        <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <button
            type="button"
            onClick={() => step === 0 ? onClose() : setStep(s => s - 1)}
            className="px-4 py-2 rounded-lg text-[13px] font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={!canAdvance()}
              onClick={() => setStep(s => s + 1)}
              className="px-5 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-40"
              style={{ background: NAVY }}
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              disabled={saving || data.message.trim() === ''}
              onClick={submit}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-40"
              style={{ background: '#166534' }}
            >
              <span className="material-symbols-rounded text-[15px]">rocket_launch</span>
              {saving ? 'Launching…' : 'Launch Campaign'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Main page ─────────────────────────────────────────────────────── */
export default function Campaigns() {
  const [campaigns, setCampaigns]       = useState<Campaign[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState('')
  const [typeFilter, setTypeFilter]     = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [wizardOpen, setWizardOpen]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params: Record<string, string> = {}
      if (typeFilter !== 'all') params.type = typeFilter
      if (statusFilter !== 'all') params.status = statusFilter
      const qs = new URLSearchParams(params).toString()
      const res = await apiFetch(`/api/campaigns${qs ? '?' + qs : ''}`)
      setCampaigns(Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [typeFilter, statusFilter])

  useEffect(() => { load() }, [load])

  async function handleAction(id: number, action: 'start' | 'pause' | 'cancel') {
    try {
      await apiFetch(`/api/campaigns/${id}/${action}`, { method: 'POST' })
      load()
    } catch (e: any) { setError(e.message) }
  }

  const totalSent      = campaigns.reduce((s, c) => s + (c.sent_count || 0), 0)
  const totalDelivered = campaigns.reduce((s, c) => s + (c.delivered_count || 0), 0)
  const active         = campaigns.filter(c => c.status === 'active').length

  const cols: ColDef<Campaign>[] = [
    { key: 'name',            label: 'Campaign' },
    { key: 'type', label: 'Channel', render: r => (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded"
          style={{ background: r.type === 'sms' ? 'rgba(14,40,65,0.07)' : 'rgba(37,99,235,0.08)', color: r.type === 'sms' ? '#475569' : '#1D4ED8' }}>
          <span className="material-symbols-rounded text-[11px]">{r.type === 'sms' ? 'sms' : 'mail'}</span>
          {r.type.toUpperCase()}
        </span>
      ),
    },
    { key: 'status',          label: 'Status',     render: r => <StatusBadge status={r.status} /> },
    { key: 'recipient_count', label: 'Recipients',  right: true, render: r => fmtNum(r.recipient_count) },
    { key: 'sent_count',      label: 'Sent',        right: true, render: r => fmtNum(r.sent_count)      },
    { key: 'delivered_count', label: 'Delivered',   right: true, render: r => fmtNum(r.delivered_count) },
    { key: 'open_count',      label: 'Opened',      right: true, render: r => fmtNum(r.open_count)      },
    { key: 'created_at',      label: 'Created',     render: r => fmtDate(r.created_at)                  },
    { key: '_actions', label: '', sortable: false, render: r => (
        <div className="flex gap-1">
          {r.status === 'draft'  && <ActionBtn icon="play_arrow" label="Start"  onClick={() => handleAction(r.id, 'start')}  color={GREEN} />}
          {r.status === 'active' && <ActionBtn icon="pause"      label="Pause"  onClick={() => handleAction(r.id, 'pause')}  color="#D97706" />}
          {r.status !== 'cancelled' && r.status !== 'completed' &&
            <ActionBtn icon="cancel" label="Cancel" onClick={() => handleAction(r.id, 'cancel')} color="#DC2626" />}
        </div>
      ),
    },
  ]

  return (
    <Page title="Campaigns" subtitle="SMS and email campaign management"
      actions={
        <div className="flex items-center gap-2">
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            <option value="all">All Types</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            {['all','draft','active','paused','completed','cancelled'].map(s => (
              <option key={s} value={s}>{s === 'all' ? 'All Status' : s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
          <button onClick={() => setWizardOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[14px]">add</span>New Campaign
          </button>
        </div>
      }>

      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Campaigns" value={String(campaigns.length)} icon="campaign"        accent={NAVY}    />
        <KpiCard loading={loading} label="Active"          value={String(active)}           icon="play_circle"    accent={GREEN}   />
        <KpiCard loading={loading} label="Total Sent"      value={fmtNum(totalSent)}        icon="send"           accent="#2563EB" />
        <KpiCard loading={loading} label="Delivered"       value={fmtNum(totalDelivered)}   icon="mark_email_read" accent="#059669" />
      </div>

      <SectionCard title="All Campaigns" badge={campaigns.length}>
        <DataTable cols={cols} rows={campaigns} loading={loading}
          emptyMsg="No campaigns yet — click New Campaign to get started" emptyIcon="campaign" />
      </SectionCard>

      {wizardOpen && (
        <CampaignWizard
          onClose={() => setWizardOpen(false)}
          onDone={() => { setWizardOpen(false); load() }}
        />
      )}
    </Page>
  )
}

function ActionBtn({ icon, label, onClick, color }: { icon: string; label: string; onClick: () => void; color: string }) {
  return (
    <button onClick={onClick} title={label}
      className="p-1 rounded transition-colors hover:bg-slate-100" style={{ color }}>
      <span className="material-symbols-rounded text-[15px]">{icon}</span>
    </button>
  )
}
