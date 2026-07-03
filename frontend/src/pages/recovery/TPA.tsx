import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import {
  Page, SectionCard, DataTable, Modal, ConfirmModal, ErrBanner, Tabs,
  filterInputStyle, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../../lib/fmt'
import { BLUE, NAVY, RED, NUM, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TPAAgency {
  id: number
  name: string
  licence_no: string | null
  address: string | null
  commission_pct: number
  contact_name: string | null
  contact_phone: string | null
  accounts_assigned: number
  recovered_kobo: number
  commission_accrued_kobo: number
  active: boolean
}

interface TPAAccount {
  account_cif: string
  outstanding_kobo: number
  stage: string
  days_assigned: number
}

interface TPAPerformance {
  monthly: { month: string; amount_kobo: number }[]
  total_recovered_kobo: number
  success_rate_pct: number
}

// ── Shared field style ────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5,
}

// ── Custom dark tooltip ───────────────────────────────────────────────────────

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#0E2841', borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {label && (
        <div style={{
          fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)', fontFamily: INTER,
          marginBottom: 7, letterSpacing: .5, textTransform: 'uppercase',
        }}>
          {label}
        </div>
      )}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: INTER, ...NUM }}>
            {fmtKobo(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── TPA Agency Form ───────────────────────────────────────────────────────────

interface AgencyFormData {
  name: string
  licence_no: string
  address: string
  commission_pct: string
  contact_name: string
  contact_phone: string
}

const emptyForm = (): AgencyFormData => ({
  name: '', licence_no: '', address: '',
  commission_pct: '', contact_name: '', contact_phone: '',
})

function AgencyForm({
  initial,
  saving,
  err,
  onSubmit,
}: {
  initial?: AgencyFormData
  saving: boolean
  err: string | null
  onSubmit: (data: AgencyFormData) => void
}) {
  const [form, setForm] = useState<AgencyFormData>(initial ?? emptyForm())
  const set = (k: keyof AgencyFormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {err && <div style={{ fontSize: 12.5, color: RED, padding: '6px 10px', background: 'rgba(192,0,0,.06)', borderRadius: 6 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Agency Name *</label>
          <input value={form.name} onChange={set('name')} placeholder="Agency name" style={{ ...fieldStyle, height: 36 }} />
        </div>
        <div>
          <label style={labelStyle}>Licence Number</label>
          <input value={form.licence_no} onChange={set('licence_no')} placeholder="Licence #" style={{ ...fieldStyle, height: 36 }} />
        </div>
      </div>
      <div>
        <label style={labelStyle}>Address</label>
        <input value={form.address} onChange={set('address')} placeholder="Agency address" style={{ ...fieldStyle, height: 36 }} />
      </div>
      <div>
        <label style={labelStyle}>Commission % *</label>
        <input type="number" min="0" max="100" step="0.1" value={form.commission_pct} onChange={set('commission_pct')} placeholder="e.g. 15" style={{ ...fieldStyle, height: 36 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Contact Name</label>
          <input value={form.contact_name} onChange={set('contact_name')} placeholder="Contact person" style={{ ...fieldStyle, height: 36 }} />
        </div>
        <div>
          <label style={labelStyle}>Contact Phone</label>
          <input value={form.contact_phone} onChange={set('contact_phone')} placeholder="Phone number" style={{ ...fieldStyle, height: 36 }} />
        </div>
      </div>

      <button
        onClick={() => onSubmit(form)}
        disabled={!form.name.trim() || !form.commission_pct || saving}
        style={{
          ...btnPrimary,
          alignSelf: 'flex-start',
          opacity: !form.name.trim() || !form.commission_pct || saving ? 0.6 : 1,
          cursor: !form.name.trim() || !form.commission_pct || saving ? 'not-allowed' : 'pointer',
        }}
      >
        {saving ? 'Saving…' : 'Save Agency'}
      </button>
    </div>
  )
}

// ── TPA Detail Modal tabs ─────────────────────────────────────────────────────

const ACCOUNT_COLS: TableCol<TPAAccount>[] = [
  {
    key: 'account_cif',
    label: 'CIF',
    render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: NAVY }}>{r.account_cif}</span>,
  },
  {
    key: 'outstanding_kobo',
    label: 'Outstanding ₦',
    align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.outstanding_kobo)}</span>,
  },
  {
    key: 'stage',
    label: 'Stage',
    render: r => (
      <span style={{
        ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
        borderRadius: 20, background: 'rgba(14,40,65,.08)', color: NAVY,
        whiteSpace: 'nowrap',
      }}>
        {r.stage}
      </span>
    ),
  },
  {
    key: 'days_assigned',
    label: 'Days Assigned',
    align: 'right',
    render: r => <span style={{ ...NUM, fontSize: 13 }}>{fmtNum(r.days_assigned)}</span>,
  },
]

function TPADetailContent({ agency }: { agency: TPAAgency }) {
  const [tab, setTab] = useState('accounts')
  const [accounts, setAccounts] = useState<TPAAccount[]>([])
  const [performance, setPerformance] = useState<TPAPerformance | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    if (tab === 'accounts') {
      apiFetch<{ data: TPAAccount[] }>(`/api/recovery/tpa-agencies/${agency.id}/accounts`)
        .then(res => setAccounts(res.data ?? []))
        .catch(() => setAccounts([]))
        .finally(() => setLoading(false))
    } else {
      apiFetch<{ data: TPAPerformance }>(`/api/recovery/tpa-agencies/${agency.id}/performance`)
        .then(res => setPerformance(res.data ?? null))
        .catch(() => setPerformance(null))
        .finally(() => setLoading(false))
    }
  }, [agency.id, tab])

  return (
    <div>
      {/* Agency header */}
      <div style={{ marginBottom: 16, padding: '12px 0', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 2 }}>Licence #</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{agency.licence_no ?? '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 2 }}>Commission</div>
            <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{fmtPct(agency.commission_pct)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 2 }}>Contact</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
              {agency.contact_name ?? '—'}{agency.contact_phone ? ` · ${agency.contact_phone}` : ''}
            </div>
          </div>
        </div>
      </div>

      <Tabs
        tabs={[
          { key: 'accounts', label: 'Assigned Accounts', badge: accounts.length },
          { key: 'performance', label: 'Performance' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'accounts' && (
        <DataTable
          cols={ACCOUNT_COLS}
          rows={accounts}
          keyFn={r => r.account_cif}
          loading={loading}
          skeletonRows={5}
          emptyText="No accounts assigned to this agency"
        />
      )}

      {tab === 'performance' && (
        <div>
          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>Loading…</div>
          ) : performance ? (
            <>
              {/* Summary stats */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                <div style={{ padding: '14px 16px', background: 'var(--th-bg)', borderRadius: 10, border: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 4 }}>Total Recovered</div>
                  <div style={{ ...NUM, fontSize: 18, fontWeight: 700, color: 'var(--txt)' }}>
                    {fmtKobo(performance.total_recovered_kobo)}
                  </div>
                </div>
                <div style={{ padding: '14px 16px', background: 'var(--th-bg)', borderRadius: 10, border: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 4 }}>Success Rate</div>
                  <div style={{ ...NUM, fontSize: 18, fontWeight: 700, color: '#16A34A' }}>
                    {fmtPct(performance.success_rate_pct)}
                  </div>
                </div>
              </div>
              {/* Bar chart */}
              {performance.monthly.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 8 }}>Recovered by Month</div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart
                      data={performance.monthly.slice(-6)}
                      margin={{ top: 4, right: 8, bottom: 0, left: -18 }}
                      barCategoryGap="30%"
                    >
                      <CartesianGrid stroke="#E8EBF2" strokeDasharray="0" vertical={false} strokeWidth={1} />
                      <XAxis
                        dataKey="month"
                        tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }}
                        axisLine={false} tickLine={false}
                      />
                      <YAxis
                        tickFormatter={v => fmtKobo(v)}
                        tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }}
                        axisLine={false} tickLine={false}
                      />
                      <Tooltip content={(p: any) => <Tip {...p} />} />
                      <Bar dataKey="amount_kobo" fill={BLUE} radius={[4, 4, 0, 0]} name="Recovered" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>
              No performance data available.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryTPA() {
  const [agencies, setAgencies]   = useState<TPAAgency[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)

  // Register modal
  const [showRegister, setShowRegister] = useState(false)
  const [registerSaving, setRegisterSaving] = useState(false)
  const [registerErr, setRegisterErr] = useState<string | null>(null)

  // Edit modal
  const [editAgency, setEditAgency] = useState<TPAAgency | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editErr, setEditErr] = useState<string | null>(null)

  // Detail modal
  const [detailAgency, setDetailAgency] = useState<TPAAgency | null>(null)

  // Deactivate confirm
  const [deactivateTarget, setDeactivateTarget] = useState<TPAAgency | null>(null)
  const [deactivateSaving, setDeactivateSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<{ data: TPAAgency[] }>('/api/recovery/tpa-agencies')
      setAgencies(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load TPA agencies')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleRegister(data: AgencyFormData) {
    setRegisterSaving(true); setRegisterErr(null)
    try {
      await apiPost('/api/recovery/tpa-agencies', {
        name: data.name,
        licence_no: data.licence_no || null,
        address: data.address || null,
        commission_pct: parseFloat(data.commission_pct),
        contact_name: data.contact_name || null,
        contact_phone: data.contact_phone || null,
      })
      toast.success('TPA agency registered')
      setShowRegister(false)
      load()
    } catch (e: any) {
      setRegisterErr(e.message ?? 'Failed to register agency')
    } finally {
      setRegisterSaving(false)
    }
  }

  async function handleEdit(data: AgencyFormData) {
    if (!editAgency) return
    setEditSaving(true); setEditErr(null)
    try {
      await apiPut(`/api/recovery/tpa-agencies/${editAgency.id}`, {
        name: data.name,
        licence_no: data.licence_no || null,
        address: data.address || null,
        commission_pct: parseFloat(data.commission_pct),
        contact_name: data.contact_name || null,
        contact_phone: data.contact_phone || null,
      })
      toast.success('Agency updated')
      setEditAgency(null)
      load()
    } catch (e: any) {
      setEditErr(e.message ?? 'Failed to update agency')
    } finally {
      setEditSaving(false)
    }
  }

  async function handleDeactivate() {
    if (!deactivateTarget) return
    setDeactivateSaving(true)
    try {
      await apiPut(`/api/recovery/tpa-agencies/${deactivateTarget.id}`, { active: false })
      toast.success('Agency deactivated')
      setDeactivateTarget(null)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to deactivate agency')
    } finally {
      setDeactivateSaving(false) }
  }

  const cols: TableCol<TPAAgency>[] = [
    {
      key: 'name',
      label: 'Agency Name',
      sortable: true,
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%', background: NAVY,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: '#fff', fontFamily: INTER, flexShrink: 0,
          }}>
            {r.name.slice(0, 2).toUpperCase()}
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.name}</span>
        </div>
      ),
    },
    {
      key: 'licence_no',
      label: 'Licence #',
      sortable: false,
      render: r => <span style={{ fontSize: 13, color: 'var(--txt)' }}>{r.licence_no ?? '—'}</span>,
    },
    {
      key: 'contact_phone',
      label: 'Contact',
      sortable: false,
      render: r => (
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--txt)' }}>{r.contact_name ?? '—'}</div>
          {r.contact_phone && <div style={{ fontSize: 11, color: 'var(--txt2)' }}>{r.contact_phone}</div>}
        </div>
      ),
    },
    {
      key: 'commission_pct',
      label: 'Commission %',
      sortable: true,
      align: 'right',
      render: r => <span style={{ ...NUM, fontSize: 13, fontWeight: 600 }}>{fmtPct(r.commission_pct)}</span>,
    },
    {
      key: 'accounts_assigned',
      label: 'Accounts Assigned',
      sortable: true,
      align: 'right',
      render: r => <span style={{ ...NUM, fontSize: 13 }}>{fmtNum(r.accounts_assigned)}</span>,
    },
    {
      key: 'recovered_kobo',
      label: 'Recovered ₦',
      sortable: true,
      align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.recovered_kobo)}</span>,
    },
    {
      key: 'commission_accrued_kobo',
      label: 'Commission Accrued ₦',
      sortable: true,
      align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.commission_accrued_kobo)}</span>,
    },
    {
      key: 'id',
      label: '',
      sortable: false,
      width: 100,
      render: r => (
        <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setEditAgency(r)}
            style={{
              width: 28, height: 28, borderRadius: 7, border: '1.5px solid var(--input-bdr)',
              background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--txt2)',
            }}
            title="Edit"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
          </button>
          <button
            onClick={() => setDeactivateTarget(r)}
            style={{
              width: 28, height: 28, borderRadius: 7, border: '1.5px solid var(--input-bdr)',
              background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: RED,
            }}
            title="Deactivate"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>block</span>
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page
      title="TPA Agencies"
      subtitle="Manage third-party collection agencies"
      actions={
        <button onClick={() => { setShowRegister(true); setRegisterErr(null) }} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          Register TPA
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="Registered Agencies" badge={agencies.length} padding={false}>
        <DataTable
          cols={cols}
          rows={agencies}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={6}
          emptyText="No TPA agencies registered"
          onRowClick={r => setDetailAgency(r)}
        />
      </SectionCard>

      {/* Register modal */}
      <Modal
        open={showRegister}
        onClose={() => setShowRegister(false)}
        title="Register TPA Agency"
        width={500}
      >
        <AgencyForm
          saving={registerSaving}
          err={registerErr}
          onSubmit={handleRegister}
        />
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editAgency}
        onClose={() => setEditAgency(null)}
        title="Edit TPA Agency"
        width={500}
      >
        {editAgency && (
          <AgencyForm
            initial={{
              name: editAgency.name,
              licence_no: editAgency.licence_no ?? '',
              address: editAgency.address ?? '',
              commission_pct: String(editAgency.commission_pct),
              contact_name: editAgency.contact_name ?? '',
              contact_phone: editAgency.contact_phone ?? '',
            }}
            saving={editSaving}
            err={editErr}
            onSubmit={handleEdit}
          />
        )}
      </Modal>

      {/* Detail modal */}
      <Modal
        open={!!detailAgency}
        onClose={() => setDetailAgency(null)}
        title={detailAgency?.name ?? 'TPA Detail'}
        width={620}
      >
        {detailAgency && <TPADetailContent agency={detailAgency} />}
      </Modal>

      {/* Deactivate confirm */}
      <ConfirmModal
        open={!!deactivateTarget}
        title="Deactivate Agency"
        body={`Are you sure you want to deactivate "${deactivateTarget?.name}"? Assigned accounts will need to be reassigned.`}
        confirmLabel="Deactivate"
        danger
        loading={deactivateSaving}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
    </Page>
  )
}
