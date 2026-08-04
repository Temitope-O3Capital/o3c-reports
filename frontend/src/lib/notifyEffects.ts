// Sound + voice effects for incoming notifications.
// Preferences are per-user/per-browser (localStorage) so each person opts in/out
// independently. Sound defaults ON; voice defaults OFF.
//
// Voice uses the browser SpeechSynthesis API but PREFERS a human-sounding Nigerian
// English neural voice — Ezinne (female) / Abeo (male), which Edge/Chromium expose
// for free (they are Azure neural voices surfaced through the OS/browser). It falls
// back to any en-NG, then other African/en-GB voices, then the default. No API keys,
// no external calls, CSP-safe.

const SOUND_KEY = 'o3c_notif_sound'
const VOICE_KEY = 'o3c_notif_voice' // 'off' | 'female' | 'male'

export type VoiceMode = 'off' | 'female' | 'male'

export function getSoundPref(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== '0' } catch { return true }
}
export function setSoundPref(on: boolean): void {
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0') } catch {}
}
export function getVoiceMode(): VoiceMode {
  try {
    const v = localStorage.getItem(VOICE_KEY)
    return v === 'female' || v === 'male' ? v : 'off'
  } catch { return 'off' }
}
export function setVoiceMode(m: VoiceMode): void {
  try { localStorage.setItem(VOICE_KEY, m) } catch {}
}

// ── Sound ───────────────────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null

function ctx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return null
    if (!audioCtx) audioCtx = new AC()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch { return null }
}

// primeAudio unlocks the AudioContext on a user gesture (browsers block audio
// until the user has interacted). Call from a click handler (e.g. the bell).
export function primeAudio(): void {
  ctx()
  // Warm the voice list (populated asynchronously) and the clip manifest.
  loadVoices()
  void loadManifest()
}

// A short, pleasant two-tone chime (A5 → D6).
export function playChime(): void {
  const ac = ctx()
  if (!ac) return
  const now = ac.currentTime
  const notes: [number, number][] = [[880, 0], [1174.66, 0.12]]
  for (const [freq, t] of notes) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    osc.connect(gain)
    gain.connect(ac.destination)
    const start = now + t
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35)
    osc.start(start)
    osc.stop(start + 0.4)
  }
}

// ── Voice ───────────────────────────────────────────────────────────────────

let voiceCache: SpeechSynthesisVoice[] = []

function loadVoices(): SpeechSynthesisVoice[] {
  try {
    if (!('speechSynthesis' in window)) return []
    const v = window.speechSynthesis.getVoices()
    if (v && v.length) voiceCache = v
    return voiceCache
  } catch { return [] }
}

// Some browsers populate voices asynchronously — refresh the cache when they arrive.
try {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => { loadVoices() }
    loadVoices()
  }
} catch {}

// Nigerian-first voice selection. Preference order:
//   1. Named Nigerian neural voices (Ezinne=female, Abeo=male)
//   2. Any en-NG voice matching the requested gender hint
//   3. Any en-NG voice
//   4. A "Natural"/"Online" en-GB voice (still human-sounding)
//   5. First English voice / default
function pickVoice(gender: 'female' | 'male'): SpeechSynthesisVoice | null {
  const voices = voiceCache.length ? voiceCache : loadVoices()
  if (!voices.length) return null
  const byName = (kw: string) => voices.find(v => v.name.toLowerCase().includes(kw))
  const named = gender === 'female' ? (byName('ezinne') || byName('funmi') || byName('ngozi'))
                                    : (byName('abeo')   || byName('femi')  || byName('tunde'))
  if (named) return named

  const isNG = (v: SpeechSynthesisVoice) => /(-|_)?ng\b/i.test(v.lang) || /nigeria/i.test(v.name)
  const femaleHint = (v: SpeechSynthesisVoice) => /female|ezinne|funmi|ngozi|zira|aria|jenny/i.test(v.name)
  const maleHint   = (v: SpeechSynthesisVoice) => /male|abeo|femi|tunde|david|guy|ryan/i.test(v.name)

  const ng = voices.filter(isNG)
  const ngGender = ng.find(v => gender === 'female' ? femaleHint(v) : maleHint(v))
  if (ngGender) return ngGender
  if (ng.length) return ng[0]

  // Human-sounding online/natural English fallback, gender-matched.
  const natural = voices.filter(v => /natural|online|neural/i.test(v.name) && /^en/i.test(v.lang))
  const naturalGender = natural.find(v => gender === 'female' ? femaleHint(v) : maleHint(v))
  if (naturalGender) return naturalGender
  if (natural.length) return natural[0]

  const en = voices.filter(v => /^en/i.test(v.lang))
  const enGender = en.find(v => gender === 'female' ? femaleHint(v) : maleHint(v))
  return enGender || en[0] || voices[0] || null
}

