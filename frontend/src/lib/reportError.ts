import { API, getCsrfToken } from './api'

// Reports a browser-side crash to the backend, which writes it to the server log.
//
// Why this exists: nothing used to keep any record of a page breaking in a staff
// member's browser. @sentry/react is bundled but never initialises, because main.tsx
// guards Sentry.init on VITE_SENTRY_DSN and no environment sets one. Both React error
// boundaries then throw the detail away — the outer one shows "Something went wrong",
// and the inner one prints React's own message, which in a production build is a bare
// error number. So the only copy of a fault was on the screen of the person least able
// to act on it, and the best anyone could report was "a minified React error in a lot
// of places".
//
// This file runs inside a failure, so it follows three rules:
//
//   - It never throws. A reporter that fails while reporting turns one broken page
//     into a broken application, which is strictly worse than no reporter.
//   - It never awaits and never retries. A boundary may reload the page immediately
//     (a chunk error does exactly that), so the request is sent with `keepalive` and
//     its outcome ignored — the browser finishes it after the page is gone.
//   - It reports a given fault once per page load. A broken render can fire on every
//     re-render, and a reporter that posts on each one would bury the first report in
//     thousands of copies of itself. The server throttles too, but the cheapest place
//     to stop a storm is before it leaves the browser.

// A lazily-loaded page whose chunk no longer exists. This is not a fault in the code:
// it is a tab that was open when a new version was deployed, asking for a file whose
// name carried the old build's content hash. The deploy replaces those files, so the
// request falls through to the HTML shell and the import fails.
//
// It lived privately in main.tsx, which is why the per-page boundary never recovered
// from it: routes sit inside PageErrorBoundary, so that boundary catches the failure
// first and the root boundary's reload never runs. Every stale tab therefore showed a
// dead "Page error" on each new page until someone thought to force a refresh.
export function isChunkError(e: Error): boolean {
  return (
    e.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module/.test(e.message) ||
    /Loading chunk \d+ failed/.test(e.message) ||
    /Importing a module script failed/.test(e.message)
  )
}

const RELOAD_MARK = 'o3c_chunk_reload_at'

// Reloads once to pick up the new build. Returns false if a reload was already tried
// recently, in which case the caller should show the error rather than keep reloading:
// a chunk that is missing for any reason OTHER than a fresh deploy would otherwise put
// the tab in a refresh loop, which is a worse failure than an honest message.
export function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_MARK) || 0)
    if (Number.isFinite(last) && Date.now() - last < 30_000) return false
    sessionStorage.setItem(RELOAD_MARK, String(Date.now()))
  } catch {
    /* Private windows refuse sessionStorage. Reloading once is still the right move. */
  }
  window.location.reload()
  return true
}

const reported = new Set<string>()

// Names the build that broke, so a report can be tied to a deploy. The entry bundle's
// content hash is already in the DOM, so this needs nothing injected at build time.
function buildId(): string {
  try {
    return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? ''
  } catch {
    return ''
  }
}

export function reportClientError(e: unknown, boundary: string, componentStack?: string) {
  try {
    const err = (e ?? {}) as Partial<Error>
    const message = String(err.message ?? e ?? '').slice(0, 1000)
    if (!message) return

    // Keyed on the route as well as the message: the same fault on two pages is two
    // things worth knowing about, and "everywhere" is the useful part of the report.
    const key = `${boundary}|${location.pathname}|${message}`
    if (reported.has(key)) return
    reported.add(key)

    void fetch(`${API}/api/client-errors`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify({
        name: String(err.name ?? ''),
        message,
        route: location.pathname + location.search,
        boundary,
        component_stack: String(componentStack ?? '').slice(0, 4000),
        stack: String(err.stack ?? '').slice(0, 4000),
        build: buildId(),
      }),
    }).catch(() => {})
  } catch {
    /* A reporter must never make the failure it is reporting any worse. */
  }
}
