import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, Spinner, ErrBanner, NAVY, GREEN, RED, AMBER } from '../../components/UI'
import { toast } from 'sonner'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

interface ZohoStatus {
  connected: boolean
  org_id: string
  data_centre: string
  client_id_set: boolean
  client_secret_set: boolean
  api_reachable?: boolean
  api_error?: string
}

interface ZohoImportResult {
  imported: number
  skipped: number
  failed: number
  next_from?: number
  done?: boolean
}

function StatusDot({ ok, label }: { ok: boolean | undefined; label: string }) {
  const color = ok === undefined ? AMBER : ok ? GREEN : RED
  const icon = ok === undefined ? 'pending' : ok ? 'check_circle' : 'cancel'
  return (
    <div className="flex items-center gap-2">
      <span className="material-symbols-rounded text-[16px]" style={{ color }}>{icon}</span>
      <span className="text-[13px] text-slate-700">{label}</span>
    </div>
  )
}

function CredRow({ label, set, envKey }: { label: string; set: boolean; envKey: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b last:border-0"
      style={{ borderColor: 'rgba(15,23,42,0.06)' }}>
      <div>
        <p className="text-[13px] font-medium text-slate-800">{label}</p>
        <p className="text-[11px] text-slate-400 font-mono">{envKey}</p>
      </div>
      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${set ? 'text-green-700 bg-green-50' : 'text-red-600 bg-red-50'}`}>
        {set ? 'Set' : 'Not set'}
      </span>
    </div>
  )
}

export default function ZohoIntegration() {
  const [status, setStatus] = useState<ZohoStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [syncing, setSyncing]   = useState(false)
  const [importing, setImporting]   = useState(false)
  const [importResult, setImportResult] = useState<ZohoImportResult | null>(null)
  const [orgIdInput, setOrgIdInput] = useState('')
  const [savingOrgId, setSavingOrgId] = useState(false)
  const [err, setErr] = useState('')
  const [params] = useSearchParams()

  useEffect(() => {
    if (params.get('zoho') === 'connected') {
      toast.success('Zoho Desk connected successfully')
    }
    load()
  }, [])

  async function load() {
    setLoading(true); setErr('')
    try {
      const s = await apiFetch<ZohoStatus>('/api/zoho/status')
      setStatus(s)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }

  async function connect() {
    setConnecting(true)
    try {
      const res = await apiFetch<{ auth_url: string }>('/api/zoho/oauth/connect')
      // Open in the same window so the OAuth callback redirect works
      window.location.href = res.auth_url
    } catch (e: any) {
      toast.error(e.message)
      setConnecting(false)
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect Zoho Desk? Ticket sync will stop and the refresh token will be cleared.')) return
    setDisconnecting(true)
    try {
      await apiFetch('/api/zoho/oauth/disconnect', { method: 'DELETE' })
      toast.success('Zoho disconnected')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setDisconnecting(false) }
  }

  async function syncNow() {
    setSyncing(true)
    try {
      const res = await apiFetch<{ synced: number; failed: number; total: number }>('/api/zoho/desk/sync', { method: 'POST' })
      toast.success(`Synced ${res.synced} tickets${res.failed > 0 ? ` (${res.failed} failed)` : ''}`)
    } catch (e: any) { toast.error(e.message) }
    finally { setSyncing(false) }
  }

  async function saveOrgId() {
    if (!orgIdInput.trim()) return
    setSavingOrgId(true)
    try {
      await apiFetch('/api/zoho/org-id', { method: 'POST', body: JSON.stringify({ org_id: orgIdInput.trim() }) })
      toast.success('Org ID saved')
      setOrgIdInput('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSavingOrgId(false) }
  }

  async function importFromZoho() {
    if (!confirm('Import all existing Zoho Desk tickets into O3C? This may take a minute for large volumes. Tickets already imported will be skipped.')) return
    setImporting(true); setImportResult(null)
    try {
      let from = 0
      const totals: ZohoImportResult = { imported: 0, skipped: 0, failed: 0, done: false, next_from: 0 }
      for (let i = 0; i < 100 && !totals.done; i++) {
        const res = await apiFetch<ZohoImportResult>('/api/zoho/desk/import', {
          method: 'POST',
          body: JSON.stringify({ from, max_pages: 5 }),
        })
        totals.imported += res.imported ?? 0
        totals.skipped += res.skipped ?? 0
        totals.failed += res.failed ?? 0
        totals.done = !!res.done
        totals.next_from = res.next_from ?? from
        from = totals.next_from
        setImportResult({ ...totals })
        if (!res.done && res.next_from === undefined) break
      }
      const failedText = totals.failed > 0 ? `, ${totals.failed} failed` : ''
      toast.success(`Zoho import finished: ${totals.imported} imported, ${totals.skipped} skipped${failedText}`)
    } catch (e: any) { toast.error(e.message) }
    finally { setImporting(false) }
  }

  const notConfigured = status && (!status.client_id_set || !status.client_secret_set)

  return (
    <Page dept="Admin" title="Zoho Integration"
      subtitle="Connect Zoho Desk for ticket sync and Zoho Voice for click-to-call">

      <ErrBanner msg={err} />

      {loading ? (
        <div className="flex items-center justify-center py-24"><Spinner size={32} /></div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Connection card */}
          <div className="lg:col-span-2 space-y-6">
            <SectionCard title="Zoho Desk">
              <div className="px-6 py-5">
                {/* Status banner */}
                <div className={`flex items-center gap-3 p-4 rounded-xl mb-6 ${status?.connected ? 'bg-green-50' : 'bg-slate-50'}`}>
                  <span className="material-symbols-rounded text-[28px]"
                    style={{ color: status?.connected ? GREEN : '#94a3b8' }}>
                    {status?.connected ? 'check_circle' : 'link_off'}
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold text-slate-800">
                      {status?.connected ? 'Connected to Zoho Desk' : 'Not connected'}
                    </p>
                    {status?.connected && status.org_id && (
                      <p className="text-[12px] text-slate-500">
                        Org ID: <span className="font-mono">{status.org_id}</span> · DC: <span className="font-mono">{status.data_centre}</span>
                      </p>
                    )}
                    {!status?.connected && (
                      <p className="text-[12px] text-slate-500">
                        Connect to sync helpdesk tickets bidirectionally with Zoho Desk
                      </p>
                    )}
                  </div>
                  <div className="ml-auto">
                    {status?.connected ? (
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <button onClick={importFromZoho} disabled={importing}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold border transition-colors hover:bg-white disabled:opacity-60"
                          style={{ borderColor: 'rgba(15,23,42,0.15)', color: NAVY }}
                          title="Pull all existing tickets from Zoho Desk into O3C">
                          <span className={`material-symbols-rounded text-[14px] ${importing ? 'animate-spin' : ''}`}>
                            {importing ? 'progress_activity' : 'download'}
                          </span>
                          {importing ? 'Importing…' : 'Import from Zoho'}
                        </button>
                        <button onClick={syncNow} disabled={syncing}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold border transition-colors hover:bg-white disabled:opacity-60"
                          style={{ borderColor: 'rgba(15,23,42,0.15)', color: NAVY }}>
                          <span className="material-symbols-rounded text-[14px]">sync</span>
                          {syncing ? 'Syncing…' : 'Sync Now'}
                        </button>
                        <button onClick={disconnect} disabled={disconnecting}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-60">
                          <span className="material-symbols-rounded text-[14px]">link_off</span>
                          {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      </div>
                    ) : (
                      <button onClick={connect} disabled={connecting || !!notConfigured}
                        title={notConfigured ? 'Set ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET first' : ''}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-50"
                        style={{ background: NAVY }}>
                        <span className="material-symbols-rounded text-[16px]">open_in_browser</span>
                        {connecting ? 'Redirecting…' : 'Connect with Zoho'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Import result */}
                {importResult && (
                  <div className="flex items-center gap-3 p-3 rounded-xl mb-4 bg-blue-50 text-[13px]">
                    <span className="material-symbols-rounded text-[18px] text-blue-600">download_done</span>
                    <span className="text-blue-800">
                      Import {importResult.done ? 'complete' : 'in progress'} — <strong>{importResult.imported}</strong> imported,{' '}
                      <strong>{importResult.skipped}</strong> already existed,{' '}
                      {importResult.failed > 0 && <><strong className="text-red-600">{importResult.failed}</strong> failed,{' '}</>}
                      <a href="/helpdesk" className="underline font-semibold">view in Helpdesk</a>
                    </span>
                    <button onClick={() => setImportResult(null)} className="ml-auto text-blue-400 hover:text-blue-600">
                      <span className="material-symbols-rounded text-[16px]">close</span>
                    </button>
                  </div>
                )}

                {/* Checklist */}
                <div className="space-y-2">
                  <StatusDot ok={status?.client_id_set} label="Client ID configured (ZOHO_CLIENT_ID)" />
                  <StatusDot ok={status?.client_secret_set} label="Client Secret configured (ZOHO_CLIENT_SECRET)" />
                  <StatusDot ok={status?.connected} label="OAuth refresh token stored" />
                  <StatusDot ok={status?.org_id ? true : undefined} label={`Org ID set${status?.org_id ? ` (${status.org_id})` : ''}`} />
                  {!status?.org_id && (
                    <div className="ml-6 flex gap-2 items-center pt-1">
                      <input
                        value={orgIdInput}
                        onChange={e => setOrgIdInput(e.target.value)}
                        placeholder="Paste your Zoho Org ID…"
                        className="flex-1 px-3 py-1.5 rounded-lg border text-[12px] font-mono outline-none"
                        style={{ borderColor: 'rgba(15,23,42,0.2)' }}
                      />
                      <button onClick={saveOrgId} disabled={savingOrgId || !orgIdInput.trim()}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-50"
                        style={{ background: NAVY }}>
                        {savingOrgId ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  )}
                  {!status?.org_id && (
                    <p className="ml-6 text-[11px] text-slate-400">
                      Find it in Zoho Desk → Settings → Company Settings → your Org ID, or in your Zoho Desk URL after <code className="font-mono">/support/</code>
                    </p>
                  )}
                  <StatusDot ok={status?.api_reachable} label="Zoho Desk API reachable" />
                  {status?.api_error && (
                    <p className="ml-6 text-[11px] text-red-500 break-words">
                      {status.api_error}
                    </p>
                  )}
                </div>
              </div>
            </SectionCard>

            {/* Sync behaviour */}
            <SectionCard title="Sync Behaviour">
              <div className="px-6 py-4 space-y-4 text-[13px] text-slate-600">
                <div className="flex gap-3">
                  <span className="material-symbols-rounded text-[18px] text-blue-500 flex-shrink-0 mt-0.5">arrow_forward</span>
                  <div>
                    <p className="font-semibold text-slate-800 mb-0.5">O3C → Zoho Desk (push)</p>
                    <p>When a ticket is created or updated here, it is pushed to Zoho Desk automatically. Open tickets without a Zoho ID are synced hourly. Use "Sync Now" to force an immediate push.</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="material-symbols-rounded text-[18px] text-green-600 flex-shrink-0 mt-0.5">arrow_back</span>
                  <div>
                    <p className="font-semibold text-slate-800 mb-0.5">Zoho Desk → O3C (webhook)</p>
                    <p>Register this webhook URL in <strong>Zoho Desk → Settings → Automations → Notifications</strong>:</p>
                    <code className="block mt-1.5 bg-slate-50 rounded-lg px-3 py-2 text-[12px] font-mono select-all break-all"
                      style={{ border: '1px solid rgba(15,23,42,0.08)' }}>
                      {API}/api/zoho/webhooks/desk
                    </code>
                    <p className="mt-1 text-[11px] text-slate-400">Trigger events: Ticket Created, Ticket Status Changed, Ticket Updated</p>
                  </div>
                </div>
              </div>
            </SectionCard>

            {/* Zoho Voice */}
            <SectionCard title="Zoho Voice (Click-to-Call)">
              <div className="px-6 py-5">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(22,101,52,0.08)' }}>
                    <span className="material-symbols-rounded text-[20px]" style={{ color: GREEN }}>call</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-[14px] font-semibold text-slate-800 mb-1">Click-to-call from any ticket</p>
                    <p className="text-[13px] text-slate-500 mb-4">
                      When Zoho Desk is connected, agents can click "Call via Zoho" inside any helpdesk ticket to initiate an outbound call through Zoho Voice. The call is automatically logged to the call log with duration and outcome.
                    </p>
                    <div className="rounded-xl p-4 space-y-2 text-[12px]"
                      style={{ background: 'rgba(14,40,65,0.04)' }}>
                      <p className="font-semibold text-slate-700">To enable Zoho Voice PhoneBridge (optional)</p>
                      <p className="text-slate-500">
                        Add the PhoneBridge SDK to <code className="font-mono bg-white px-1 rounded">frontend/index.html</code> once your Zoho Voice account is set up:
                      </p>
                      <code className="block bg-white rounded-lg p-2 font-mono select-all break-all border"
                        style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
                        {`<script src="https://phonebridges.zoho.com/assets/js/zoho-phonebridgesdk.js"></script>`}
                      </code>
                      <p className="text-slate-400 text-[11px]">This enables the in-browser soft phone. Without it, calls are initiated via the Zoho Desk REST API instead.</p>
                    </div>
                  </div>
                </div>
              </div>
            </SectionCard>
          </div>

          {/* Right column — setup guide */}
          <div className="space-y-4">
            <SectionCard title="Setup Guide">
              <div className="px-5 py-4 space-y-4">
                <SetupStep n={1} done={status?.client_id_set ?? false}
                  title="Create OAuth app"
                  detail="Go to api-console.zoho.com → Add Client → Server-based Applications. Copy Client ID and Client Secret." />
                <SetupStep n={2} done={status?.client_id_set && status?.client_secret_set}
                  title="Add credentials"
                  detail="In Admin → API Keys, add ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET. Or set them as Railway env vars." />
                <SetupStep n={3} done={status?.connected ?? false}
                  title="Connect with Zoho"
                  detail='Click "Connect with Zoho" above. You will be redirected to Zoho to authorise access, then returned here.' />
                <SetupStep n={4} done={!!(status?.org_id)}
                  title="Org ID auto-detected"
                  detail="After connecting, your Zoho Desk org ID is automatically fetched and stored." />
                <SetupStep n={5} done={false}
                  title="Register webhook"
                  detail="Copy the webhook URL from the Sync Behaviour section and register it in Zoho Desk → Settings → Automations → Notifications." />
              </div>
            </SectionCard>

            <SectionCard title="Environment Variables">
              <div className="px-5 py-2 pb-4">
                <CredRow label="Client ID" set={status?.client_id_set ?? false} envKey="ZOHO_CLIENT_ID" />
                <CredRow label="Client Secret" set={status?.client_secret_set ?? false} envKey="ZOHO_CLIENT_SECRET" />
                <CredRow label="Org ID" set={!!(status?.org_id)} envKey="ZOHO_ORG_ID" />
                <CredRow label="Refresh Token" set={status?.connected ?? false} envKey="ZOHO_REFRESH_TOKEN" />
                <div className="mt-3">
                  <p className="text-[11px] text-slate-400">
                    <span className="font-semibold">ZOHO_DC</span> — set to <code className="font-mono">eu</code>, <code className="font-mono">in</code>, or <code className="font-mono">com.au</code> if your Zoho account is not US-based. Defaults to <code className="font-mono">com</code>.
                  </p>
                </div>
              </div>
            </SectionCard>
          </div>
        </div>
      )}
    </Page>
  )
}

function SetupStep({ n, done, title, detail }: { n: number; done: boolean | undefined; title: string; detail: string }) {
  return (
    <div className="flex gap-3">
      <div className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[11px] font-bold mt-0.5
        ${done ? 'text-white' : 'text-slate-400 border-2 border-slate-200'}`}
        style={done ? { background: GREEN } : {}}>
        {done ? <span className="material-symbols-rounded text-[13px]">check</span> : n}
      </div>
      <div>
        <p className={`text-[13px] font-semibold ${done ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{title}</p>
        <p className="text-[12px] text-slate-500 mt-0.5">{detail}</p>
      </div>
    </div>
  )
}
