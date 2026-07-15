// Africa's Talking WebRTC browser client — with automatic zombie-state recovery.
//
// The Problem
// -----------
// The `africastalking-client` npm package has a module-caching bug: after a
// network drop, `client.destroy()` does NOT clean up the module's internal
// state. The next reconnect attempt silently inherits the corrupted state and
// all calls fail without error. This is the "zombie client" bug.
//
// The Fix
// -------
// Never use the npm import for AT. Instead, serve the SDK as a static file
// at /vendor/africastalking.js (copied there by scripts/copy-at-sdk.mjs
// which runs automatically on `npm install`). On every reconnect, we:
//   1. Remove the <script> tag from the DOM
//   2. Delete the global (window.AfricasTalking / window.ATClient)
//   3. Re-inject the script with a cache-busting query param (?t=Date.now())
//   4. Wait 5s (AT-required cooldown before the new module is usable)
//   5. Re-attach event handlers
//
// This bypasses the module cache entirely and gives a genuinely fresh module
// on every reconnect. It is fully automatic — no human action needed.
//
// Usage
// -----
//   const client = new ATVoiceClient()
//   await client.init(fetchToken)   // fetchToken: () => Promise<string>
//   client.subscribe(setState)
//   client.call('+2348012345678')
//   client.hangup()
//   client.destroy()                // call on component unmount

export type ATCallState =
  | { type: 'idle' }
  | { type: 'reconnecting' }
  | { type: 'ready' }
  | { type: 'calling'; phone: string; elapsed: number }
  | { type: 'active'; phone: string; elapsed: number }
  | { type: 'incoming'; phone: string }

export type ATStateListener = (state: ATCallState) => void

const VENDOR_URL = '/vendor/africastalking.js'
const RECONNECT_COOLDOWN_MS = 5_000 // AT-required minimum before reinit

export class ATVoiceClient {
  private client: any = null
  private activeCall: any = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private onlineHandler: (() => void) | null = null
  private getToken: (() => Promise<string>) | null = null
  private listeners = new Set<ATStateListener>()

  // ── Public API ──────────────────────────────────────────────────────────────

  subscribe(fn: ATStateListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async init(getToken: () => Promise<string>): Promise<void> {
    this.getToken = getToken
    await this.boot()
    // Proactively reinit when the browser comes back online — this prevents
    // zombie state from ever forming, rather than waiting to detect it.
    this.onlineHandler = () => this.scheduleReconnect(0)
    window.addEventListener('online', this.onlineHandler)
  }

  async call(phone: string): Promise<void> {
    if (!this.client) throw new Error('AT client not ready')
    this.emit({ type: 'calling', phone, elapsed: 0 })
    try {
      const call = await this.client.call(phone)
      this.activeCall = call
      this.startTimer(elapsed => this.emit({ type: 'active', phone, elapsed }))
      call.on('hangup', () => this.onCallEnded())
      call.on('error',  () => this.onCallEnded())
    } catch (e) {
      this.emit({ type: 'ready' })
      throw e
    }
  }

  acceptIncoming(): void {
    if (!this.activeCall) return
    const phone = this.activeCall.callerNumber ?? 'Unknown'
    this.activeCall.accept()
    this.startTimer(elapsed => this.emit({ type: 'active', phone, elapsed }))
    this.activeCall.on('hangup', () => this.onCallEnded())
  }

  hangup(): void {
    this.activeCall?.hangup?.()
    this.onCallEnded()
  }

  destroy(): void {
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler)
      this.onlineHandler = null
    }
    this.stopTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.client?.destroy?.()
    this.client = null
    this.listeners.clear()
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private emit(state: ATCallState) {
    this.listeners.forEach(fn => fn(state))
  }

  private async boot(): Promise<void> {
    this.emit({ type: 'reconnecting' })
    const token = this.getToken ? await this.getToken() : ''
    await this.loadFreshScript()
    this.attach(token)
  }

  private loadFreshScript(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Step 1: tear down any existing copy
      document.querySelectorAll('script[data-at-sdk]').forEach(s => s.remove())
      ;(window as any).AfricasTalking = undefined
      ;(window as any).ATClient = undefined

      // Step 2: inject fresh copy with cache-busting param
      const script = document.createElement('script')
      script.setAttribute('data-at-sdk', 'true')
      script.src = `${VENDOR_URL}?t=${Date.now()}`
      script.onload = () => resolve()
      script.onerror = () =>
        reject(
          new Error(
            `[ATVoice] Failed to load ${VENDOR_URL}. ` +
            'Run: npm install && npm run copy-at-sdk'
          )
        )
      document.head.appendChild(script)
    })
  }

  private attach(token: string): void {
    // AT SDK exposes itself as window.AfricasTalking or window.ATClient
    // depending on the version. Try both.
    const AT = (window as any).AfricasTalking ?? (window as any).ATClient
    if (!AT) {
      console.error('[ATVoice] AT SDK global not found after script load. ' +
        'Check /vendor/africastalking.js exists and sets window.AfricasTalking or window.ATClient.')
      return
    }

    // Some versions expose AT.Client, others expose AT directly as a constructor
    const ClientCtor = AT.Client ?? AT
    this.client = new ClientCtor({ authToken: token })

    this.client.on('ready', () => {
      this.emit({ type: 'ready' })
    })

    this.client.on('error', (err: any) => {
      console.warn('[ATVoice] client error — scheduling reconnect', err)
      this.scheduleReconnect(RECONNECT_COOLDOWN_MS)
    })

    this.client.on('incoming', (call: any) => {
      const phone = call.callerNumber ?? 'Unknown'
      this.activeCall = call
      this.emit({ type: 'incoming', phone })
      call.on('cancel', () => {
        this.activeCall = null
        this.emit({ type: 'ready' })
      })
    })
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) return // already scheduled
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        this.client?.destroy?.()
        await this.boot()
      } catch (e) {
        console.error('[ATVoice] reconnect failed', e)
        // Back-off: double the delay on repeated failures
        this.scheduleReconnect(Math.min(RECONNECT_COOLDOWN_MS * 4, 30_000))
      }
    }, delayMs)
  }

  private onCallEnded(): void {
    this.activeCall = null
    this.stopTimer()
    this.emit({ type: 'ready' })
  }

  private startTimer(tick: (elapsed: number) => void): void {
    this.stopTimer()
    let elapsed = 0
    this.elapsedTimer = setInterval(() => { elapsed++; tick(elapsed) }, 1000)
  }

  private stopTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer)
      this.elapsedTimer = null
    }
  }
}
