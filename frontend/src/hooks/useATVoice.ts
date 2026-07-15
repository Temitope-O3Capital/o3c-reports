// React hook that manages the AT WebRTC client lifecycle.
// Handles token fetching, auto-reconnect, and exposes a clean call/hangup API.
//
// If the backend returns 503 (AT_API_KEY / AT_USERNAME not set), `configured`
// stays false and the dialer is hidden — no error shown to the user.
//
// Usage:
//   const { state, configured, call, acceptIncoming, hangup } = useATVoice()
//   if (!configured) return null
//   // render dialer using `state`

import { useEffect, useRef, useState, useCallback } from 'react'
import { ATVoiceClient, type ATCallState } from '../lib/atVoice'
import { apiFetch } from '../lib/api'

interface ATTokenResponse {
  token: string
  at_phone_number?: string
  clientName?: string
  lifeTimeSec?: number
}

async function fetchToken(): Promise<string> {
  const data = await apiFetch<ATTokenResponse>('/api/voice/at-token')
  if (!data?.token) throw new Error('AT token response missing token field')
  return data.token
}

export function useATVoice() {
  const clientRef = useRef<ATVoiceClient | null>(null)
  const [state, setState] = useState<ATCallState>({ type: 'idle' })
  const [configured, setConfigured] = useState(false)

  useEffect(() => {
    let unsub: (() => void) | null = null
    let mounted = true

    async function start() {
      const client = new ATVoiceClient()
      clientRef.current = client
      unsub = client.subscribe(s => { if (mounted) setState(s) })
      try {
        await client.init(fetchToken)
        if (mounted) setConfigured(true)
      } catch (e: any) {
        // 503 = AT not configured on server — silently hide the dialer
        // Other errors = log but don't crash the page
        if (!String(e?.message ?? '').includes('503')) {
          console.warn('[useATVoice]', e?.message ?? e)
        }
      }
    }

    start()
    return () => {
      mounted = false
      unsub?.()
      clientRef.current?.destroy()
      clientRef.current = null
    }
  }, [])

  const call = useCallback(async (phone: string) => {
    await clientRef.current?.call(phone)
  }, [])

  const acceptIncoming = useCallback(() => {
    clientRef.current?.acceptIncoming()
  }, [])

  const hangup = useCallback(() => {
    clientRef.current?.hangup()
  }, [])

  return { state, configured, call, acceptIncoming, hangup }
}
