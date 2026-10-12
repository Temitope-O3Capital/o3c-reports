import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Page, SectionCard, Button, ErrBanner, Badge, Sk, EmptyState,
} from '../../components/UI'
import { apiFetch, apiPost, unwrap } from '../../lib/api'
import { NAVY, GREEN, RED, AMBER, MONO, FW, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

/*
  WhatsApp — setup and health.

  THE SCREEN FOR THE DAY THE CREDENTIALS ARRIVE. Connecting a WhatsApp Business Account
  has four parts that fail independently and silently: the phone number id, the access
  token, the app secret that signs webhooks, and the verify token Meta echoes when you
  subscribe. Miss any one and the symptom is identical — nothing happens — and the logs
  that would say which are on a server nobody doing the onboarding can read.

  So each part is reported separately, with WHAT BREAKS without it rather than a tick.

  IT SHOWS NO SECRETS AND SETS NONE. Values are entered in Integrations, where secrets
  already live; a second way to set one is a second way to leak one, and a setup screen
  that printed a token would put a WABA-wide bearer credential into every screenshot of
  a support call.
*/

interface CredState {
  key: string
  set: boolean
  length: number
  source: string
  needed: string
}

interface Status {
  credentials: CredState[]
  ready_to_send: boolean
  webhook_url: string
  webhook_public: boolean
  webhook_warning?: string
  graph_version: string
  traffic?: Record<string, number>
  open_windows?: number
}

interface TestResult {
  ok: boolean
  phone_number: string
  verified_name: string
  quality_rating: string
  platform: string
}

/** Meta's own wording: Green is healthy, Red for 7 days costs a messaging tier. */
function qualityColour(q: string) {
  const v = (q || '').toUpperCase()
  if (v.includes('GREEN')) return GREEN
  if (v.includes('YELLOW')) return AMBER
  if (v.includes('RED')) return RED
  return 'var(--txt3)'
}

export default function WhatsAppSetup() {
  const [status, setStatus] = useState<Status | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  const load = useCallback(() => {
    setErr(null)
    apiFetch('/api/whatsapp-admin/status')
      .then(res => setStatus(unwrap<Status>(res)))
      .catch(e => setErr(e?.message || 'Could not read the WhatsApp status'))
  }, [])
  useEffect(() => { load() }, [load])

  async function runTest() {
    setTesting(true); setResult(null)
    try {
      const res = unwrap<TestResult>(await apiPost('/api/whatsapp-admin/test', {}))
      setResult(res)
      toast.success('Meta answered. The account is reachable.')
    } catch (e: any) {
      toast.error(e?.message || 'Meta did not accept the request')
    } finally {
      setTesting(false)
    }
  }

  function copyWebhook() {
    if (!status?.webhook_url) return
    navigator.clipboard?.writeText(status.webhook_url)
      .then(() => toast.success('Webhook URL copied'))
      .catch(() => toast.error('Could not copy. Select the text instead.'))
  }

  return (
    <Page
      title="WhatsApp"
      subtitle="Setup and health for the WhatsApp Business Account. Values are entered in Integrations; this screen checks them and tells Meta's side of the story."
      actions={
        <Button icon="cable" onClick={runTest} loading={testing}
          disabled={!status?.credentials?.slice(0, 2).every(c => c.set)}>
          Test Connection
        </Button>
      }
    >
      {err && <ErrBanner error={err} onRetry={load} />}
      {!status ? <Sk h={220} /> : (
        <div style={{ display: 'grid', gap: SP[5] }}>

          {/* ── Credentials ── */}
          <SectionCard
            title="Credentials"
            subtitle="Set these in Admin → Integrations. Nothing here reveals a value."
            actions={status.ready_to_send
              ? <Badge variant="success">Ready To Send</Badge>
              : <Badge variant="warning">Not Connected</Badge>}
          >
            <div style={{ display: 'grid', gap: SP[3] }}>
              {status.credentials.map(c => (
                <div key={c.key} style={{
                  display: 'flex', gap: SP[3], alignItems: 'start',
                  padding: SP[3], borderRadius: 8,
                  border: `1px solid ${c.set ? 'var(--bdr)' : AMBER + '55'}`,
                  background: c.set ? 'transparent' : AMBER + '0D',
                }}>
                  <span className="material-symbols-rounded" aria-hidden="true"
                    style={{ fontSize: 18, color: c.set ? GREEN : AMBER, marginTop: 1 }}>
                    {c.set ? 'check_circle' : 'error'}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: MONO, fontSize: TEXT.sm, fontWeight: FW.medium }}>
                      {c.key}
                    </div>
                    {c.set ? (
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
                        Set · {c.length} characters · from {c.source}
                      </div>
                    ) : (
                      // The consequence, not a label. "Missing" tells nobody what it costs.
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 3, lineHeight: 1.5 }}>
                        {c.needed}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* ── Webhook ── */}
          <SectionCard
            title="Webhook"
            subtitle="Paste this into Meta → WhatsApp → Configuration → Callback URL, with the verify token."
          >
            {status.webhook_url ? (
              <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{
                  fontFamily: MONO, fontSize: TEXT.sm, padding: `${SP[2]}px ${SP[3]}px`,
                  background: 'var(--bg2)', borderRadius: 6, border: '1px solid var(--bdr)',
                  wordBreak: 'break-all', flex: '1 1 320px',
                }}>{status.webhook_url}</code>
                <Button variant="secondary" size="sm" icon="content_copy" onClick={copyWebhook}>Copy</Button>
              </div>
            ) : (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                No public base URL is configured, so there is no webhook address to give Meta.
              </div>
            )}

            {status.webhook_warning && (
              // This is the failure that already cost this platform every campaign open
              // and every CSAT response, so it is stated rather than hinted.
              <div style={{
                marginTop: SP[4], padding: SP[4], borderRadius: 8,
                border: `1px solid ${RED}44`, background: RED + '0D',
                fontSize: TEXT.sm, lineHeight: 1.6, color: 'var(--txt)',
              }}>
                <strong style={{ display: 'block', marginBottom: SP[1] }}>
                  Meta cannot reach this address
                </strong>
                {status.webhook_warning}
              </div>
            )}
            <div style={{ marginTop: SP[4], fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              Graph API <span style={{ fontFamily: MONO }}>{status.graph_version?.split('/').pop()}</span>
            </div>
          </SectionCard>

          {/* ── Test result ── */}
          {result && (
            <SectionCard title="Meta's Answer" actions={<Badge variant="success">Reachable</Badge>}>
              <div style={{
                display: 'grid', gap: SP[4],
                gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
              }}>
                <Field label="Number" value={result.phone_number || '—'} />
                <Field label="Verified Name" value={result.verified_name || '—'} />
                <Field label="Quality Rating" value={result.quality_rating || 'Unknown'}
                  colour={qualityColour(result.quality_rating)} />
                <Field label="Platform" value={result.platform || '—'} />
              </div>
              <p style={{ marginTop: SP[4], fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.6 }}>
                Quality rating governs how many unique customers the number may reach in 24 hours.
                A sustained Red costs a messaging tier, so it is worth watching here rather than
                only in Meta's dashboard.
              </p>
            </SectionCard>
          )}

          {/* ── Traffic ── */}
          <SectionCard
            title="Traffic"
            subtitle="From the message ledger: every WhatsApp message in both directions."
            actions={
              <Link to="/reports/builder?dataset=whatsapp_messages"
                style={{ fontSize: TEXT.sm, color: NAVY, fontWeight: FW.medium }}>
                Open in Report Builder →
              </Link>
            }
          >
            {status.traffic && Number(status.traffic.total) > 0 ? (
              <div style={{
                display: 'grid', gap: SP[4],
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              }}>
                <Field label="Total" value={Number(status.traffic.total).toLocaleString('en-NG')} />
                <Field label="Inbound" value={Number(status.traffic.inbound).toLocaleString('en-NG')} />
                <Field label="Outbound" value={Number(status.traffic.outbound).toLocaleString('en-NG')} />
                <Field label="Failed" value={Number(status.traffic.failed).toLocaleString('en-NG')}
                  colour={Number(status.traffic.failed) > 0 ? RED : undefined} />
                <Field label="From Ads" value={Number(status.traffic.from_ads).toLocaleString('en-NG')} />
                <Field label="Last 24 Hours" value={Number(status.traffic.last_24h).toLocaleString('en-NG')} />
                <Field label="Open Windows" value={Number(status.open_windows ?? 0).toLocaleString('en-NG')} />
              </div>
            ) : (
              <EmptyState
                icon="forum"
                title="No Messages Yet"
                description="Nothing has been sent or received. Once the credentials are in and Meta can reach the webhook, every message appears here and in the Report Builder."
              />
            )}
          </SectionCard>
        </div>
      )}
    </Page>
  )
}

function Field({ label, value, colour }: { label: string; value: string; colour?: string }) {
  return (
    <div>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>{label}</div>
      <div style={{
        fontSize: TEXT.base, fontWeight: FW.semibold,
        color: colour || 'var(--txt)', fontVariantNumeric: 'tabular-nums',
      }}>{value}</div>
    </div>
  )
}
