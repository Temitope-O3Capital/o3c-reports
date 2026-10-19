/**
 * The plain-text half of an email.
 *
 * Every multipart email carries a text alternative, and it is what a recipient sees
 * when images are blocked (Outlook's default), when the client is text-only, and when
 * a screen reader reads the message. Spam filters read it too: an HTML part with no
 * usable text counterpart scores badly.
 *
 * WHAT THIS REPLACES. Two call sites independently did:
 *
 *     html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
 *
 * which strips TAGS but keeps the CONTENTS of <style>. Since every template opens with
 * a <style> block, the "plain text" of all nine campaigns on the book was the
 * stylesheet:
 *
 *     body{margin:0;padding:0;background:#E8ECF2;}a{color:inherit;}img{border:0;...}
 *
 * It also flattened the whole message to one line and dropped every link target, so
 * even where the text was real, the reader had no way to act on it.
 */

/** Block-level tags whose close should become a line break. */
const BLOCK_END = /<\/(p|div|tr|h[1-6]|li|ul|ol|table|section|header|footer|blockquote)\s*>/gi

/** The named entities that actually turn up in our templates, plus numeric escapes. */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·',
  copy: '©', reg: '®', trade: '™', pound: '£', euro: '€',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[String(n).toLowerCase()] ?? m)
}

/**
 * Render an HTML email body as readable plain text.
 *
 * Links are kept as "label (https://…)" because the text part is the only copy some
 * recipients get, and a call to action they cannot reach is worse than no call to
 * action. A link whose label already IS the URL is not repeated.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return ''

  let s = html
    // Contents, not just tags. This is the bug being fixed.
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  // An image carries no text, but its alt is authored precisely for this moment.
  s = s.replace(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["'][^>]*>/gi, (_m, alt) => `[${alt}] `)

  // Keep the destination with the label.
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      const url = String(href).trim()
      if (!url || url.startsWith('#') || url.toLowerCase().startsWith('javascript:')) return text
      if (!text) return url
      // Don't print "https://x (https://x)".
      return decodeEntities(text).replace(/\s+/g, ' ') === url ? text : `${text} (${url})`
    },
  )

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]+>/g, ' ')

  s = decodeEntities(s)

  return s
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')   // collapse spaces, keep newlines
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')          // at most one blank line
    .trim()
}

/**
 * True when the text part would tell a recipient nothing — all-image emails and the
 * old CSS output both land here. Callers use it to warn before a send rather than to
 * block one.
 */
export function plainTextIsUseless(text: string): boolean {
  const t = (text || '').trim()
  if (t.length < 40) return true
  // Stylesheet left over from the old conversion, or a template that is pure CSS.
  if (/\{[^}]*(margin|padding|background|font-size|color)\s*:/i.test(t)) return true
  // Needs some actual words, not just punctuation and URLs.
  const words = t.replace(/https?:\/\/\S+/g, ' ').match(/[A-Za-z]{3,}/g)
  return !words || words.length < 8
}