export function speak(text: string, gender: 'female' | 'male'): void {
  try {
    if (!('speechSynthesis' in window) || !text) return
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice(gender)
    if (v) { u.voice = v; u.lang = v.lang }
    u.rate = 0.98
    u.pitch = 1.0
    u.volume = 0.95
    window.speechSynthesis.cancel() // don't stack
    window.speechSynthesis.speak(u)
  } catch {}
}

// Returns the resolved voice's display name for the current gender (for UI hints).
export function currentVoiceName(gender: 'female' | 'male'): string {
  if (clipKeys) return 'O3C Nigerian voice (recorded)'
  const v = pickVoice(gender)
  return v ? v.name : 'default voice'
}

// ── Pre-rendered clips (human Nigerian voice) ─────────────────────────────────
// When notif-audio clips are deployed, we play a recorded phrase per event type in
// the chosen gender — a consistent human Nigerian voice for every user/browser.
// If no clips are deployed (or the specific one fails), we fall back to the browser
// SpeechSynthesis voice. Manifest: /notif-audio/manifest.json → { keys: string[] }.

const CLIP_BASE = '/notif-audio'
let clipKeys: Set<string> | null = null      // null = not loaded / unavailable
let manifestTried = false

async function loadManifest(): Promise<void> {
  if (manifestTried) return
  manifestTried = true
  try {
    const res = await fetch(`${CLIP_BASE}/manifest.json`, { cache: 'no-cache' })
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data?.keys) && data.keys.length) clipKeys = new Set<string>(data.keys)
  } catch { /* no clips deployed — browser voice is used */ }
}

// Plays the recorded clip for (key, gender). Resolves true if it started, false otherwise.
function playClip(key: string, gender: 'female' | 'male'): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const audio = new Audio(`${CLIP_BASE}/${key}_${gender}.mp3`)
      audio.volume = 0.95
      audio.onerror = () => resolve(false)
      audio.play().then(() => resolve(true)).catch(() => resolve(false))
    } catch { resolve(false) }
  })
}

// announce plays whichever effects the user has enabled for one new notification.
// eventType selects a recorded clip (falling back to a 'default' clip, then to the
// browser voice reading the title).
export function announce(title: string, eventType?: string): void {
  if (getSoundPref()) playChime()
  const mode = getVoiceMode()
  if (mode === 'off') return
  void voiceOut(title, mode, eventType)
}

async function voiceOut(title: string, gender: 'female' | 'male', eventType?: string): Promise<void> {
  await loadManifest()
  if (clipKeys && clipKeys.size) {
    const key = eventType && clipKeys.has(eventType) ? eventType : 'default'
    if (clipKeys.has(key) && await playClip(key, gender)) return
  }
  // No usable clip → read the title with the browser voice.
  speak(title, gender)
}

// preview plays a sample in the given gender — the recorded 'default' clip if deployed,
// otherwise the browser voice. Used by the settings Test / Female / Male buttons.
export async function preview(gender: 'female' | 'male'): Promise<void> {
  await loadManifest()
  if (clipKeys && clipKeys.has('default') && await playClip('default', gender)) return
  speak('This is a test alert from your O3 Capital Workspace.', gender)
}

// true once a recorded-clip manifest has been found (for UI labelling).
export function usingRecordedClips(): boolean { return !!(clipKeys && clipKeys.size) }
