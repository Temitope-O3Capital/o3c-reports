import { useEffect } from 'react'
import { apiPost, API, getCsrfToken } from '../lib/api'

// Keeps a call-centre agent's presence live for as long as the workspace is open, so
// "distribute to online agents" is accurate and nobody has to remember to flip a switch:
//
//   • on mount        → one "initial" ping that brings an offline agent online (auto-online on login)
//   • every 60s       → a heartbeat that only refreshes last-seen (a manual Break/Offline is respected)
//   • on tab close    → a best-effort keepalive POST that flips the agent offline (auto-offline)
//
// Even if the close beacon never fires (crash, killed tab), the 5-minute staleness window
// on the server means the agent still drops out of the "online" set for distribution.
//
// Mount this once in the authenticated shell, enabled only for call-facing roles — NOT per
// page, so navigating between pages doesn't let the heartbeat lapse.
export function useAgentPresence(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let alive = true

    const ping = (initial: boolean) => {
      // silent so a transient failure never logs the agent out of the whole app.
      apiPost('/api/call-center/presence/ping', { initial }).catch(() => {})
    }
    ping(true)
    const id = window.setInterval(() => { if (alive) ping(false) }, 60_000)

    // keepalive lets the request outlive the page; sendBeacon can't set the CSRF header.
    const goOffline = () => {
      try {
        fetch(`${API}/api/call-center/presence/offline`, {
          method: 'POST',
          credentials: 'include',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: '{}',
        }).catch(() => {})
      } catch { /* best-effort */ }
    }
    window.addEventListener('pagehide', goOffline)

    return () => {
      alive = false
      window.clearInterval(id)
      window.removeEventListener('pagehide', goOffline)
      // Note: no offline on unmount — that fires on in-app navigation too, and the agent
      // is still working. Real tab-close is covered by pagehide; idle by heartbeat staleness.
    }
  }, [enabled])
}
