// Phoenix's credit report, rendered in the workspace by Phoenix's own panel.
//
// EyeDecisionPanel.tsx beside this file is a verbatim copy of the component Phoenix
// renders for the same decision. It is deliberately NOT re-implemented: an
// approximation drifts, and the moment it does, Sales and Risk are reading a
// different report from the one the credit decision was actually made on.
//
// This container does the three things the copy cannot do for itself: fetch the
// decision through the workspace's own authenticated API, scope Phoenix's design
// tokens so the report looks like Phoenix without repainting the workspace around
// it, and say plainly when there is no report yet.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../../lib/api'
import { fmtKobo, fmtDatetime } from '../../../lib/fmt'
import { EyeDecisionPanel } from './EyeDecisionPanel'
import { CreditReportBody, type ReportResp } from '../CreditReport'
import type { EyeDecisionDetail } from './eyeTypes'
import './phoenix-tokens.css'
import './phoenix-content.css'

type Resp = {
  decision: EyeDecisionDetail | null
  // Why there is nothing to show. Absent when a decision is present.
  reason?: 'not_submitted' | 'not_scored'
}

const NOTE: Record<string, { title: string; body: string }> = {
  not_submitted: {
    title: 'Not sent to Phoenix yet',
    body: 'This application has not been submitted for credit decisioning, so there is no Eye report for it. It is created once the application reaches risk review.',
  },
  not_scored: {
    title: 'Awaiting a decision',
    body: 'Phoenix has the application but has not scored it yet. The report appears here as soon as a decision is recorded.',
  },
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div style={{
      padding: '28px 24px', textAlign: 'center', border: '1px dashed var(--bdr)',
      borderRadius: 12, background: 'var(--th-bg)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--txt2)', maxWidth: 460, margin: '0 auto', lineHeight: 1.55 }}>{body}</div>
    </div>
  )
}

export default function PhoenixEyeReport({ appId }: { appId: number | string }) {
  const [detail, setDetail] = useState<EyeDecisionDetail | undefined>()
  const [reason, setReason] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const res = await apiFetch<{ data: Resp }>(`/api/los/${appId}/eye-decision`)
      setDetail(res.data?.decision ?? undefined)
      setReason(res.data?.decision ? undefined : (res.data?.reason ?? 'not_scored'))
    } catch (e) {
      // A failure to reach Phoenix is not the same as "no report", and must not be
      // rendered as one — an operator seeing "awaiting a decision" would wait for
      // something that is never coming.
      setError(e instanceof Error ? e.message : 'Could not load the report')
    } finally {
      setLoading(false)
    }
  }, [appId])

  useEffect(() => { void load() }, [load])

  if (error) {
    return <Notice title="Could not load the Eye report" body={error} />
  }
  if (!loading && !detail) {
    const n = NOTE[reason ?? 'not_scored'] ?? NOTE.not_scored
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Notice title={n.title} body={n.body} />
      </div>
    )
  }

  // phx-eye-report carries Phoenix's tokens. Everything inside is Phoenix's own
  // markup, untouched.
  //
  // The prequalification report is NOT here. It used to sit below this panel, which
  // buried it under the full decision detail — an officer had to scroll past every
  // statement section to reach it. It now renders on the Overview, next to the
  // decision it supports, and PrequalSection is exported for that.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="phx-eye-report">
        <EyeDecisionPanel decisionDetail={detail} loading={loading} onRefresh={() => void load()} />
      </div>
    </div>
  )
}

