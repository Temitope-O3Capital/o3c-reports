import { useState, useRef, useCallback, useEffect } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, StatusBadge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrapList } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, NAVY, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// Dedicated importer for the real Interswitch SETTLEMENT feed (→ interswitch_transactions).
// Distinct from the CCS EODTXN importer (/reports/uploads/interswitch). Reached from
// the Data Management hub.

interface ImportResult {
  import_id: number
  files: number
  legs: number
  inserted: number
  skipped: number
  errors: string[]
}

interface ImportRow {
  id: number
  started_at: string
  finished_at: string
  status: string
  files_n: number
  legs_n: number
  inserted_n: number
  skipped_n: number
  errors: string
  actor: string
}

const HISTORY_COLS: TableCol<ImportRow>[] = [
  { key: 'started_at', label: 'When', width: 150, render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.started_at)}</span> },
  { key: 'actor', label: 'By', render: r => <span style={{ fontSize: TEXT.sm }}>{r.actor || 'system'}</span> },
  { key: 'files_n', label: 'Files', align: 'right', render: r => <span style={NUM}>{fmtNum(r.files_n)}</span> },
  { key: 'legs_n', label: 'Legs', align: 'right', render: r => <span style={NUM}>{fmtNum(r.legs_n)}</span> },
  { key: 'inserted_n', label: 'Inserted', align: 'right', render: r => <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtNum(r.inserted_n)}</span> },
  { key: 'skipped_n', label: 'Skipped', align: 'right', render: r => <span style={{ ...NUM, color: 'var(--txt3)' }}>{fmtNum(r.skipped_n)}</span> },
  { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status || 'unknown'} /> },
]

function DropZone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files) }}
      onDragOver={e => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${over ? BLUE : 'var(--bdr)'}`, borderRadius: RADIUS.xl,
        padding: '48px 32px', textAlign: 'center', cursor: 'pointer',
        background: over ? `${BLUE}08` : 'var(--card)', transition: 'all 150ms',
      }}
    >
      <input ref={inputRef} type="file" multiple accept="*/*" style={{ display: 'none' }}
        onChange={e => { if (e.target.files?.length) onFiles(e.target.files) }} />
      <span className="material-symbols-rounded" style={{ fontSize: 40, color: over ? BLUE : 'var(--txt3)', display: 'block', marginBottom: SP[3] }}>upload_file</span>
      <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER, marginBottom: SP[1] }}>
        Drop Interswitch settlement reports here, or click to browse
      </div>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
        Drop a whole day's folder — aggregate/NIBSS rollup files are skipped automatically.
      </div>
    </div>
  )
}

function ResultPanel({ result }: { result: ImportResult }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: SP[3] }}>
        {[
          { label: 'Files Processed', value: fmtNum(result.files), color: NAVY },
          { label: 'Settlement Legs', value: fmtNum(result.legs), color: BLUE },
          { label: 'Inserted', value: fmtNum(result.inserted), color: GREEN },
          { label: 'Skipped (duplicates)', value: fmtNum(result.skipped), color: AMBER },
        ].map(k => (
          <div key={k.label} style={{ padding: SP[4], background: `${k.color}08`, borderRadius: RADIUS.lg, border: `1px solid ${k.color}20` }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginBottom: SP[1] }}>{k.label}</div>
            <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: k.color, fontFamily: INTER, ...NUM }}>{k.value}</div>
          </div>
        ))}
      </div>
      {result.errors?.length > 0 && (
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, fontFamily: INTER, marginBottom: SP[2] }}>
            {result.errors.length} warning{result.errors.length !== 1 ? 's' : ''}
          </div>
          {result.errors.map((e, i) => (
            <div key={i} style={{ fontSize: TEXT.xs, color: AMBER, fontFamily: 'var(--font-mono)', padding: `${SP[1]} ${SP[2]}` }}>{e}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SettlementImport() {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ImportRow[]>([])
  const [histLoading, setHistLoading] = useState(true)

  const loadHistory = useCallback(async () => {
    setHistLoading(true)
    try {
      const r = await apiFetch('/api/interswitch/imports')
      setHistory(unwrapList<ImportRow>(r))
    } catch { /* history is best-effort */ }
    finally { setHistLoading(false) }
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  const addFiles = useCallback((fl: FileList) => {
    setFiles(Array.from(fl))
    setResult(null)
    setError(null)
  }, [])

  const doImport = useCallback(async () => {
    if (!files.length) return
    setBusy(true); setError(null); setResult(null)
    try {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      const r = await apiFetch<ImportResult>('/api/interswitch/import', { method: 'POST', body: form })
      setResult(r)
      setFiles([])
      loadHistory()
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }, [files, loadHistory])

  return (
    <Page
      title="Import Interswitch Settlement"
      subtitle="Upload Interswitch settlement reports into the reconciliation ledger"
      back={{ label: 'Data Management', to: '/reports/uploads' }}
    >
      <ErrBanner error={error} onRetry={doImport} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[5], alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          <SectionCard title="Upload Files">
            <DropZone onFiles={addFiles} />
            {files.length > 0 && (
              <div style={{ marginTop: SP[3] }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: INTER }}>{files.length} file{files.length !== 1 ? 's' : ''} selected</span>
                  <button onClick={() => setFiles([])} style={{ fontSize: TEXT.sm, color: RED, background: 'none', border: 'none', cursor: 'pointer', fontFamily: INTER }}>Clear</button>
                </div>
                <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {files.map(f => (
                    <div key={f.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--row-hvr)', borderRadius: RADIUS.sm }}>
                      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER, flexShrink: 0, marginLeft: 8 }}>{(f.size / 1024).toFixed(0)} KB</span>
                    </div>
                  ))}
                </div>
                <button onClick={doImport} disabled={busy} style={{
                  marginTop: 10, height: 40, width: '100%', borderRadius: RADIUS.md, border: 'none',
                  background: busy ? 'var(--bdr)' : NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                  cursor: busy ? 'default' : 'pointer', fontFamily: INTER, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 18 }}>cloud_upload</span>
                  {busy ? 'Importing…' : `Import ${files.length} file${files.length !== 1 ? 's' : ''}`}
                </button>
              </div>
            )}
          </SectionCard>
        </div>

        <SectionCard title="Import Results" subtitle={result ? `Import #${result.import_id}` : 'Results appear here after import'}>
          {result
            ? <ResultPanel result={result} />
            : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP[3], padding: '48px 0', color: 'var(--txt3)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 40 }}>inbox</span>
                <span style={{ fontSize: TEXT.sm, fontFamily: INTER }}>No import yet</span>
              </div>
            )}
        </SectionCard>
      </div>

      <div style={{ height: SP[5] }} />

      <SectionCard title="Import history" subtitle="Recent settlement imports" padding={false}>
        <DataTable cols={HISTORY_COLS} rows={history} keyFn={(r, i) => r.id ?? i} loading={histLoading} emptyText="No imports yet" pageSize={15} />
      </SectionCard>
    </Page>
  )
}
