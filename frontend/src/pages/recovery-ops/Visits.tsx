import { Page, SectionCard, NAVY } from '../../components/UI'

// ── NOTE ───────────────────────────────────────────────────────────
// There is no dedicated backend endpoint for a global field visits list
// (e.g. GET /api/recovery-ops/visits with date/type/outcome filters).
//
// The current API only exposes visits nested inside individual case details:
//   GET /api/recovery-ops/cases/{id}  → { field_visits: [...] }
//
// Building a global visits view would require either:
//   (a) A new backend endpoint: GET /api/recovery-ops/visits?date_from&date_to&visit_type&outcome
//   (b) Fetching all cases and their details client-side — not scalable.
//
// Once the backend endpoint is added, replace this placeholder with the full
// DataTable implementation using the pattern from Cases.tsx and Legal.tsx.
// ──────────────────────────────────────────────────────────────────

export default function Visits() {
  return (
    <Page
      dept="Recovery Ops"
      title="Field Visits"
      subtitle="Log and review all field, office and phone visits"
    >
      <SectionCard title="Field Visits — Coming Soon">
        <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
            style={{ background: `${NAVY}12` }}>
            <span className="material-symbols-rounded text-[32px]" style={{ color: NAVY }}>
              directions_car
            </span>
          </div>
          <h3 className="text-[16px] font-bold text-slate-800 mb-2">Global Visits List</h3>
          <p className="text-[14px] text-slate-500 max-w-md mb-4">
            This view requires a dedicated backend endpoint —
            <code className="mx-1 px-1.5 py-0.5 rounded bg-slate-100 text-[12px] font-mono text-slate-700">
              GET /api/recovery-ops/visits
            </code>
            — that returns all field visits across cases with filters for date range, visit type, and outcome.
          </p>
          <p className="text-[13px] text-slate-400 max-w-md">
            Individual visits can be logged and viewed today via the
            <strong className="text-slate-600 mx-1">Cases</strong>
            page — open any case and switch to the <em>Visits</em> tab.
            Once the backend endpoint is available, this page will show the full filterable log.
          </p>
        </div>
      </SectionCard>
    </Page>
  )
}
