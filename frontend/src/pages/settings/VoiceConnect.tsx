import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, Spinner, NAVY, GREEN, RED, AMBER } from '../../components/UI'
import { toast } from 'sonner'

interface VoiceStatus {
  connected: boolean
  access_token: string
  token_valid: boolean
  connected_at: string
  email: string
}

export default function VoiceConnect() {
  const [status, setStatus]   = useState<VoiceStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [searchParams]        = useSearchParams()

  useEffect(() => {
    load()
    if (searchParams.get('connected') === 'true') {
      toast.success('Zoho Voice connected — you can now make calls directly from O3C')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function load() {
    setLoading(true)
    apiFetch<VoiceStatus>('/api/voice/status')
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  async function connectVoice() {
    setWorking(true)
    try {
      const res = await apiFetch<{ auth_url: string }>('/api/voice/connect')
      if (res.auth_url) window.location.href = res.auth_url
    } catch (e: any) {
      toast.error(e.message || 'Could not start Zoho Voice OAuth')
    } finally {
      setWorking(false)
    }
  }

  async function disconnectVoice() {
    setWorking(true)
    try {
      await apiFetch('/api/voice/disconnect', { method: 'DELETE' })
      toast.success('Zoho Voice disconnected')
      load()
    } catch (e: any) {
      toast.error(e.message || 'Disconnect failed')
    } finally {
      setWorking(false)
    }
  }

  return (
    <Page
      dept="Settings"
      title="Zoho Voice"
      subtitle="Connect your Zoho Voice account to make calls directly from O3C"
    >
      <SectionCard title="Your Zoho Voice Connection" className="max-w-xl">
        {loading ? (
          <div className="flex items-center justify-center py-12"><Spinner size={28} /></div>
        ) : (
          <div className="px-5 py-5 space-y-5">
            {/* Status indicator */}
            <div className="flex items-center gap-3 p-4 rounded-xl"
              style={{ background: status?.connected ? 'rgba(22,101,52,0.06)' : 'rgba(15,23,42,0.04)' }}>
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ background: status?.connected ? GREEN : '#94A3B8' }}
              />
              <div className="flex-1">
                <p className="text-[14px] font-semibold text-slate-800">
                  {status?.connected ? 'Connected' : 'Not connected'}
                </p>
                {status?.connected && (
                  <p className="text-[12px] text-slate-500 mt-0.5">
                    {status.email && `Zoho account: ${status.email}`}
                    {status.connected_at && ` · Connected ${new Date(status.connected_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                  </p>
                )}
              </div>
              {status?.connected && (
                <div className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full"
                  style={{
                    background: status.token_valid ? 'rgba(22,101,52,0.1)' : 'rgba(217,119,6,0.1)',
                    color:      status.token_valid ? GREEN : AMBER,
                  }}>
                  <span className="material-symbols-rounded text-[13px]">
                    {status.token_valid ? 'verified' : 'refresh'}
                  </span>
                  {status.token_valid ? 'Token valid' : 'Refreshing…'}
                </div>
              )}
            </div>

            {/* What this does */}
            {!status?.connected && (
              <div className="space-y-2">
                <p className="text-[13px] font-semibold text-slate-700">What you get after connecting:</p>
                <ul className="space-y-1.5">
                  {[
                    'Click any phone number on a ticket to dial directly from O3C',
                    'No phone dialer or extension needed — calls run in your browser',
                    'Call logs are saved automatically to the ticket',
                    'One-time setup — stays connected until you disconnect',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-2 text-[12px] text-slate-600">
                      <span className="material-symbols-rounded text-[14px] flex-shrink-0 mt-0.5" style={{ color: GREEN }}>check_circle</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Action button */}
            {status?.connected ? (
              <div className="flex items-center gap-3">
                <button
                  onClick={connectVoice}
                  disabled={working}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold border transition-all disabled:opacity-50"
                  style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}
                >
                  <span className="material-symbols-rounded text-[16px]">refresh</span>
                  Reconnect
                </button>
                <button
                  onClick={disconnectVoice}
                  disabled={working}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold border transition-all disabled:opacity-50"
                  style={{ borderColor: 'rgba(192,0,0,0.2)', color: RED }}
                >
                  <span className="material-symbols-rounded text-[16px]">link_off</span>
                  Disconnect
                </button>
                {working && <Spinner size={16} />}
              </div>
            ) : (
              <button
                onClick={connectVoice}
                disabled={working}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-50"
                style={{ background: NAVY }}
              >
                {working ? (
                  <Spinner size={16} />
                ) : (
                  <span className="material-symbols-rounded text-[16px]">link</span>
                )}
                Connect Zoho Voice
              </button>
            )}

            <p className="text-[11px] text-slate-400">
              You'll be redirected to Zoho to authorise O3C. Each team member connects their own account independently.
              {' '}Admin Zoho credentials must be set in Admin → API Keys first.
            </p>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
