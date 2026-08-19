import { useState, useRef } from 'react'
import { Modal, Spinner } from './UI'
import { NAVY, GREEN, RED, AMBER, TEXT, FW, RADIUS, SP } from '../lib/design'
import { toast } from 'sonner'

interface UploadResult {
  row: number
  cif: string
  success: boolean
  error?: string
}

interface Props {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

function downloadTemplate() {
  const csv = [
    'cif,amount_naira,payment_date,channel,reference',
    'CIF-001234,5000.00,2025-07-01,bank_transfer,TRF-0001',
    'CIF-005678,10000.00,2025-07-01,cash,RCPT-0042',
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'batch-payment-template.csv'
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

export function BatchPaymentModal({ open, onClose, onSuccess }: Props) {
  const [file, setFile]           = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [results, setResults]     = useState<UploadResult[] | null>(null)
  const [summary, setSummary]     = useState<{ processed: number; failed: number; total: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setFile(null); setResults(null); setSummary(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function handleClose() { reset(); onClose() }

  async function handleUpload() {
    if (!file) { toast.error('Select a CSV file first'); return }
    setUploading(true)
    try {
      const token = localStorage.getItem('o3c_token') ?? ''
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/collections/payments/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      setResults(data.data?.results ?? data.results ?? [])
      setSummary({
        processed: data.data?.processed ?? data.processed ?? 0,
        failed: data.data?.failed ?? data.failed ?? 0,
        total: data.data?.total ?? data.total ?? 0,
      })
      if ((data.data?.failed ?? data.failed ?? 0) === 0) {
        toast.success(`${data.data?.processed ?? data.processed} payment${(data.data?.processed ?? data.processed) !== 1 ? 's' : ''} logged successfully`)
        onSuccess()
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box',
  }

  const failedRows = results?.filter(r => !r.success) ?? []
  const successRows = results?.filter(r => r.success) ?? []

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Batch Payment Upload"
      width={540}
      footer={
        results ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={reset}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: `1.5px solid ${NAVY}`, background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}
            >
              Upload Another File
            </button>
            <button
              onClick={handleClose}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
            >
              Close
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              style={{
                padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none',
                background: GREEN, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
                cursor: (!file || uploading) ? 'not-allowed' : 'pointer', opacity: (!file || uploading) ? 0.65 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {uploading && <Spinner size={13} color="#fff" />}
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>upload</span>
              {uploading ? 'Processing…' : 'Upload & Process'}
            </button>
            <button
              onClick={handleClose}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        )
      }
    >
      {results ? (
        /* Results view */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Summary strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[
              { label: 'Total Rows', value: summary?.total ?? 0, color: NAVY },
              { label: 'Processed', value: summary?.processed ?? 0, color: GREEN },
              { label: 'Failed', value: summary?.failed ?? 0, color: summary?.failed ? RED : 'var(--txt3)' },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--canvas)', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[3]}`, textAlign: 'center' }}>
                <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold }}>{s.label}</div>
              </div>
            ))}
          </div>

          {failedRows.length > 0 && (
            <div>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, marginBottom: 8 }}>
                Failed rows
              </div>
              <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {failedRows.map(r => (
                  <div key={r.row} style={{
                    display: 'flex', gap: 8, alignItems: 'flex-start',
                    padding: `${SP[2]} ${SP[3]}`, background: `${RED}08`,
                    border: `1px solid ${RED}20`, borderRadius: RADIUS.sm,
                  }}>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: RED, minWidth: 40 }}>Row {r.row}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: NAVY, minWidth: 80 }}>{r.cif || '—'}</span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {successRows.length > 0 && (
            <div style={{ padding: `${SP[2]} ${SP[3]}`, background: `${GREEN}0C`, border: `1px solid ${GREEN}30`, borderRadius: RADIUS.md }}>
              <span style={{ fontSize: TEXT.sm, color: GREEN, fontWeight: FW.semibold }}>
                {successRows.length} payment{successRows.length !== 1 ? 's' : ''} logged and posted to the GL.
              </span>
            </div>
          )}
        </div>
      ) : (
        /* Upload form */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Format instructions */}
          <div style={{ padding: `${SP[3]} ${SP[4]}`, background: `${NAVY}06`, border: `1px solid ${NAVY}20`, borderRadius: RADIUS.md }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>Required CSV columns</span>
              <button
                onClick={downloadTemplate}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 10px', borderRadius: RADIUS.sm,
                  border: `1.5px solid ${NAVY}30`, background: 'var(--card)',
                  color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
                }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
                Template
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['cif', 'amount_naira', 'payment_date', 'channel', 'reference'].map((col, i) => (
                <code key={col} style={{
                  padding: '2px 8px', borderRadius: RADIUS.sm,
                  background: 'var(--card)', border: '1px solid var(--bdr)',
                  fontSize: TEXT.xs, color: i < 4 ? NAVY : 'var(--txt3)',
                  fontWeight: i < 4 ? FW.semibold : FW.normal,
                }}>
                  {col}{i >= 4 ? ' (optional)' : ''}
                </code>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              Channels: <code>cash</code>, <code>bank_transfer</code>, <code>pos</code>, <code>mobile_money</code>, <code>cheque</code>
            </div>
          </div>

          {/* File picker */}
          <div>
            <label style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>
              Select CSV file
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              style={{ ...inputStyle, cursor: 'pointer' }}
            />
            {file && (
              <div style={{ marginTop: 6, fontSize: TEXT.xs, color: GREEN, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
                {file.name}, {(file.size / 1024).toFixed(1)} KB
              </div>
            )}
          </div>

          <div style={{ padding: `${SP[2]} ${SP[3]}`, background: `${AMBER}0C`, border: `1px solid ${AMBER}30`, borderRadius: RADIUS.md }}>
            <p style={{ margin: 0, fontSize: TEXT.sm, color: AMBER, fontWeight: FW.semibold }}>
              Each row is processed individually. Rows with errors are skipped; valid rows are posted immediately.
            </p>
          </div>
        </div>
      )}
    </Modal>
  )
}
