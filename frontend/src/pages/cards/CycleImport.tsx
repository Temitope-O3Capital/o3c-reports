import { useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, BLUE, GREEN, AMBER, RED, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'

interface ImportResult {
  cycle_date: string
  accounts_merged: number
  rows_upserted: number
  reports: Record<string, number>
  products: Record<string, string>
  errors: string[]
}

const back = { label: 'Credit Card Portfolio', to: '/cards/credit-portfolio' }

function DropZone({ onFiles }: { onFiles: (f: FileList) => void }) {
  const [over, setOver] = useState(false)
  return (
    <label
      onDragOver={e => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files) }}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 8, padding: '40px 24px', borderRadius: RADIUS.lg, cursor: 'pointer',
        border: `2px dashed ${over ? BLUE : 'var(--bdr)'}`, background: over ? `${BLUE}0A` : 'var(--row-hvr)',
        transition: 'all 130ms',
      }}>
      <input type="file" multiple style={{ display: 'none' }}
        onChange={e => { if (e.target.files?.length) onFiles(e.target.files) }} />
      <span className="material-symbols-rounded" style={{ fontSize: 34, color: over ? BLUE : 'var(--txt3)' }}>upload_file</span>
      <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>Drop cycle reports here, or click to browse</div>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, textAlign: 'center', maxWidth: 460 }}>
        Upload the four Udara cycle files together: cyc_bal_rpt, cyc_chg_rpt, cyc_int_rpt, cyc_loc_rpt.
        Each file is auto-detected by its header; the statement date sets the cycle.
      </div>
    </label>
  )
}

export default function CycleImport() {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const addFiles = useCallback((fl: FileList) => {
    setFiles(prev => {
      const names = new Set(prev.map(f => f.name))
      return [...prev, ...Array.from(fl).filter(f => !names.has(f.name))]
    })
  }, [])

  const reset = () => { setFiles([]); setResult(null); setError(null) }

  const doImport = useCallback(async () => {
    if (!files.length) return
    setBusy(true); setError(null); setResult(null)
    try {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      const r = await apiFetch<any>('/api/cards-credit/import', { method: 'POST', body: form })
      setResult(r?.data ?? r)
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }, [files])

  return (
    <Page title="Import Cycle Data" subtitle="Ingest revolving credit-card billing-cycle reports from core banking (Udara)" back={back}>
      <ErrBanner error={error} onRetry={doImport} />

      <SectionCard title="Upload" style={{ marginBottom: 14 }}>
        <DropZone onFiles={addFiles} />
        {files.length > 0 && (
          <div style={{ marginTop: SP[3] }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>{files.length} file{files.length !== 1 ? 's' : ''} selected</span>
              <button onClick={reset} style={{ fontSize: TEXT.sm, color: RED, background: 'none', border: 'none', cursor: 'pointer', fontFamily: INTER }}>Clear</button>
            </div>
            {files.map(f => (
              <div key={f.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--row-hvr)', borderRadius: RADIUS.sm, marginBottom: 4 }}>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{f.name}</span>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{(f.size / 1024).toFixed(0)} KB</span>
              </div>
            ))}
            <button onClick={doImport} disabled={busy} style={{
              marginTop: 10, padding: '9px 18px', borderRadius: RADIUS.md, border: 'none',
              background: busy ? 'var(--bdr)' : NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
              cursor: busy ? 'default' : 'pointer', fontFamily: INTER,
            }}>{busy ? 'Importing…' : `Import ${files.length} file${files.length !== 1 ? 's' : ''}`}</button>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Import Results" subtitle={result ? `Cycle ${result.cycle_date}` : 'Results appear here after import'}>
        {result ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
              <KpiCard label="Cycle Date" value={result.cycle_date} icon="event" accent={NAVY} />
              <KpiCard label="Accounts Merged" value={fmtNum(result.accounts_merged)} icon="merge" accent={BLUE} />
              <KpiCard label="Rows Upserted" value={fmtNum(result.rows_upserted)} icon="check_circle" accent={GREEN} />
              <KpiCard label="Products" value={fmtNum(Object.keys(result.products || {}).length)} icon="category" accent={AMBER} />
            </div>
            <div style={{ display: 'flex', gap: SP[3], flexWrap: 'wrap', marginBottom: result.errors?.length ? 14 : 0 }}>
              {Object.entries(result.reports || {}).map(([k, v]) => (
                <div key={k} style={{ padding: '6px 12px', background: 'var(--row-hvr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontFamily: INTER, color: 'var(--txt2)' }}>
                  <span style={{ textTransform: 'uppercase', fontWeight: FW.bold, color: 'var(--txt)' }}>{k}</span> · {fmtNum(v)} rows
                </div>
              ))}
            </div>
            {result.errors?.length > 0 && (
              <div style={{ padding: 12, background: `${RED}0A`, border: `1px solid ${RED}22`, borderRadius: RADIUS.md }}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, marginBottom: 6, fontFamily: INTER }}>{result.errors.length} error{result.errors.length !== 1 ? 's' : ''}</div>
                {result.errors.slice(0, 20).map((e, i) => (
                  <div key={i} style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>{e}</div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: TEXT.base, fontFamily: INTER }}>No import yet</div>
        )}
      </SectionCard>
    </Page>
  )
}