// Phoenix's prequalification report — the affordability and bureau case behind the
// decision. A one-line headline of the figures that decide it, expanding to every
// field Phoenix sends. Each view places it directly under the verdict, because it is
// the evidence for it; it used to follow the offer panels (or, on the Risk view, the
// documents), well below where anyone reading the verdict would look.
export function PrequalSection({ appId }: { appId: number | string }) {
  const [open, setOpen]   = useState(false)
  const [data, setData]   = useState<ReportResp | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setData(null); setError(null)
    apiFetch<{ data: ReportResp }>(`/api/los/${appId}/credit-report`)
      .then(res => { if (current) setData(res.data ?? { report: null }) })
      .catch(e => { if (current) setError(e instanceof Error ? e.message : 'Could not load the report') })
    return () => { current = false }
  }, [appId])

  const r = data?.report ?? null
  const route = String(r?.recommended_route ?? '').toUpperCase()
  const routeTone = route === 'APPROVE' ? '#15803D' : route === 'DECLINE' ? '#C00000' : route ? '#B45309' : ''

  // The figures a credit decision turns on, in the order an officer weighs them.
  const facts: string[] = []
  if (r) {
    if (r.risk_band) facts.push(`Band ${r.risk_band}`)
    if (r.probability_of_default != null) facts.push(`PD ${Math.round(Number(r.probability_of_default) * 100)}%`)
    if (r.max_loan_amount_minor != null) facts.push(`Max loan ${fmtKobo(Number(r.max_loan_amount_minor))}`)
    if (r.recommended_limit_minor != null) facts.push(`Limit ${fmtKobo(Number(r.recommended_limit_minor))}`)
    else if (r.recommended_amount_minor != null) facts.push(`Amount ${fmtKobo(Number(r.recommended_amount_minor))}`)
    if (r.disposable_income_minor != null) facts.push(`Disposable ${fmtKobo(Number(r.disposable_income_minor))}/mo`)
  }
  const gateRaw = r?.hard_gate_triggered ? String(r.hard_gate_reason ?? '').replace(/^hard_gate_/, '').replace(/_/g, ' ') : ''
  const gate = gateRaw.length > 0 && gateRaw.length <= 4 ? gateRaw.toUpperCase() : gateRaw
  const flags = Array.isArray(r?.risk_flags) ? r!.risk_flags.length : 0

  return (
    <div style={{ border: '1px solid var(--card-bdr)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
      <button
        onClick={() => r && setOpen(o => !o)}
        aria-expanded={open}
        disabled={!r}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 18px',
          background: 'transparent', border: 'none', cursor: r ? 'pointer' : 'default', textAlign: 'left',
        }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt2)', visibility: r ? 'visible' : 'hidden' }}>
          {open ? 'expand_more' : 'chevron_right'}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>Prequalification</span>
        {route && (
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.03em', padding: '2px 9px', borderRadius: 20,
            color: routeTone, background: `color-mix(in srgb, ${routeTone} 12%, transparent)` }}>
            {route.replace(/_/g, ' ')}
          </span>
        )}
        <span style={{ fontSize: 12.5, color: 'var(--txt2)', flex: '1 1 240px', minWidth: 0, lineHeight: 1.5 }}>
          {error
            ? error
            : !data
              ? 'Reading the report from Phoenix…'
              : !r
                ? (data.stale_reason || 'No report yet. Phoenix produces it when it scores the application.')
                : <>
                    {facts.join(' · ')}
                    {gate && <b style={{ color: '#C00000' }}>{facts.length ? ' · ' : ''}Hard gate: {gate}</b>}
                    {flags > 0 && ` · ${flags} risk flag${flags === 1 ? '' : 's'}`}
                  </>}
        </span>
        {r && (
          <span title={data?.stale_reason || undefined}
            style={{ fontSize: 11.5, color: data?.live ? 'var(--txt3)' : '#B45309', whiteSpace: 'nowrap' }}>
            {data?.live ? 'live from Phoenix' : `stored copy${data?.updated_at ? ` · ${fmtDatetime(data.updated_at)}` : ''}`}
          </span>
        )}
      </button>
      {open && r && data && (
        <div style={{ borderTop: '1px solid var(--bdr)', padding: '12px 18px 14px' }}>
          <CreditReportBody data={data} />
        </div>
      )}
    </div>
  )
}
