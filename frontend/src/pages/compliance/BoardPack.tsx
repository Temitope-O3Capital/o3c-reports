import { useState, useEffect } from 'react'
import { Page, SectionCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { NAVY, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Metric {
  label: string
  value: string
}

interface BoardPackData {
  month: string
  metrics: Metric[]
}

// ── Month picker helpers ───────────────────────────────────────────────────────

function prevMonthISO(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthOptions(): { value: string; label: string }[] {
  const opts = []
  const d = new Date()
  d.setDate(1)
  for (let i = 0; i < 12; i++) {
    d.setMonth(d.getMonth() - 1)
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    opts.push({ value: val, label: d.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }) })
  }
  return opts
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BoardPack() {
  const [month, setMonth] = useState(prevMonthISO())
  const [data, setData] = useState<BoardPackData | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    setLoading(true)
    setErr('')
    apiFetch<any>(`/api/compliance/board-pack?month=${month}`)
      .then(j => setData(j?.data ?? j))
      .catch(() => setErr('Failed to load board pack data'))
      .finally(() => setLoading(false))
  }, [month])

  const openPDF = () => {
    // Opens print-optimised HTML in a new tab; browser File > Print → Save as PDF
    const url = `/api/compliance/board-pack?month=${month}&format=html`
    // apiFetch adds auth header; for window.open we need the token in the URL query
    const token = localStorage.getItem('o3c_token') ?? ''
    // Open via form POST to carry the auth header — simpler: open in new tab with token as query param
    // Backend already reads Authorization header from EventSource; for HTML pages, embed the token.
    // Simplest cross-browser approach: fetch HTML and open a blob URL.
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.text())
      .then(html => {
        const blob = new Blob([html], { type: 'text/html' })
        const blobUrl = URL.createObjectURL(blob)
        window.open(blobUrl, '_blank')
      })
  }

  const options = monthOptions()

  return (
    <Page title="Board Pack">
      <div style={{ display: 'flex', gap: SP[3], alignItems: 'center', marginBottom: SP[4] }}>
        <label style={{ fontSize: TEXT.sm, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          Reporting month:
        </label>
        <select
          value={month}
          onChange={e => setMonth(e.target.value)}
          style={{
            padding: `${SP[1]} ${SP[2]}`,
            borderRadius: RADIUS.md,
            border: '1px solid var(--border)',
            fontSize: TEXT.sm,
            background: 'var(--card)',
            color: 'var(--text)',
          }}
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          onClick={openPDF}
          style={{
            marginLeft: 'auto',
            padding: `${SP[2]} ${SP[3]}`,
            background: NAVY,
            color: '#fff',
            border: 'none',
            borderRadius: RADIUS.md,
            fontSize: TEXT.sm,
            fontWeight: FW.semibold,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: SP[1],
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
          Export PDF
        </button>
      </div>

      {err && <ErrBanner error={err} />}

      <SectionCard title={data ? `Board Pack: ${data.month}` : 'Board Pack'}>
        {loading ? (
          <p style={{ color: 'var(--muted)', fontSize: TEXT.sm, padding: SP[4] }}>Loading…</p>
        ) : data ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{
                  padding: `${SP[2]} ${SP[3]}`,
                  background: 'var(--th-bg)',
                  color: 'var(--text)',
                  fontSize: TEXT.xs,
                  fontWeight: FW.semibold,
                  textAlign: 'left',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--border)',
                }}>Metric</th>
                <th style={{
                  padding: `${SP[2]} ${SP[3]}`,
                  background: 'var(--th-bg)',
                  color: 'var(--text)',
                  fontSize: TEXT.xs,
                  fontWeight: FW.semibold,
                  textAlign: 'right',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--border)',
                }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {(data.metrics ?? []).map((m, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--row-alt)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                  onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--row-alt)')}
                >
                  <td style={{
                    padding: `${SP[2]} ${SP[3]}`,
                    fontSize: TEXT.sm,
                    color: 'var(--muted)',
                    borderBottom: '1px solid var(--border)',
                  }}>{m.label}</td>
                  <td style={{
                    padding: `${SP[2]} ${SP[3]}`,
                    fontSize: TEXT.sm,
                    fontWeight: FW.semibold,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    borderBottom: '1px solid var(--border)',
                  }}>{m.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </SectionCard>

      <p style={{ marginTop: SP[3], fontSize: TEXT.xs, color: 'var(--muted)' }}>
        Board packs are also emailed automatically to the BOARD_EMAIL_LIST on the 1st of each month.
      </p>
    </Page>
  )
}
