import { useEffect, useRef, useState } from 'react'
import { apiPost } from '../lib/api'
import { RADIUS } from '../lib/design'

// Zoho Desk inline images are referenced by a relative Zoho path the browser can
// neither resolve nor authenticate, so they render broken. We route them through a
// backend proxy that attaches our OAuth token; the proxy is authed by a short-lived
// ticket (same mechanism as SSE) since an <img> tag can't send the JWT header.
let imgTicket: { tok: string; exp: number } | null = null
let imgTicketPromise: Promise<string> | null = null
function getImgTicket(): Promise<string> {
  if (imgTicket && imgTicket.exp > Date.now()) return Promise.resolve(imgTicket.tok)
  if (!imgTicketPromise) {
    imgTicketPromise = apiPost<{ ticket?: string }>('/api/notifications/sse-ticket', {})
      .then(r => { const tok = String(r?.ticket || ''); imgTicket = { tok, exp: Date.now() + 4 * 60 * 1000 }; imgTicketPromise = null; return tok })
      .catch(() => { imgTicketPromise = null; return '' })
  }
  return imgTicketPromise
}
const ZOHO_INLINE_RE = /threads\/\d+\/inlineImages\//i
function rewriteZohoImages(html: string, ticket: string): string {
  return html.replace(/src\s*=\s*(["'])([^"']*threads\/\d+\/inlineImages\/[^"']+)\1/gi, (_m, q: string, url: string) => {
    const rel = url.match(/threads\/\d+\/inlineImages\/[^"'?]+/)
    if (!rel) return `src=${q}${url}${q}`
    return `src=${q}/api/helpdesk/mail/inline-image?p=${encodeURIComponent(rel[0])}&k=${encodeURIComponent(ticket)}${q}`
  })
}

function makeSrcDoc(body: string): string {
  return `<!doctype html><html><head><base target="_blank"><meta name="color-scheme" content="light"><style>
    html,body{margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2733;background:#fff;padding:8px 14px;overflow-wrap:anywhere;word-break:break-word}
    body *{max-width:100%}
    body > *{background-color:#fff!important;background-image:none!important;border-radius:0!important}
    /* Branded mails wrap everything in a div with 40px vertical padding — trim it so content isn't lost under whitespace */
    body > div:first-child{padding-top:12px!important;padding-bottom:12px!important;margin:0 auto!important}
    body > *:first-child{margin-top:0!important}
    p{margin:0 0 10px}
    img{height:auto!important}
    table{border-collapse:collapse}
    td,th{word-break:break-word}
    a{color:#0E2841;text-decoration:underline}
    blockquote,.gmail_quote{margin:10px 0;padding:2px 0 2px 12px;border-left:3px solid #e6e8eb;color:#6b7280}
    hr{border:none;border-top:1px solid #edf0f2;margin:14px 0}
    pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0}
  </style></head><body>${body}</body></html>`
}

// Renders an HTML email body inside a sandboxed iframe (no allow-scripts, so email
// markup can't run JavaScript). The frame auto-sizes to its content up to a cap.
export default function EmailHtml({ html, maxWidth = '92%' }: { html: string; maxWidth?: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [h, setH] = useState(60)
  const [doc, setDoc] = useState('')

  useEffect(() => {
    let cancelled = false
    async function build() {
      let body = html
      if (ZOHO_INLINE_RE.test(body)) {
        const tok = await getImgTicket()
        if (tok) body = rewriteZohoImages(body, tok)
      }
      if (!cancelled) setDoc(makeSrcDoc(body))
    }
    build()
    return () => { cancelled = true }
  }, [html])

  function measure() {
    try {
      const d = ref.current?.contentDocument
      if (d?.body) setH(Math.min(760, Math.max(44, d.documentElement?.scrollHeight || d.body.scrollHeight)))
    } catch { /* sandboxed access denied — keep default height */ }
  }
  function onLoad() {
    measure()
    // Images load after the document does; without re-measuring the frame keeps its
    // pre-image height and pictures get clipped. Re-measure as each image finishes.
    try {
      const d = ref.current?.contentDocument
      if (d) {
        d.querySelectorAll('img').forEach(img => {
          const im = img as HTMLImageElement
          if (!im.complete) { im.addEventListener('load', measure, { once: true }); im.addEventListener('error', measure, { once: true }) }
        })
        if ('ResizeObserver' in window && d.body) {
          const ro = new ResizeObserver(() => measure())
          ro.observe(d.body)
          setTimeout(() => ro.disconnect(), 8000)
        }
      }
    } catch { /* cross-origin guard */ }
    setTimeout(measure, 400); setTimeout(measure, 1200); setTimeout(measure, 3000)
  }

  return (
    <div style={{ maxWidth, width: maxWidth, borderRadius: RADIUS.lg, overflow: 'hidden', border: '1px solid var(--bdr)', background: '#fff' }}>
      <iframe ref={ref} title="message" sandbox="allow-same-origin" srcDoc={doc} onLoad={onLoad}
        style={{ width: '100%', height: h, border: 'none', display: 'block', background: '#fff' }} />
    </div>
  )
}
