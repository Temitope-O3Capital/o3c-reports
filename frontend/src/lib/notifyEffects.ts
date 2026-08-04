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
  // Warm the voice list too (getVoices() is populated asynchronously).
  loadVoices()
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
  const v = pickVoice(gender)
  return v ? v.name : 'default voice'
}

// announce plays whichever effects the user has enabled for one new notification.
export function announce(title: string): void {
  if (getSoundPref()) playChime()
  const mode = getVoiceMode()
  if (mode !== 'off') speak(title, mode)
}
