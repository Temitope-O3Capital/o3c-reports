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
import { EyeDecisionPanel } from './EyeDecisionPanel'
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
    return <Notice title={n.title} body={n.body} />
  }

  // phx-eye-report carries Phoenix's tokens. Everything inside is Phoenix's own
  // markup, untouched.
  return (
    <div className="phx-eye-report">
      <EyeDecisionPanel decisionDetail={detail} loading={loading} onRefresh={() => void load()} />
    </div>
  )
}
