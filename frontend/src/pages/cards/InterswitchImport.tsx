import { useState, useRef, useCallback } from 'react'
import { Page, SectionCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, NAVY, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ImportResult {
  files_processed: number
  transactions_imported: number
  total_volume_kobo: number
  branches: { branch: string; txn_count: number; volume_kobo: number }[]
  products: { product: string; txn_count: number }[]
  errors: string[]
}

type Stage = 'idle' | 'selected' | 'importing' | 'done' | 'error'

// ── Drop zone ─────────────────────────────────────────────────────────────────

function DropZone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
  }, [onFiles])

  return (
    <div
      onDrop={handleDrop}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? BLUE : 'var(--bdr)'}`,
        borderRadius: RADIUS.xl,
        padding: '48px 32px',
        textAlign: 'center',
        cursor: 'pointer',
        background: dragging ? `${BLUE}08` : 'var(--card)',
        transition: 'all 150ms',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="*/*"
        style={{ display: 'none' }}
        onChange={e => { if (e.target.files?.length) onFiles(e.target.files) }}
      />
      <span className="material-symbols-rounded" style={{ fontSize: 40, color: dragging ? BLUE : 'var(--txt3)', display: 'block', marginBottom: SP[3] }}>
        upload_file
      </span>
      <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER, marginBottom: SP[1] }}>
        Drop EODTXN files here, or click to browse
      </div>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
        Accepts Interswitch CCS Report 620 files (EODTXN.YYYYMMDD.HHMMSS)
      </div>
    </div>
  )
}

// ── File list ─────────────────────────────────────────────────────────────────

function FileList({ files, onClear }: { files: File[]; onClear: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[1] }}>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>
          {files.length} file{files.length !== 1 ? 's' : ''} selected
        </span>
        <button onClick={onClear} style={{ fontSize: TEXT.xs, color: 'var(--txt2)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: INTER, padding: '2px 6px' }}>
          Clear
        </button>
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: SP[1] }}>
        {files.map(f => (
          <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: SP[2], padding: `${SP[2]} ${SP[3]}`, background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16, color: BLUE }}>description</span>
            <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, flexShrink: 0 }}>
              {(f.size / 1024).toFixed(0)} KB
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Result panel ──────────────────────────────────────────────────────────────

function ResultPanel({ result }: { result: ImportResult }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      {/* Summary KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[3] }}>
        {[
          { label: 'Files Processed',         value: fmtNum(result.files_processed),         color: NAVY   },
          { label: 'Transactions Imported',   value: fmtNum(result.transactions_imported),   color: BLUE   },
          { label: 'Total Volume',            value: fmtKobo(result.total_volume_kobo),      color: GREEN  },
        ].map(k => (
          <div key={k.label} style={{ padding: SP[4], background: `${k.color}08`, borderRadius: RADIUS.lg, border: `1px solid ${k.color}20` }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginBottom: SP[1] }}>{k.label}</div>
            <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: k.color, fontFamily: INTER, ...NUM }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Branch breakdown */}
      <div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER, marginBottom: SP[2] }}>By Branch</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 120px', gap: SP[2], padding: '6px 12px', background: 'var(--th-bg)', borderRadius: RADIUS.md, marginBottom: SP[1] }}>
          {['Branch', 'Txns', 'Volume'].map(h => (
            <span key={h} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textAlign: h !== 'Branch' ? 'right' : 'left' }}>{h}</span>
          ))}
        </div>
        {result.branches.map((b, i) => (
          <div key={b.branch} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 120px', gap: SP[2], padding: '8px 12px', borderBottom: i < result.branches.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{b.branch}</span>
            <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm }}>{fmtNum(b.txn_count)}</span>
            <span style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKobo(b.volume_kobo)}</span>
          </div>
        ))}
      </div>

      {/* Product breakdown */}
      <div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER, marginBottom: SP[2] }}>By Product</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[2] }}>
          {result.products.map(p => (
            <div key={p.product} style={{ padding: `${SP[1]} ${SP[3]}`, background: 'var(--th-bg)', borderRadius: RADIUS.full, fontSize: TEXT.xs, fontFamily: INTER, color: 'var(--txt)', display: 'flex', gap: SP[2] }}>
              <span>{p.product}</span>
              <span style={{ fontWeight: FW.bold, color: BLUE, ...NUM }}>{p.txn_count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Errors */}
      {result.errors.length > 0 && (
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, fontFamily: INTER, marginBottom: SP[2] }}>
            {result.errors.length} warning{result.errors.length !== 1 ? 's' : ''}
          </div>
          {result.errors.map((e, i) => (
            <div key={i} style={{ fontSize: TEXT.xs, color: AMBER, fontFamily: INTER, padding: `${SP[1]} ${SP[2]}` }}>{e}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function InterswitchImport() {
  const [files, setFiles]     = useState<File[]>([])
  const [stage, setStage]     = useState<Stage>('idle')
  const [result, setResult]   = useState<ImportResult | null>(null)
  const [error, setError]     = useState<string | null>(null)

  const handleFiles = useCallback((fl: FileList) => {
    setFiles(Array.from(fl))
    setStage('selected')
    setResult(null)
    setError(null)
  }, [])

  const handleImport = useCallback(async () => {
    if (!files.length) return
    setStage('importing')
    setError(null)
    try {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      const r = await apiFetch<{ data: ImportResult }>('/api/cards/interswitch/import', {
        method: 'POST',
        body: form,
        headers: {},  // let browser set Content-Type with boundary
      })
      setResult(r.data)
      setStage('done')
    } catch (e: any) {
      setError(e.message)
      setStage('error')
    }
  }, [files])

  const reset = useCallback(() => {
    setFiles([]); setStage('idle'); setResult(null); setError(null)
  }, [])

  const importing = stage === 'importing'

  return (
    <Page
      title="Import Interswitch EODTXN"
      subtitle="Upload daily CCS Report 620 files to ingest card transactions"
      back={{ label: 'Interswitch', to: '/settlements/interswitch' }}
    >
      <ErrBanner error={error} onRetry={reset} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[5], alignItems: 'start' }}>
        {/* Left — upload section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          <SectionCard title="Upload Files">
            {stage === 'idle' || stage === 'selected' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
                <DropZone onFiles={handleFiles} />
                {files.length > 0 && <FileList files={files} onClear={reset} />}
                {files.length > 0 && (
                  <button
                    onClick={handleImport}
                    disabled={importing}
                    style={{
                      height: 40, borderRadius: RADIUS.md, border: 'none', cursor: 'pointer',
                      background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                      fontFamily: INTER, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP[2],
                    }}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 18 }}>cloud_upload</span>
                    Import {files.length} file{files.length !== 1 ? 's' : ''}
                  </button>
                )}
              </div>
            ) : stage === 'importing' ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP[3], padding: '32px 0' }}>
                <div style={{ width: 40, height: 40, border: `3px solid ${NAVY}30`, borderTopColor: NAVY, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
                  Parsing {files.length} file{files.length !== 1 ? 's' : ''}…
                </span>
                <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP[3], padding: '24px 0' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 40, color: stage === 'done' ? GREEN : RED }}>
                  {stage === 'done' ? 'check_circle' : 'error'}
                </span>
                <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>
                  {stage === 'done' ? 'Import complete' : 'Import failed'}
                </span>
                <button onClick={reset} style={{ padding: '6px 20px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'none', cursor: 'pointer', fontSize: TEXT.sm, fontFamily: INTER, color: 'var(--txt)' }}>
                  Import more files
                </button>
              </div>
            )}
          </SectionCard>

          {/* Format guide */}
          <SectionCard title="File Format" subtitle="Expected CCS Report 620 structure">
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {[
                { icon: 'calendar_today',  label: 'Filename pattern',    value: 'EODTXN.YYYYMMDD.HHMMSS' },
                { icon: 'business',        label: 'Source system',       value: 'Interswitch CCS: Report 620' },
                { icon: 'account_balance', label: 'Branches supported',  value: '0001 (Default), 4009 (Sales Agency)' },
                { icon: 'credit_card',     label: 'Products',            value: 'Classic · Platinum · Prestige · PREP · Business · Amex' },
                { icon: 'swap_horiz',      label: 'Txn types',           value: 'Utility · Cash Advance · Purchase · Web Transfer' },
                { icon: 'attach_money',    label: 'Currency',            value: 'NGN (amounts in Naira, stored as kobo)' },
              ].map(row => (
                <div key={row.label} style={{ display: 'flex', gap: SP[3], alignItems: 'flex-start', padding: `${SP[2]} 0`, borderBottom: '1px solid var(--bdr)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: BLUE, flexShrink: 0, marginTop: 2 }}>{row.icon}</span>
                  <div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{row.label}</div>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: INTER }}>{row.value}</div>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>

        {/* Right — results */}
        <SectionCard title="Import Results" subtitle={result ? `${result.files_processed} file${result.files_processed !== 1 ? 's' : ''} processed` : 'Results appear here after import'}>
          {!result ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP[3], padding: '48px 0', color: 'var(--txt3)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 40 }}>inbox</span>
              <span style={{ fontSize: TEXT.sm, fontFamily: INTER }}>No import results yet</span>
            </div>
          ) : (
            <ResultPanel result={result} />
          )}
        </SectionCard>
      </div>
    </Page>
  )
}
