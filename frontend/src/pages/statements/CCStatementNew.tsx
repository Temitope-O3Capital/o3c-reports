import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedHeader {
  CustomerName: string
  CustomerAddress: string
  AccountNumber: string
  StatementDate: string
  PaymentDueDate: string
  LineOfCredit: number
  OpeningBalance: number
  TotalDebit: number
  TotalCredit: number
  ClosingBalance: number
  MinPayment: number
  FinanceCharge: number
}

interface ParsedTxn {
  Description: string
  DebitKobo: number
  CreditKobo: number
  IsFinanceCharge: boolean
  TraceNo: string
  CardPAN: string
  TxnDate: string
  PostingDate: string
  Seq: number
}

interface BulkResult {
  filename: string
  id?: number
  txn_count?: number
  error?: string
  ok: boolean
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '10px 20px', border: 'none', borderBottom: `2px solid ${active ? RED : 'transparent'}`,
        background: 'none', fontWeight: active ? 700 : 500, fontSize: 14,
        color: active ? RED : '#64748B', cursor: 'pointer', transition: 'all 0.15s',
      }}
    >{label}</button>
  )
}

function DropZone({
  accept, multiple, onFiles, label, sublabel,
}: {
  accept: string; multiple: boolean
  onFiles: (files: File[]) => void
  label: string; sublabel?: string
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) onFiles(files)
  }, [onFiles])

  return (
    <div
      onDragOver={e => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${over ? RED : '#CBD5E1'}`,
        borderRadius: 10, padding: '40px 24px', textAlign: 'center',
        cursor: 'pointer', background: over ? '#FFF5F5' : '#FAFBFC',
        transition: 'all 0.15s',
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 40, color: over ? RED : '#94A3B8', display: 'block', marginBottom: 8 }}>
        upload_file
      </span>
      <div style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>{label}</div>
      {sublabel && <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 4 }}>{sublabel}</div>}
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} style={{ display: 'none' }}
        onChange={e => { const f = Array.from(e.target.files ?? []); if (f.length) onFiles(f) }} />
    </div>
  )
}

// ── Preview table ─────────────────────────────────────────────────────────────

function PreviewSummary({ h }: { h: ParsedHeader }) {
  const overLimit = h.LineOfCredit > 0 && h.ClosingBalance > h.LineOfCredit
  return (
    <div style={{ background: '#F8FAFC', borderRadius: 8, padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
      {[
        { label: 'Customer', value: h.CustomerName },
        { label: 'Account', value: h.AccountNumber, mono: true },
        { label: 'Statement Date', value: h.StatementDate?.slice(0, 10) },
        { label: 'Opening Balance', value: fmtKobo(h.OpeningBalance) },
        { label: 'Total Debits', value: fmtKobo(h.TotalDebit), color: RED },
        { label: 'Total Credits', value: fmtKobo(h.TotalCredit), color: GREEN },
        { label: 'Finance Charge', value: fmtKobo(h.FinanceCharge), color: AMBER },
        { label: 'Closing Balance', value: fmtKobo(h.ClosingBalance), color: overLimit ? RED : NAVY, warn: overLimit },
        { label: 'Line of Credit', value: fmtKobo(h.LineOfCredit) },
        { label: 'Min Payment', value: fmtKobo(h.MinPayment) },
        { label: 'Payment Due', value: h.PaymentDueDate?.slice(0, 10) },
      ].map(f => (
        <div key={f.label}>
          <div style={{ fontSize: 11, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{f.label}</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: f.color ?? NAVY, fontFamily: f.mono ? 'DM Mono, monospace' : undefined, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
            {f.value || '—'}
            {f.warn && <span className="material-symbols-rounded" style={{ fontSize: 14, color: RED }}>warning</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function PreviewTxns({ txns }: { txns: ParsedTxn[] }) {
  return (
    <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--th-bg)' }}>
          <tr>
            {['#', 'Date', 'Posting', 'Trace', 'Card', 'Description', 'Debit', 'Credit'].map(h => (
              <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {txns.map(t => (
            <tr key={t.Seq} style={{ borderBottom: '1px solid #F1F5F9', background: t.IsFinanceCharge ? '#FFFBEB' : undefined }}>
              <td style={{ padding: '7px 10px', color: '#94A3B8' }}>{t.Seq}</td>
              <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace' }}>{t.TxnDate ? t.TxnDate.slice(0, 10) : '—'}</td>
              <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace' }}>{t.PostingDate ? t.PostingDate.slice(0, 10) : '—'}</td>
              <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace', color: '#64748B' }}>{t.TraceNo || '—'}</td>
              <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace', fontSize: 11 }}>{t.CardPAN || '—'}</td>
              <td style={{ padding: '7px 10px', color: t.IsFinanceCharge ? AMBER : NAVY, fontWeight: t.IsFinanceCharge ? 600 : undefined }}>{t.Description}</td>
              <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace', color: t.DebitKobo > 0 ? RED : '#CBD5E1' }}>{t.DebitKobo > 0 ? fmtKobo(t.DebitKobo) : '—'}</td>
              <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace', color: t.CreditKobo > 0 ? GREEN : '#CBD5E1' }}>{t.CreditKobo > 0 ? fmtKobo(t.CreditKobo) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Tab A: Single Upload ───────────────────────────────────────────────────────

function SingleUploadTab() {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ header: ParsedHeader; transactions: ParsedTxn[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const onFile = async (files: File[]) => {
    const f = files[0]
    setFile(f)
    setPreview(null)
    setLoading(true)
    try {
      const form = new FormData()
      form.append('file', f)
      form.append('preview', 'true')
      const d = await apiFetch<any>('/api/cc-statements/upload', { method: 'POST', body: form })
      setPreview(d.data ?? d)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    if (!file) return
    setSaving(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const d = await apiFetch<any>('/api/cc-statements/upload', { method: 'POST', body: form })
      toast.success(`Statement saved — ${d.data?.txn_count ?? 0} transactions`)
      navigate(`/statements/credit-cards/${d.data?.id ?? ''}`)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {!preview && (
        <DropZone
          accept=".txt,.csv"
          multiple={false}
          onFiles={onFile}
          label="Drop statement file here or click to browse"
          sublabel=".txt format (same layout as sample file)"
        />
      )}
      {loading && <div style={{ textAlign: 'center', padding: 32, color: '#94A3B8', fontSize: 13 }}>Parsing file…</div>}
      {preview && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>
              Preview — {preview.transactions.length} transactions
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { setFile(null); setPreview(null) }}
                style={{ padding: '7px 14px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#64748B' }}
              >
                Change file
              </button>
              <button
                onClick={save}
                disabled={saving}
                style={{ padding: '7px 16px', background: saving ? '#94A3B8' : RED, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer' }}
              >
                {saving ? 'Saving…' : 'Confirm & Save'}
              </button>
            </div>
          </div>
          <PreviewSummary h={preview.header} />
          <PreviewTxns txns={preview.transactions} />
        </div>
      )}
    </div>
  )
}

// ── Tab B: Bulk Upload ────────────────────────────────────────────────────────

function BulkUploadTab() {
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState<BulkResult[] | null>(null)

  const onFiles = (f: File[]) => {
    setFiles(f)
    setResults(null)
  }

  const upload = async () => {
    if (!files.length) return
    setUploading(true)
    try {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      const d = await apiFetch<any>('/api/cc-statements/bulk', { method: 'POST', body: form })
      const payload = d.data ?? d
      setResults(payload.results ?? [])
      const { succeeded, failed } = payload
      if (failed === 0) toast.success(`All ${succeeded} statements imported`)
      else toast.warning(`${succeeded} succeeded, ${failed} failed`)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setUploading(false)
    }
  }

  const succeeded = results?.filter(r => r.ok).length ?? 0
  const failed = results?.filter(r => !r.ok).length ?? 0

  return (
    <div>
      {!results && (
        <>
          <DropZone
            accept=".txt,.csv"
            multiple={true}
            onFiles={onFiles}
            label="Drop multiple statement files here"
            sublabel="All files will be parsed and saved in one batch"
          />
          {files.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: NAVY, marginBottom: 8 }}>
                {files.length} file{files.length !== 1 ? 's' : ''} selected
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #E2E8F0', borderRadius: 6 }}>
                {files.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #F1F5F9' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16, color: '#94A3B8' }}>description</span>
                    <span style={{ fontSize: 13, flex: 1 }}>{f.name}</span>
                    <span style={{ fontSize: 12, color: '#94A3B8' }}>{(f.size / 1024).toFixed(1)} KB</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setFiles([])}
                  style={{ padding: '8px 14px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#64748B' }}
                >
                  Clear
                </button>
                <button
                  onClick={upload}
                  disabled={uploading}
                  style={{ padding: '8px 18px', background: uploading ? '#94A3B8' : RED, color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: uploading ? 'default' : 'pointer' }}
                >
                  {uploading ? `Uploading ${files.length} files…` : `Upload ${files.length} files`}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {results && (
        <div>
          {/* Summary bar */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: GREEN }}>check_circle</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#14532D' }}>{succeeded} succeeded</span>
            </div>
            {failed > 0 && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>error</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#991B1B' }}>{failed} failed</span>
              </div>
            )}
            <button
              onClick={() => { setFiles([]); setResults(null) }}
              style={{ marginLeft: 'auto', padding: '8px 14px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#64748B' }}
            >
              Upload more
            </button>
          </div>

          {/* Result rows */}
          <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
            {results.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: i < results.length - 1 ? '1px solid #F1F5F9' : undefined, background: r.ok ? undefined : '#FFF5F5' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: r.ok ? GREEN : RED, flexShrink: 0 }}>
                  {r.ok ? 'check_circle' : 'error'}
                </span>
                <span style={{ fontSize: 13, flex: 1, fontWeight: 500 }}>{r.filename}</span>
                {r.ok
                  ? <span style={{ fontSize: 12, color: '#64748B' }}>{r.txn_count} transactions · ID {r.id}</span>
                  : <span style={{ fontSize: 12, color: RED }}>{r.error}</span>
                }
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab C: From DB ────────────────────────────────────────────────────────────

function FromDBTab() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    cif: '',
    account_number: '',
    customer_name: '',
    date_from: '',
    date_to: '',
    line_of_credit_kobo: '',
    opening_balance_kobo: '',
    payment_due_date: '',
  })
  const [loading, setLoading] = useState(false)

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async () => {
    if (!form.date_from || !form.date_to) {
      toast.error('Date range is required')
      return
    }
    if (!form.cif && !form.account_number) {
      toast.error('CIF or account number is required')
      return
    }
    setLoading(true)
    try {
      const d = await apiFetch<any>('/api/cc-statements/from-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          line_of_credit_kobo: form.line_of_credit_kobo ? Math.round(parseFloat(form.line_of_credit_kobo) * 100) : 0,
          opening_balance_kobo: form.opening_balance_kobo ? Math.round(parseFloat(form.opening_balance_kobo) * 100) : 0,
        }),
      })
      const payload = d.data ?? d
      toast.success(`Statement built — ${payload.txn_count} transactions`)
      navigate(`/statements/credit-cards/${payload.id}`)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  const field = (label: string, key: keyof typeof form, type = 'text', hint?: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</label>
      <input
        type={type}
        value={form[key]}
        onChange={set(key)}
        placeholder={hint}
        style={{ padding: '9px 12px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13, outline: 'none', color: NAVY }}
      />
    </div>
  )

  return (
    <div>
      <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#0369A1' }}>
        Queries the live transaction database (MSSQL or PostgreSQL) for the CIF or account number and date range you specify, then builds a statement from the results.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        {field('CIF Number', 'cif', 'text', 'e.g. 0012345')}
        {field('Account Number', 'account_number', 'text', 'e.g. 000108531566')}
        {field('Customer Name', 'customer_name', 'text', 'For statement header')}
        {field('Date From', 'date_from', 'date')}
        {field('Date To', 'date_to', 'date')}
        {field('Line of Credit (₦)', 'line_of_credit_kobo', 'number', '2000000')}
        {field('Opening Balance (₦)', 'opening_balance_kobo', 'number', '1076439.33')}
        {field('Payment Due Date', 'payment_due_date', 'date')}
      </div>
      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={submit}
          disabled={loading}
          style={{ padding: '10px 24px', background: loading ? '#94A3B8' : RED, color: '#fff', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: loading ? 'default' : 'pointer' }}
        >
          {loading ? 'Building…' : 'Build Statement'}
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CCStatementNew() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'single' | 'bulk' | 'db'>('single')

  return (
    <Page
      title="New Credit Card Statement"
      subtitle="Import from a file or build from existing transaction records"
      actions={
        <button
          onClick={() => navigate('/statements/credit-cards')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: '1px solid #E2E8F0', borderRadius: 6, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#64748B' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_back</span>
          Back
        </button>
      }
    >
      <SectionCard>
        {/* Tab bar */}
        <div style={{ borderBottom: '1px solid #E2E8F0', marginBottom: 24, display: 'flex' }}>
          <TabBtn label="Single Upload"  active={tab === 'single'} onClick={() => setTab('single')} />
          <TabBtn label="Bulk Upload"    active={tab === 'bulk'}   onClick={() => setTab('bulk')} />
          <TabBtn label="From Database"  active={tab === 'db'}     onClick={() => setTab('db')} />
        </div>

        {tab === 'single' && <SingleUploadTab />}
        {tab === 'bulk'   && <BulkUploadTab />}
        {tab === 'db'     && <FromDBTab />}
      </SectionCard>
    </Page>
  )
}
