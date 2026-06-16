import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { fmtDate, fmtNum, today } from '../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef,
  KpiCard, ErrBanner, StatusBadge, Sk, NAVY, RED, GREEN,
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

interface CreateForm {
  name: string; type: 'sms' | 'email'; message: string; recipient_filter: string
}

const EMPTY_FORM: CreateForm = { name: '', type: 'sms', message: '', recipient_filter: 'all' }

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [drawerOpen, setDrawerOpen]     = useState(false)
  const [form, setForm]           = useState<CreateForm>(EMPTY_FORM)
  const [saving, setSaving]       = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params: Record<string, string> = {}
      if (typeFilter !== 'all') params.type = typeFilter
      if (statusFilter !== 'all') params.status = statusFilter
      const qs = new URLSearchParams(params).toString()
      const res = await apiFetch(`/api/campaigns${qs ? '?' + qs : ''}`)
      setCampaigns(res.data ?? res ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [typeFilter, statusFilter])

  useEffect(() => { load() }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await apiFetch('/api/campaigns', { method: 'POST', body: JSON.stringify(form) })
      setDrawerOpen(false); setForm(EMPTY_FORM); load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

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
    { key: 'type',            label: 'Channel',   render: r => (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded"
          style={{ background: r.type === 'sms' ? 'rgba(14,40,65,0.07)' : 'rgba(37,99,235,0.08)', color: r.type === 'sms' ? '#475569' : '#1D4ED8' }}>
          <span className="material-symbols-rounded text-[11px]">{r.type === 'sms' ? 'sms' : 'mail'}</span>
          {r.type.toUpperCase()}
        </span>
      )},
    { key: 'status',          label: 'Status',    render: r => <StatusBadge status={r.status} /> },
    { key: 'recipient_count', label: 'Recipients', right: true, render: r => fmtNum(r.recipient_count) },
    { key: 'sent_count',      label: 'Sent',       right: true, render: r => fmtNum(r.sent_count)      },
    { key: 'delivered_count', label: 'Delivered',  right: true, render: r => fmtNum(r.delivered_count) },
    { key: 'open_count',      label: 'Opened',     right: true, render: r => fmtNum(r.open_count)      },
    { key: 'created_at',      label: 'Created',    render: r => fmtDate(r.created_at) },
    { key: '_actions',        label: '',           sortable: false, render: r => (
        <div className="flex gap-1">
          {r.status === 'draft'  && <ActionBtn icon="play_arrow" label="Start"  onClick={() => handleAction(r.id, 'start')}  color={GREEN} />}
          {r.status === 'active' && <ActionBtn icon="pause"      label="Pause"  onClick={() => handleAction(r.id, 'pause')}  color="#D97706" />}
          {r.status !== 'cancelled' && r.status !== 'completed' &&
            <ActionBtn icon="cancel" label="Cancel" onClick={() => handleAction(r.id, 'cancel')} color="#DC2626" />}
        </div>
      )},
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
          <button onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[14px]">add</span>New Campaign
          </button>
        </div>
      }>
      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Campaigns" value={String(campaigns.length)} icon="campaign"    accent={NAVY}  />
        <KpiCard loading={loading} label="Active"          value={String(active)}           icon="play_circle" accent={GREEN} />
        <KpiCard loading={loading} label="Total Sent"      value={fmtNum(totalSent)}        icon="send"        accent="#2563EB" />
        <KpiCard loading={loading} label="Delivered"       value={fmtNum(totalDelivered)}   icon="mark_email_read" accent="#059669" />
      </div>

      <SectionCard title="All Campaigns" badge={campaigns.length}>
        <DataTable cols={cols} rows={campaigns} loading={loading}
          emptyMsg="No campaigns yet" emptyIcon="campaign" />
      </SectionCard>

      {/* Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setDrawerOpen(false)}
          style={{ background: 'rgba(0,0,0,0.3)' }}>
          <div className="absolute right-0 top-0 h-full w-[400px] bg-white shadow-2xl overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="px-6 py-5 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-slate-800">New Campaign</h3>
                <button onClick={() => setDrawerOpen(false)}>
                  <span className="material-symbols-rounded text-[20px] text-slate-400">close</span>
                </button>
              </div>
            </div>
            <form className="px-6 py-5 space-y-4" onSubmit={handleCreate}>
              <Field label="Campaign Name">
                <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. June Repayment Reminder"
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
              </Field>
              <Field label="Channel">
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as 'sms' | 'email' }))}
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                </select>
              </Field>
              <Field label="Recipients">
                <select value={form.recipient_filter} onChange={e => setForm(f => ({ ...f, recipient_filter: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                  <option value="all">All Active Customers</option>
                  <option value="overdue">Overdue Borrowers</option>
                  <option value="inactive">Inactive Cards (90d+)</option>
                  <option value="new">New Customers (30d)</option>
                </select>
              </Field>
              <Field label="Message">
                <textarea required value={form.message}
                  onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                  rows={4} placeholder="Write your message…"
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-none"
                  style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
                {form.type === 'sms' && (
                  <p className="text-[11px] text-slate-400 mt-1">{form.message.length}/160 chars</p>
                )}
              </Field>
              <button type="submit" disabled={saving}
                className="w-full py-2.5 text-[13px] font-semibold text-white rounded-lg disabled:opacity-60"
                style={{ background: NAVY }}>
                {saving ? 'Creating…' : 'Create Campaign'}
              </button>
            </form>
          </div>
        </div>
      )}
    </Page>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-semibold text-slate-600 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function ActionBtn({ icon, label, onClick, color }: { icon: string; label: string; onClick: () => void; color: string }) {
  return (
    <button onClick={onClick} title={label}
      className="p-1 rounded transition-colors hover:bg-slate-100"
      style={{ color }}>
      <span className="material-symbols-rounded text-[15px]">{icon}</span>
    </button>
  )
}
