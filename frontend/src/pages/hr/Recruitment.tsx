import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, ErrBanner, Spinner, Modal, DataTable,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, INTER, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Job {
  id:              number
  title:           string
  department:      string
  location:        string
  job_type:        string
  status:          string
  description:     string
  applicant_count: number
  target_date:     string | null
  created_at:      string
}

interface Applicant {
  id:             number
  job_id:         number
  job_title:      string
  full_name:      string
  email:          string
  phone:          string | null
  source:         string
  stage:          string
  notes:          string
  interview_date: string | null
  created_at:     string
}

// ── Status colours ────────────────────────────────────────────────────────────

const JOB_STATUS: Record<string, string> = {
  open: GREEN, paused: AMBER, closed: '#6B7280', filled: BLUE,
}
const STAGE_COLOR: Record<string, string> = {
  applied: '#6B7280', screened: BLUE, interview: AMBER,
  offer: NAVY, hired: GREEN, rejected: RED,
}

function Pill({ value, colorMap }: { value: string; colorMap: Record<string, string> }) {
  const c = colorMap[value] ?? '#9CA3AF'
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: `${c}18`, color: c, textTransform: 'capitalize' }}>
      {value.replace(/_/g, ' ')}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Recruitment() {
  const [jobs,       setJobs]       = useState<Job[]>([])
  const [applicants, setApplicants] = useState<Applicant[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [activeJob,  setActiveJob]  = useState<Job | null>(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [showNewApp, setShowNewApp] = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [stagingId,  setStagingId]  = useState<number | null>(null)

  // Job form
  const [jTitle, setJTitle] = useState('')
  const [jDept,  setJDept]  = useState('')
  const [jType,  setJType]  = useState('full_time')
  const [jDesc,  setJDesc]  = useState('')

  // Applicant form
  const [aName,  setAName]  = useState('')
  const [aEmail, setAEmail] = useState('')
  const [aPhone, setAPhone] = useState('')
  const [aSrc,   setASrc]   = useState('direct')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [j, a] = await Promise.all([
        apiFetch<Job[]>('/api/hr/jobs'),
        apiFetch<Applicant[]>('/api/hr/applicants'),
      ])
      setJobs(j); setApplicants(a)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const displayedApplicants = activeJob
    ? applicants.filter(a => a.job_id === activeJob.id)
    : applicants

  async function createJob() {
    setSaving(true)
    try {
      await apiPost('/api/hr/jobs', { title: jTitle, department: jDept, job_type: jType, description: jDesc, location: 'Lagos' })
      toast.success('Job created'); setShowNewJob(false)
      setJTitle(''); setJDept(''); setJDesc('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function createApplicant() {
    if (!activeJob) return
    setSaving(true)
    try {
      await apiPost('/api/hr/applicants', { job_id: activeJob.id, full_name: aName, email: aEmail, phone: aPhone, source: aSrc, notes: '' })
      toast.success('Applicant added'); setShowNewApp(false)
      setAName(''); setAEmail(''); setAPhone('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function advanceStage(applicant: Applicant, stage: string) {
    setStagingId(applicant.id)
    try {
      const token = localStorage.getItem('token') ?? ''
      await fetch(`/api/hr/applicants/${applicant.id}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stage }),
      })
      toast.success(`Moved to ${stage}`)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setStagingId(null) }
  }

  const STAGES = ['applied','screened','interview','offer','hired','rejected']

  const JOB_COLS: TableCol<Job>[] = [
    { key: 'title',           label: 'Role',       render: r => <span style={{ fontWeight: 600 }}>{r.title}</span> },
    { key: 'department',      label: 'Dept',       render: r => r.department },
    { key: 'job_type',        label: 'Type',       render: r => <Pill value={r.job_type} colorMap={{ full_time: NAVY, contract: BLUE, intern: AMBER }} /> },
    { key: 'status',          label: 'Status',     render: r => <Pill value={r.status} colorMap={JOB_STATUS} /> },
    { key: 'applicant_count', label: 'Applicants', render: r => <span style={{ ...NUM, fontWeight: 700 }}>{r.applicant_count}</span> },
    { key: 'target_date',     label: 'Target',     render: r => r.target_date ? fmtDate(r.target_date) : '—' },
    { key: 'id',              label: '',           render: r => (
      <button onClick={() => setActiveJob(r === activeJob ? null : r)}
        style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: r === activeJob ? NAVY : `${NAVY}12`, color: r === activeJob ? '#fff' : NAVY, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
        {r === activeJob ? 'All' : 'View'}
      </button>
    )},
  ]

  const APP_COLS: TableCol<Applicant>[] = [
    { key: 'full_name', label: 'Applicant', render: r => <span style={{ fontWeight: 600 }}>{r.full_name}</span> },
    { key: 'job_title', label: 'Role',      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{r.job_title}</span> },
    { key: 'source',    label: 'Source',    render: r => <span style={{ fontSize: 12 }}>{r.source}</span> },
    { key: 'stage',     label: 'Stage',     render: r => <Pill value={r.stage} colorMap={STAGE_COLOR} /> },
    { key: 'interview_date', label: 'Interview', render: r => r.interview_date ? fmtDate(r.interview_date) : '—' },
    { key: 'id',        label: '',          render: r => (
      <select
        value={r.stage}
        disabled={stagingId === r.id}
        onChange={e => advanceStage(r, e.target.value)}
        style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: 11.5, cursor: 'pointer' }}
      >
        {STAGES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
      </select>
    )},
  ]

  const openCount = jobs.filter(j => j.status === 'open').length

  return (
    <Page
      title="Recruitment"
      subtitle="Job openings and applicant pipeline"
      actions={
        <button onClick={() => setShowNewJob(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Job
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Open Roles',      value: openCount,                                           color: GREEN },
          { label: 'Total Applicants',value: applicants.length,                                   color: NAVY  },
          { label: 'In Interview',    value: applicants.filter(a=>a.stage==='interview').length,  color: AMBER },
          { label: 'Hired This Cycle',value: applicants.filter(a=>a.stage==='hired').length,      color: BLUE  },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color, ...NUM }}>{value}</div>
          </div>
        ))}
      </div>

      {loading ? <div style={{ display:'flex', justifyContent:'center', padding: 60 }}><Spinner size={32} /></div> : (
        <>
          <SectionCard title="Job Openings" badge={jobs.length}>
            <DataTable cols={JOB_COLS} rows={jobs} keyFn={r => r.id} emptyText="No job postings" />
          </SectionCard>

          <SectionCard
            title={activeJob ? `Applicants — ${activeJob.title}` : 'All Applicants'}
            badge={displayedApplicants.length}
            actions={activeJob && (
              <button onClick={() => setShowNewApp(true)}
                style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: `${NAVY}12`, color: NAVY, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                + Add Applicant
              </button>
            )}
          >
            <DataTable cols={APP_COLS} rows={displayedApplicants} keyFn={r => r.id} emptyText="No applicants yet" />
          </SectionCard>
        </>
      )}

      {/* New Job modal */}
      <Modal open={showNewJob} onClose={() => setShowNewJob(false)} title="Create Job Opening" width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={createJob} disabled={saving}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}Create
            </button>
            <button onClick={() => setShowNewJob(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { label: 'Job Title',   value: jTitle, set: setJTitle, type: 'text' },
            { label: 'Department',  value: jDept,  set: setJDept,  type: 'text' },
          ].map(({ label, value, set, type }) => (
            <div key={label}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
          ))}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Type</label>
            <select value={jType} onChange={e => setJType(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }}>
              <option value="full_time">Full Time</option>
              <option value="contract">Contract</option>
              <option value="intern">Intern</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Description</label>
            <textarea value={jDesc} onChange={e => setJDesc(e.target.value)} rows={3}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
        </div>
      </Modal>

      {/* New Applicant modal */}
      <Modal open={showNewApp} onClose={() => setShowNewApp(false)} title="Add Applicant" width={420}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={createApplicant} disabled={saving}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={13} color="#fff" />}Add
            </button>
            <button onClick={() => setShowNewApp(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { label: 'Full Name', value: aName,  set: setAName,  type: 'text'  },
            { label: 'Email',     value: aEmail, set: setAEmail, type: 'email' },
            { label: 'Phone',     value: aPhone, set: setAPhone, type: 'tel'   },
          ].map(({ label, value, set, type }) => (
            <div key={label}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
          ))}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Source</label>
            <select value={aSrc} onChange={e => setASrc(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }}>
              {['direct','referral','linkedin','agency','website'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
          </div>
        </div>
      </Modal>
    </Page>
  )
}
