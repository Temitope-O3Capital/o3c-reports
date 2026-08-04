// Shared personalization layer for campaign/message content — merge fields, live
// sample rendering, cursor insertion, and SMS segment math. Used by the email,
// SMS and WhatsApp authoring surfaces so behaviour is consistent across channels.

export interface MergeField {
  key: string
  label: string
  sample: string     // value used in the "preview with sample data" mode
  fallback: string   // suggested default for {{key|fallback}}
}

// Fields the dispatch renderer (backend renderTemplate) knows how to fill from a
// contact + campaign. Keep in sync with campaigns.go mergeData keys.
export const MERGE_FIELDS: MergeField[] = [
  { key: 'first_name', label: 'First name',  sample: 'Ada',                     fallback: 'there' },
  { key: 'last_name',  label: 'Last name',   sample: 'Okoro',                   fallback: '' },
  { key: 'full_name',  label: 'Full name',   sample: 'Ada Okoro',               fallback: 'Customer' },
  { key: 'amount',     label: 'Amount',      sample: '₦150,000',                fallback: 'your balance' },
  { key: 'due_date',   label: 'Due date',    sample: '15 Aug 2026',             fallback: 'soon' },
  { key: 'cif_number', label: 'CIF number',  sample: 'CIF00012345',             fallback: '' },
  { key: 'phone',      label: 'Phone',       sample: '0803 123 4567',           fallback: '' },
  { key: 'email',      label: 'Email',       sample: 'ada@example.com',         fallback: '' },
  { key: 'company',    label: 'Company',     sample: 'O3 Capital',              fallback: 'O3 Capital' },
  { key: 'cta_url',    label: 'Link (CTA)',  sample: 'https://o3cards.com/pay', fallback: '' },
]

const FIELD_BY_KEY = new Map(MERGE_FIELDS.map(f => [f.key, f]))

/** Replace {{field}} / {{field|default}} with sample values for a live preview. */
export function renderSample(tmpl: string): string {
  if (!tmpl) return ''
  return tmpl.replace(/\{\{([^}]+)\}\}/g, (_m, inner) => {
    const [rawKey, def] = String(inner).split('|')
    const key = rawKey.trim()
    const f = FIELD_BY_KEY.get(key)
    if (f && f.sample) return f.sample
    return (def ?? '').trim()
  })
}

/** True if the text still contains any {{merge_tag}}. */
export function hasMergeTags(s: string): boolean {
  return /\{\{[^}]+\}\}/.test(s || '')
}

/**
 * Insert `token` at the caret of a text input/textarea, updating React state via
 * setValue. Keeps the caret after the inserted token.
 */
export function insertToken(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  setValue: (v: string) => void,
  token: string,
) {
  if (!el) { setValue(value + token); return }
  const start = el.selectionStart ?? value.length
  const end   = el.selectionEnd ?? value.length
  const next  = value.slice(0, start) + token + value.slice(end)
  setValue(next)
  requestAnimationFrame(() => {
    el.focus()
    const pos = start + token.length
    try { el.setSelectionRange(pos, pos) } catch { /* ignore */ }
  })
}

// ── SMS segment math (GSM-7 vs UCS-2) ──────────────────────────────────────────

// GSM 03.38 basic + a few common extension chars. Anything outside forces UCS-2
// (Unicode), which shortens segments to 70 / 67 chars.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM_EXT = '^{}\\[~]|€'
const GSM_SET = new Set([...GSM_BASIC, ...GSM_EXT])

export interface SmsInfo {
  chars: number
  segments: number
  perSegment: number
  unicode: boolean
  remaining: number
}

/** Compute SMS length/segments, accounting for GSM-7 vs Unicode. */
export function smsInfo(text: string): SmsInfo {
  const t = text || ''
  let unicode = false
  let weighted = 0
  for (const ch of t) {
    if (!GSM_SET.has(ch)) { unicode = true; weighted += 1; continue }
    weighted += GSM_EXT.includes(ch) ? 2 : 1 // extension chars cost 2 in GSM-7
  }
  const single = unicode ? 70 : 160
  const multi  = unicode ? 67 : 153
  const len = unicode ? [...t].length : weighted
  const segments = len === 0 ? 0 : len <= single ? 1 : Math.ceil(len / multi)
  const cap = segments <= 1 ? single : segments * multi
  return { chars: len, segments, perSegment: unicode ? 67 : 153, unicode, remaining: cap - len }
}

// ── Subject-line quality hints ──────────────────────────────────────────────

const SPAM_WORDS = ['free', 'winner', 'guarantee', 'urgent', 'act now', 'cash', 'congratulations',
  'click here', 'limited time', 'risk-free', '100%', 'buy now', 'cheap', 'offer expires', '!!!', '$$$']

export interface SubjectHints {
  length: number
  lengthTone: 'good' | 'warn' | 'bad'
  spamWords: string[]
  hasEmoji: boolean
}

export function subjectHints(subject: string): SubjectHints {
  const s = subject || ''
  const lower = s.toLowerCase()
  const spamWords = SPAM_WORDS.filter(w => lower.includes(w))
  const len = s.length
  const lengthTone: SubjectHints['lengthTone'] = len === 0 ? 'warn' : len <= 60 ? 'good' : len <= 78 ? 'warn' : 'bad'
  const hasEmoji = /\p{Extended_Pictographic}/u.test(s)
  return { length: len, lengthTone, spamWords, hasEmoji }
}

// A small, safe emoji set for the subject/emoji picker.
export const QUICK_EMOJIS = ['🎉','✅','⚠️','💳','📈','🔔','⏰','💰','🙌','👋','🚀','⭐','📩','🎁','🔒','💡']
