import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Button, Input } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, TEXT, FW, SP, RADIUS } from '../../lib/design'
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
        padding: `${SP[2]} ${SP[5]}`, border: 'none', borderBottom: `2px solid ${active ? RED : 'transparent'}`,
        background: 'none', fontWeight: active ? FW.bold : FW.medium, fontSize: TEXT.md,
        color: active ? RED : 'var(--txt2)', cursor: 'pointer', transition: 'all 0.15s',
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
        border: `2px dashed ${over ? RED : 'var(--bdr)'}`,
        borderRadius: RADIUS.lg, padding: `${SP[10]} ${SP[6]}`, textAlign: 'center',
        cursor: 'pointer', background: over ? 'rgba(192,0,0,.04)' : 'var(--bg)',
        transition: 'all 0.15s',
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 40, color: over ? RED : 'var(--txt3)', display: 'block', marginBottom: SP[2] }}>
        upload_file
      </span>
      <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: NAVY }}>{label}</div>
      {sublabel && <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', marginTop: 4 }}>{sublabel}</div>}
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} style={{ display: 'none' }}
        onChange={e => { const f = Array.from(e.target.files ?? []); if (f.length) onFiles(f) }} />
    </div>
  )
}

// ── Preview table ─────────────────────────────────────────────────────────────

function PreviewSummary({ h }: { h: ParsedHeader }) {
  const overLimit = h.LineOfCredit > 0 && h.ClosingBalance > h.LineOfCredit
  return (
    <div style={{ background: 'var(--card)', borderRadius: RADIUS.md, padding: SP[4], display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: SP[3], marginBottom: 16 }}>
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
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{f.label}</div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: f.color ?? NAVY, fontFamily: f.mono ? 'DM Mono, monospace' : undefined, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
            {f.value || '—'}
            {f.warn && <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: RED }}>warning</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function PreviewTxns({ txns, openingBalance }: { txns: ParsedTxn[]; openingBalance: number }) {
  let runBal = openingBalance
  return (
    <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
        <thead style={{ position: 'sticky', top: 0, background: NAVY }}>
          <tr>
            {[
              { label: '#',           right: false, color: 'rgba(255,255,255,.6)' },
              { label: 'Date',        right: false, color: 'rgba(255,255,255,.6)' },
              { label: 'Trace',       right: false, color: 'rgba(255,255,255,.6)' },
              { label: 'Card',        right: false, color: 'rgba(255,255,255,.6)' },
              { label: 'Description', right: false, color: '#fff' },
              { label: 'Debit',       right: true,  color: '#ffb3b3' },
              { label: 'Credit',      right: true,  color: '#86efac' },
              { label: 'Balance',     right: true,  color: 'rgba(255,255,255,.7)' },
            ].map(col => (
              <th key={col.label} style={{ padding: '9px 10px', textAlign: col.right ? 'right' : 'left', fontWeight: FW.bold, fontSize: TEXT.xs, color: col.color, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {txns.map((t, i) => {
            runBal += t.DebitKobo - t.CreditKobo
            const bal = runBal
            return (
              <tr key={t.Seq} style={{ borderBottom: '1px solid var(--bdr)', background: t.IsFinanceCharge ? 'rgba(217,119,6,.06)' : i % 2 === 1 ? 'var(--row-hvr)' : undefined }}>
                <td style={{ padding: '7px 10px', color: 'var(--txt3)' }}>{t.Seq}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace', color: 'var(--txt2)' }}>{t.TxnDate ? t.TxnDate.slice(0, 10) : '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace', color: 'var(--txt2)' }}>{t.TraceNo || '—'}</td>
                <td style={{ padding: '7px 10px', fontFamily: 'DM Mono, monospace', fontSize: TEXT.xs, color: 'var(--txt2)' }}>{t.CardPAN || '—'}</td>
                <td style={{ padding: '7px 10px', color: t.IsFinanceCharge ? AMBER : 'var(--txt)', fontWeight: t.IsFinanceCharge ? FW.semibold : undefined }}>
                  {t.Description}
                  {t.IsFinanceCharge && <span style={{ marginLeft: 6, fontSize: TEXT.xs, background: '#FEF3C7', color: AMBER, borderRadius: RADIUS.xs, padding: '1px 5px' }}>charge</span>}
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: t.DebitKobo > 0 ? (t.IsFinanceCharge ? AMBER : RED) : 'var(--txt3)' }}>{t.DebitKobo > 0 ? fmtKobo(t.DebitKobo) : '—'}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'DM Mono, monospace', color: t.CreditKobo > 0 ? GREEN : 'var(--txt3)' }}>{t.CreditKobo > 0 ? fmtKobo(t.CreditKobo) : '—'}</td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'DM Mono, monospace', fontVariantNumeric: 'tabular-nums', fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtKobo(bal)}</td>
              </tr>
            )
          })}
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
      const stmtId = d?.data?.id ?? d?.id
      toast.success(`Statement saved — ${d?.data?.txn_count ?? d?.txn_count ?? 0} transactions`)
      navigate(`/statements/credit-cards/${stmtId ?? ''}`)
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
      {loading && <div style={{ textAlign: 'center', padding: SP[8], color: 'var(--txt3)', fontSize: TEXT.base }}>Parsing file…</div>}
      {preview && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: NAVY }}>
              Preview — {preview.transactions.length} transactions
            </div>
            <div style={{ display: 'flex', gap: SP[2] }}>
              <Button variant="secondary" onClick={() => { setFile(null); setPreview(null) }}>
                Change file
              </Button>
              <Button variant="danger" onClick={save} loading={saving}>
                {saving ? 'Saving…' : 'Confirm & Save'}
              </Button>
            </div>
          </div>
          <PreviewSummary h={preview.header} />
          <PreviewTxns txns={preview.transactions} openingBalance={preview.header.OpeningBalance} />
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
            <div style={{ marginTop: SP[4] }}>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: NAVY, marginBottom: SP[2] }}>
                {files.length} file{files.length !== 1 ? 's' : ''} selected
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: RADIUS.sm }}>
                {files.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], padding: `${SP[2]} ${SP[3]}`, borderBottom: '1px solid var(--bdr)' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: 'var(--txt3)' }}>description</span>
                    <span style={{ fontSize: TEXT.base, flex: 1 }}>{f.name}</span>
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{(f.size / 1024).toFixed(1)} KB</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14, display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
                <Button variant="secondary" onClick={() => setFiles([])}>Clear</Button>
                <Button variant="danger" onClick={upload} loading={uploading}>
                  {uploading ? `Uploading ${files.length} files…` : `Upload ${files.length} files`}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {results && (
        <div>
          {/* Summary bar */}
          <div style={{ display: 'flex', gap: SP[3], marginBottom: SP[4] }}>
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[4]}`, display: 'flex', alignItems: 'center', gap: SP[2] }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: GREEN }}>check_circle</span>
              <span style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: '#14532D' }}>{succeeded} succeeded</span>
            </div>
            {failed > 0 && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[4]}`, display: 'flex', alignItems: 'center', gap: SP[2] }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: RED }}>error</span>
                <span style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: '#991B1B' }}>{failed} failed</span>
              </div>
            )}
            <Button variant="secondary" onClick={() => { setFiles([]); setResults(null) }} style={{ marginLeft: 'auto' }}>
              Upload more
            </Button>
          </div>

          {/* Result rows */}
          <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
            {results.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `${SP[2]} 14px`, borderBottom: i < results.length - 1 ? '1px solid var(--bdr)' : undefined, background: r.ok ? undefined : '#FFF5F5' }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: r.ok ? GREEN : RED, flexShrink: 0 }}>
                  {r.ok ? 'check_circle' : 'error'}
                </span>
                <span style={{ fontSize: TEXT.base, flex: 1, fontWeight: FW.medium }}>{r.filename}</span>
                {r.ok
                  ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.txn_count} transactions · ID {r.id}</span>
                  : <span style={{ fontSize: TEXT.sm, color: RED }}>{r.error}</span>
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
    <Input label={label} type={type} value={form[key]} onChange={set(key)} placeholder={hint} />
  )

  return (
    <div>
      <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: RADIUS.md, padding: `${SP[3]} ${SP[4]}`, marginBottom: SP[5], fontSize: TEXT.base, color: '#0369A1' }}>
        Queries the live transaction database (MSSQL or PostgreSQL) for the CIF or account number and date range you specify, then builds a statement from the results.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: SP[4] }}>
        {field('CIF Number', 'cif', 'text', 'e.g. 0012345')}
        {field('Account Number', 'account_number', 'text', 'e.g. 000108531566')}
        {field('Customer Name', 'customer_name', 'text', 'For statement header')}
        {field('Date From', 'date_from', 'date')}
        {field('Date To', 'date_to', 'date')}
        {field('Line of Credit (₦)', 'line_of_credit_kobo', 'number', '2000000')}
        {field('Opening Balance (₦)', 'opening_balance_kobo', 'number', '1076439.33')}
        {field('Payment Due Date', 'payment_due_date', 'date')}
      </div>
      <div style={{ marginTop: SP[5], display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="danger" onClick={submit} loading={loading}>
          {loading ? 'Building…' : 'Build Statement'}
        </Button>
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
        <Button variant="secondary" icon="arrow_back" onClick={() => navigate('/statements/credit-cards')}>
          Back
        </Button>
      }
    >
      <SectionCard>
        {/* Tab bar */}
        <div style={{ borderBottom: '1px solid var(--bdr)', marginBottom: SP[6], display: 'flex' }}>
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
