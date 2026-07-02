# O3 Capital Workspace — Design System Reference

**Editorial B** — the approved visual language for all pages.

> **Living spec:** `src/pages/DesignDemo.tsx` — render at `/design-demo` to see everything  
> **Token source:** `src/lib/design.ts`  
> **Components:** `src/components/UI.tsx`

---

## 1. Starting a New Page

Every page follows this exact shell:

```tsx
import { Page, KpiCard, SectionCard, Spinner, ErrBanner } from '../../components/UI'

export default function MyPage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState('')

  return (
    <Page title="Page Title" subtitle="Optional subtitle">
      {loading && <Spinner />}
      {err     && <ErrBanner msg={err} />}
      {!loading && !err && (
        <>
          {/* content */}
        </>
      )}
    </Page>
  )
}
```

For a sub-page with breadcrumb:
```tsx
<Page title="Application Detail" dept="LOS" deptPath="/los">
```

**Never** use raw `<div>` as the page root. Always `<Page>`.

---

## 2. Token Reference

Never hardcode neutral hex colors. Use CSS variables everywhere.

| Token | Light value | Use for |
|---|---|---|
| `var(--bg)` | `#F5F6FA` | Page background |
| `var(--card)` | `#FFFFFF` | Card/panel background |
| `var(--card-bdr)` | `#E8EBF2` | Card border |
| `var(--card-shadow)` | `0 1px 2px…` | Card box-shadow |
| `var(--txt)` | `#0F1623` | Primary text, headings, values |
| `var(--txt2)` | `#798094` | Secondary text, labels, column headers |
| `var(--txt3)` | `#C0C8D8` | Muted/inactive text, placeholders |
| `var(--bdr)` | `#E8EBF2` | Dividers, table row borders |
| `var(--th-bg)` | `#F6F8FC` | Table header background |
| `var(--row-hvr)` | `#F8F9FC` | Table row hover (use `.tbl-row` class) |
| `var(--row-sel)` | `#FFF2F2` | Selected row background |
| `var(--input-bg)` | `#F2F4F9` | Input/select background |
| `var(--input-bdr)` | `#DDE0EA` | Input border |
| `var(--chip-bg)` | `#EEF0F8` | Badge/chip background |
| `var(--chip-txt)` | `#4A5270` | Badge/chip text |
| `var(--fp-bg)` | `#FFFFFF` | Filter panel background |
| `var(--fp-bdr)` | `#E8EBF2` | Filter panel border |

### Brand colors (hardcoded — same in light + dark)

```ts
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE } from '../../lib/design'
// NAVY   = '#0E2841'  primary CTAs, headers
// RED    = '#C00000'  accents, active nav, alerts
// GREEN  = '#16A34A'  success, positive delta
// AMBER  = '#D97706'  warnings, overdue
// BLUE   = '#2563EB'  info, links
// PURPLE = '#7C3AED'  special categories
```

### In Tailwind classes

CSS variables work in Tailwind with arbitrary values:
```tsx
className="bg-[var(--card)] text-[color:var(--txt)] border-[var(--bdr)]"
// hover:
className="hover:bg-[var(--row-hvr)]"
```

### ⚠️ CSS variables do NOT work in SVG attributes
```tsx
// ✅ Works (React inline style prop)
<span style={{ color: 'var(--txt2)' }} />

// ❌ Does NOT work (SVG attribute — use static hex)
<CartesianGrid stroke="var(--bdr)" />  // broken
<CartesianGrid stroke="#E8EBF2" />     // correct
```

---

## 3. Typography

```ts
import { INTER, NUM } from '../../lib/design'

// Body text — Sora (set globally in index.css, no import needed)

// Labels, numbers, column headers — Inter
style={{ fontFamily: INTER }}

// Tabular numbers (amounts, counts, dates in tables)
style={{ ...NUM }}  // fontFamily: INTER + tabular-nums feature

// DM Mono — large KPI numbers, kobo amounts
style={{ fontFamily: "'DM Mono', ui-monospace, monospace", fontVariantNumeric: 'tabular-nums' }}
```

### Text sizes
| Use | Size | Weight |
|---|---|---|
| Page title | 26px | 700 |
| Section card title | 14px | 600 |
| Table header | 10px | 700, uppercase, letter-spacing 0.6px |
| Table cell | 13px | 400 |
| Label/meta | 11–12px | 400–600 |
| KPI value | 22–26px | 700 |

---

## 4. Cards and Sections

```tsx
// Standard card (use .card CSS class)
<div className="card p-5">...</div>

// Card with header + content via component
<SectionCard title="Section Title" subtitle="Optional">
  {/* content */}
</SectionCard>

// With right-side action button
<SectionCard title="Users" actions={<button>Add User</button>}>

// With badge count
<SectionCard title="Applications" badge={42}>
```

Card dimensions: `border-radius: 14px`, `border: 1px solid var(--card-bdr)`, `box-shadow: var(--card-shadow)`.

---

## 5. KPI Strip

```tsx
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
  <KpiCard label="Total Loans"     value="₦48.2M"      icon="payments"      accent={NAVY} />
  <KpiCard label="Active"          value="1,204"        icon="check_circle"  accent={GREEN} />
  <KpiCard label="NPL Rate"        value="3.2%"         icon="warning"       accent={RED}  />
  <KpiCard label="Avg DPD"         value="12 days"      icon="schedule"      accent={AMBER} loading={loading} />
</div>

// With MoM change indicator
<KpiCard label="Revenue" value="₦12.4M" change={8.3} icon="trending_up" accent={NAVY} />
```

Adjust `gridTemplateColumns` for 3, 4, or 6 KPIs. Never more than 6.

---

## 6. Tables

### Use `DataTable` for standard sortable tables

```tsx
import { DataTable } from '../../components/UI'
import type { ColDef } from '../../components/UI'

const COLS: ColDef<MyRow>[] = [
  { key: 'name',   label: 'Customer',   sortable: true },
  { key: 'amount', label: 'Amount',     sortable: true, right: true,
    render: r => fmtKobo(r.amount) },
  { key: 'status', label: 'Status',     sortable: false,
    render: r => <StatusBadge status={r.status} /> },
]

<SectionCard title="Loans">
  <DataTable
    rows={data}
    cols={COLS}
    keyFn={r => r.id}
    loading={loading}
    onRowClick={r => nav(`/loans/${r.id}`)}
  />
</SectionCard>
```

### Manual table (for custom grouping, sub-rows, etc.)

```tsx
<table style={{ width: '100%', borderCollapse: 'collapse' }}>
  <thead>
    <tr>
      <th style={{
        padding: '10px 14px', textAlign: 'left',
        fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
        color: 'var(--txt2)', background: 'var(--th-bg)', fontFamily: INTER,
        whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)',
      }}>Column Header</th>
    </tr>
  </thead>
  <tbody>
    {rows.map(r => (
      <tr key={r.id} className="tbl-row" style={{ borderBottom: '1px solid var(--bdr)', cursor: 'pointer' }}
        onClick={() => nav(`/path/${r.id}`)}>
        <td style={{ padding: '12px 14px', color: 'var(--txt)', fontWeight: 600 }}>{r.name}</td>
        <td style={{ padding: '12px 14px', color: 'var(--txt2)', fontFamily: INTER, textAlign: 'right' }}>
          {fmtKobo(r.amount)}
        </td>
      </tr>
    ))}
  </tbody>
</table>
```

**Rules:**
- Always add `className="tbl-row"` to `<tr>` for hover effect
- Numbers/amounts: `textAlign: 'right'`, `fontFamily: INTER`, `fontVariantNumeric: 'tabular-nums'`
- Primary identifier (name, ref): `fontWeight: 600`, `color: 'var(--txt)'`
- Secondary fields: `color: 'var(--txt2)'`

---

## 7. Filter Bar

For any page with search + filters, use the `FilterBar` component:

```tsx
import { FilterBar, FilterGroup } from '../../components/UI'

const GROUPS: FilterGroup[] = [
  {
    key: 'status',
    label: 'Status',
    options: [
      { value: 'active',  label: 'Active',  count: 204 },
      { value: 'pending', label: 'Pending', count: 17  },
      { value: 'closed',  label: 'Closed',  count: 89  },
    ],
  },
  {
    key: 'product',
    label: 'Product',
    options: products.map(p => ({ value: p.id, label: p.name })),
  },
]

const [active, setActive] = useState<Record<string, Set<string>>>({})
const [search, setSearch] = useState('')

function toggle(group: string, value: string) {
  setActive(prev => {
    const next = { ...prev }
    const set  = new Set(next[group] ?? [])
    set.has(value) ? set.delete(value) : set.add(value)
    next[group] = set
    return next
  })
}

// Inside SectionCard or card wrapper:
<FilterBar
  search={search}     onSearch={setSearch}
  groups={GROUPS}     active={active}
  onToggle={toggle}   onClear={() => { setActive({}); setSearch('') }}
  total={total}       count={filtered.length}
/>
```

The `FilterBar` handles the Filters toggle button, red badge count, expandable panel, chip row, and "Clear all" automatically.

---

## 8. Charts

All charts live inside `SectionCard`. Use these wrappers from `UI.tsx`:

### Area Chart (trends over time)
```tsx
<AreaChartCard
  title="Monthly Disbursements"
  subtitle="Last 12 months"
  data={[{ month: 'Jan', value: 4200000 }, ...]}
  lines={[{ key: 'value', label: 'Amount (₦)', color: NAVY }]}
  currency
/>
```

### Bar Chart (comparisons)
```tsx
<BarChartCard
  title="Repayments by Channel"
  data={[{ channel: 'Transfer', amount: 12000000 }, ...]}
  bars={[{ key: 'amount', label: 'Amount', color: NAVY }]}
  xKey="channel"
  currency
/>
```

### Donut Chart (composition)
```tsx
<DonutCard
  title="Portfolio by Product"
  data={[
    { name: 'Salary Loan', value: 68, color: NAVY  },
    { name: 'Business',    value: 22, color: AMBER },
    { name: 'Credit Card', value: 10, color: RED   },
  ]}
  nameKey="name"
  valueKey="value"
/>
```

### Progress list (ranked items)
```tsx
<ProgressList
  title="Top Branches"
  items={[
    { label: 'Lagos Island', value: 42_000_000, max: 60_000_000, color: NAVY },
    { label: 'Abuja CBD',    value: 31_000_000, max: 60_000_000, color: BLUE },
  ]}
  currency
/>
```

### Recharts SVG note
When building custom Recharts charts, use **static hex** for SVG attributes:
```tsx
// Chart grid, axis ticks — static hex (CSS vars don't work in SVG attrs)
<CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
<XAxis tick={{ fontSize: 10, fill: '#9AA4B8' }} axisLine={false} tickLine={false} />

// Custom tooltip — use the ChartTip pattern (see AreaChartCard in UI.tsx)
```

---

## 9. Status Badges

```tsx
import { StatusBadge } from '../../components/UI'

// Automatic color mapping from STATUS_LABELS in src/lib/labels.ts
<StatusBadge status="active" />     // green
<StatusBadge status="pending" />    // amber
<StatusBadge status="rejected" />   // red
<StatusBadge status="closed" />     // muted

// Custom badge (when you control the color)
<span style={{
  display: 'inline-block', padding: '2px 10px', borderRadius: 99,
  fontSize: 11, fontWeight: 700, fontFamily: INTER,
  background: 'rgba(22,101,52,0.08)', color: '#166534',
}}>
  Approved
</span>
```

---

## 10. Forms and Inputs

```tsx
// Standard input
<input
  style={{
    width: '100%', padding: '9px 12px', borderRadius: 9,
    border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)',
    color: 'var(--txt)', fontSize: 13, outline: 'none',
  }}
/>

// Select
<select style={{
  padding: '8px 12px', borderRadius: 8,
  border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)',
  color: 'var(--txt)', fontSize: 13, outline: 'none',
}}>

// Textarea
<textarea style={{
  width: '100%', padding: '10px 12px', borderRadius: 9, resize: 'vertical',
  border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)',
  color: 'var(--txt)', fontSize: 13, outline: 'none', minHeight: 100,
}} />

// Form label
<label style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', fontFamily: INTER, display: 'block', marginBottom: 6, letterSpacing: 0.3 }}>
  Field Label
</label>
```

---

## 11. Buttons

```tsx
// Primary (navy)
<button className="btn-primary">Save</button>

// Ghost
<button className="btn-ghost">Cancel</button>

// Danger (red — use for destructive actions)
<button style={{ padding: '8px 18px', borderRadius: 9, border: 'none', background: RED, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
  Delete
</button>

// Secondary / outline
<button style={{ padding: '8px 14px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
  Export
</button>

// Icon + label
<button className="btn-primary">
  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
  New Application
</button>
```

---

## 12. Modals

```tsx
// Confirmation modal
import { ConfirmModal } from '../../components/UI'

{confirm && (
  <ConfirmModal
    title="Delete Record"
    message="This cannot be undone. Are you sure?"
    confirmLabel="Delete"
    danger
    onConfirm={() => { doDelete(); setConfirm(false) }}
    onCancel={() => setConfirm(false)}
  />
)}

// Custom modal shell
<div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
  onClick={onClose}>
  <div onClick={e => e.stopPropagation()}
    style={{ background: 'var(--card)', borderRadius: 14, border: '1px solid var(--card-bdr)', padding: 28, width: 480, boxShadow: 'var(--card-shadow)' }}>
    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)', marginBottom: 16 }}>Modal Title</div>
    {/* content */}
    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 24 }}>
      <button onClick={onClose} style={{ /* ghost style */ }}>Cancel</button>
      <button onClick={onSave}  className="btn-primary">Save</button>
    </div>
  </div>
</div>
```

---

## 13. Page Tabs

```tsx
import { Tabs } from '../../components/UI'

const [tab, setTab] = useState<'overview' | 'detail'>('overview')

<Tabs
  tabs={[
    { id: 'overview', label: 'Overview' },
    { id: 'detail',   label: 'Detail'   },
  ]}
  active={tab}
  onChange={setTab}
/>

{tab === 'overview' && <OverviewContent />}
{tab === 'detail'   && <DetailContent />}
```

---

## 14. Icons

All icons use [Material Symbols Rounded](https://fonts.google.com/icons) loaded from Google CDN.

```tsx
<span className="material-symbols-rounded" style={{ fontSize: 20 }}>payments</span>

// Filled variant
<span className="material-symbols-rounded fill-icon" style={{ fontSize: 20 }}>star</span>
```

Common icons used in this app:
| Purpose | Icon name |
|---|---|
| Loans / money | `payments`, `account_balance_wallet`, `money_off` |
| People | `person`, `people`, `groups` |
| Status OK | `check_circle`, `verified` |
| Warning | `warning`, `error`, `alarm_off` |
| Charts | `bar_chart`, `trending_up`, `pie_chart` |
| Actions | `add`, `edit`, `delete`, `send`, `download` |
| Nav | `chevron_right`, `expand_more`, `close` |
| Search/filter | `search`, `tune`, `filter_alt_off` |

---

## 15. Data Formatting

```ts
import { fmtKobo, fmt, fmtNum, fmtDate, fmtDatetime } from '../../lib/fmt'

fmtKobo(4820000)      // "₦48,200.00"   — all monetary amounts stored in kobo
fmt(48200)            // "₦48,200.00"   — alias for fmtKobo
fmtNum(1204)          // "1,204"
fmtDate('2026-01-15') // "15 Jan 2026"
fmtDatetime(str)      // "15 Jan 2026, 14:32"
```

**All monetary values in the database are in kobo (integer).** Divide by 100 for display. Never store floats for money.

---

## 16. Adding a New Page — Checklist

1. Create `src/pages/<module>/PageName.tsx`
2. Add lazy import in `src/App.tsx`:
   ```tsx
   const MyPage = lazy(() => import('./pages/module/PageName'))
   ```
3. Add `<Route>` in `App.tsx` inside the auth-guarded block:
   ```tsx
   <Route path="/module" element={<PageErrorBoundary><RequireAccess page="module" user={user}><MyPage /></RequireAccess></PageErrorBoundary>} />
   ```
4. Add nav entry to `SECTIONS` array in `src/components/Sidebar.tsx`
5. Add backend handler function in `backend-go/handlers/<module>.go`
6. Register route in `backend-go/main.go`
7. Add role permissions in `backend-go/core/auth.go`
8. Add `page` key to relevant roles in `ROLE_PAGES` map

---

## 17. Design Rules (Non-Negotiable)

- **Never hardcode neutral hex** — use `var(--token)` for all backgrounds, text, borders
- **Brand colors** (NAVY, RED, GREEN, AMBER) are hardcoded — they don't change between themes
- **Card radius** is always `14px`
- **Table headers** are always 10px, uppercase, Inter, `var(--txt2)`, `var(--th-bg)` background
- **Monetary amounts** always right-aligned, DM Mono or Inter tabular-nums
- **Sort indicators** use `#C00000`, opacity `0.3` inactive → `1` active
- **CSS vars in SVG attrs** don't work — use static hex for Recharts `stroke`/`fill` attrs
- **Login.tsx** is always light-only — exclude from token system
- **Dark action bars** (e.g. `bg-slate-900` containers) are intentional — don't replace

---

## 18. Table Sort

`DataTable` handles sorting internally — no external state required.

### ColDef prop
Every column definition accepts `sortable` (default `true`). Set `sortable: false` to disable sorting on a column.

```tsx
const cols: ColDef<Row>[] = [
  { key: 'name',   label: 'Name' },               // sortable by default
  { key: 'amount', label: 'Amount', right: true }, // right-aligned, still sortable
  { key: 'status', label: 'Status', sortable: false }, // no sort on this column
]
```

### How it works internally
- `sortKey` / `sortDir` state lives inside `DataTable`
- Clicking a sortable header calls `toggleSort(key)`:
  - First click → sorts ascending
  - Second click → flips to descending
  - Third click → stays descending (no reset)
- Sort is applied client-side on the current `rows` array via `useMemo`
- Comparison uses `<` / `>` so works for strings, numbers, and ISO date strings

### Visual spec
| State | Header text color | Indicator |
|---|---|---|
| Inactive | `var(--txt2)` | `↕` at `opacity: 0.3`, color `#C00000` |
| Active | `var(--txt)` | `↑` or `↓` at `opacity: 1`, color `#C00000` |

```tsx
// Sort indicator rendered inside each sortable <th>
<span style={{ fontSize: 11, color: '#C00000', lineHeight: 1, opacity: isActive ? 1 : 0.3, transition: 'opacity .12s' }}>
  {isActive ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
</span>
```

The header text also transitions (`transition: 'color .12s'`). Don't replicate this manually — it's built into `DataTable`.

---

## 19. Table Batch Selection & Bulk Actions

### DataTable selection props

```tsx
const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())

<DataTable
  cols={cols}
  rows={rows}
  selectable                          // shows checkbox column
  selectedIds={selectedIds}           // controlled — you own the Set
  onSelectionChange={setSelectedIds}  // DataTable calls this on every toggle
  rowBg={row => selectedIds.has(row.id) ? 'var(--row-sel)' : undefined}
/>
```

| Prop | Type | Notes |
|---|---|---|
| `selectable` | `boolean` | Adds checkbox column before all data columns |
| `selectedIds` | `Set<string \| number>` | IDs of currently selected rows |
| `onSelectionChange` | `(ids: Set<string\|number>) => void` | Called after every checkbox click |
| `rowBg` | `(row: T) => string \| undefined` | Return `var(--row-sel)` for selected rows |

The header checkbox is a "select all" toggle — it checks `every` row has its id in `selectedIds`, and either adds all or clears all.

### Toggle pattern
```tsx
// DataTable does this internally, but if you build custom lists:
function toggleRow(id: string | number) {
  setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
}
```

### Inline bulk bar — the ONLY approved pattern

Render inside the table card container, **above the `<table>`**, between the card header and the rows. Never use a fixed/floating dark bar.

```tsx
{selectedIds.size > 0 && (
  <div className="flex items-center gap-2 px-4 py-2.5"
    style={{ background: '#F0F4FF', borderBottom: '1px solid var(--bdr)' }}>
    <span className="text-[13px] font-semibold" style={{ color: '#0E2841' }}>
      {selectedIds.size} selected
    </span>
    <div className="w-px h-4" style={{ background: 'var(--bdr)' }} />

    <button
      onClick={handleBulkAction}
      className="px-2.5 py-1 rounded-lg text-[12px] font-semibold border"
      style={{ borderColor: 'var(--bdr)', background: '#fff', color: '#0E2841' }}>
      Action
    </button>
    <button
      onClick={handleBulkClose}
      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-semibold"
      style={{ background: 'rgba(5,150,105,0.12)', color: '#059669' }}>
      <span className="material-symbols-rounded text-[13px]">check_circle</span>
      Close
    </button>

    <button
      onClick={() => setSelectedIds(new Set())}
      className="ml-auto w-6 h-6 flex items-center justify-center rounded-full hover:bg-black/[0.08]"
      style={{ color: 'var(--txt2)' }}>
      <span className="material-symbols-rounded text-[15px]">close</span>
    </button>
  </div>
)}
```

**Colours:** background `#F0F4FF`, count text `#0E2841`, dividers `var(--bdr)`, action buttons white bg + navy text, destructive/positive actions use `rgba(5,150,105,0.12)` + `#059669`. Never use dark/slate background.

> ❌ **Removed pattern:** `fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-slate-900 text-white` — do not use this.

---

## 20. Page Transitions

All routes are wrapped in `<PageFade>` which cross-fades between pages on navigation.

### Component (App.tsx)
```tsx
function PageFade({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <div key={location.pathname} className="animate-crossfade">{children}</div>
}
```

The `key={location.pathname}` causes React to unmount/remount the div on route change, which triggers the CSS animation.

### Usage in App.tsx
```tsx
<PageFade>
  <Routes>
    <Route path="/" element={<Overview />} />
    {/* all other routes */}
  </Routes>
</PageFade>
```

### Tailwind config (tailwind.config.ts)
```ts
theme: {
  extend: {
    keyframes: {
      crossfadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
    },
    animation: {
      crossfade: 'crossfadeIn 0.3s ease 0.12s both',
    },
  },
},
```

**Spec:** opacity-only fade (no translate, no scale), 300ms duration, 120ms delay, `both` fill. The delay lets the previous page unmount cleanly before the new one appears.

**Rule:** never remove `<PageFade>` from the route wrapper. All top-level routes must be children of `<PageFade>` to receive the transition.

---

## 21. Navigation Styles

Four approved patterns. Pick by data complexity and how often users return to the list.

| Pattern | Use when | Examples |
|---|---|---|
| Split View | Queue workflows — user picks items one at a time | Mail inbox |
| Full Page Slide | Deep detail with many sections, sub-pages, or actions | LOS detail, Payroll run, Ticket detail |
| Modal Overlay | Quick read/edit that doesn't need its own URL | CRM contact detail, Task edit, Compose ticket |
| Inline Expand | Simple row preview — single field or status summary | Compliance checklists, Recovery cases |

---

### 1. Split View
Permanent left list + right detail panel. No navigation — clicking a row swaps the right panel in place.

**When:** queue workflows where the user processes items sequentially. Best for mail, helpdesk queues, or any "work through a list" flow.

```tsx
const [selected, setSelected] = useState<Item | null>(null)

<div className="flex h-full">
  {/* Left list — fixed width, scrollable */}
  <div className="w-[320px] flex-shrink-0 border-r overflow-y-auto"
    style={{ borderColor: 'var(--bdr)' }}>
    {items.map(item => (
      <div key={item.id}
        onClick={() => setSelected(item)}
        className="px-4 py-3 cursor-pointer border-b transition-colors"
        style={{
          borderColor: 'var(--bdr)',
          background: selected?.id === item.id ? 'var(--chip-bg)' : undefined,
        }}>
        {/* row content */}
      </div>
    ))}
  </div>

  {/* Right detail — fills remaining space */}
  <div className="flex-1 overflow-y-auto">
    {!selected
      ? <EmptyState label="Select an item" />
      : <DetailView item={selected} />
    }
  </div>
</div>
```

**Live example:** [MailInbox.tsx](src/pages/mail/MailInbox.tsx) — left panel is 320px, right panel is `flex-1`.

---

### 2. Full Page Slide
Navigate to a dedicated detail route. Breadcrumb in the `<Page>` shell links back to the list. Transition is the `PageFade` crossfade (see Section 20).

**When:** the detail has multiple sections, its own sub-routes, heavy data, or actions (approve, submit, download). Gives the most screen space.

```tsx
// List page — navigate on row click
const nav = useNavigate()

<tr onClick={() => nav(`/module/${row.id}`)} className="cursor-pointer tbl-row">

// Detail page — breadcrumb back via dept/deptPath
<Page title="Run Detail" dept="Payroll" deptPath="/payroll">
  {/* full detail content */}
</Page>
```

**Live examples:** [payroll/RunDetail.tsx](src/pages/payroll/RunDetail.tsx), [los/ApplicationDetail.tsx](src/pages/los/ApplicationDetail.tsx), [helpdesk/TicketDetail.tsx](src/pages/helpdesk/TicketDetail.tsx)

---

### 3. Modal Overlay
Detail or edit form appears centered over the list. Background gets a dark scrim with `backdrop-filter: blur(4px)`.

**When:** the detail is self-contained (read or single edit), doesn't need its own URL, and the user should return to the same list position after closing.

```tsx
const [detailItem, setDetailItem] = useState<Item | null>(null)

{/* Trigger — row click or action button */}
<tr onClick={() => setDetailItem(row)}>

{/* Modal */}
{detailItem && (
  <div
    onClick={() => setDetailItem(null)}
    style={{
      position: 'fixed', inset: 0, zIndex: 50,
      background: 'rgba(0,0,0,0.45)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
    <div
      onClick={e => e.stopPropagation()}
      style={{
        background: 'var(--card)', borderRadius: 14,
        border: '1px solid var(--card-bdr)',
        boxShadow: 'var(--card-shadow)',
        padding: 28, width: 520, maxHeight: '85vh', overflowY: 'auto',
      }}>
      {/* detail or edit content */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
        <button onClick={() => setDetailItem(null)} className="btn-ghost">Close</button>
      </div>
    </div>
  </div>
)}
```

**Live examples:** [crm/Contacts.tsx](src/pages/crm/Contacts.tsx), [crm/Tasks.tsx](src/pages/crm/Tasks.tsx), [helpdesk/ComposeTicket.tsx](src/pages/helpdesk/ComposeTicket.tsx)

---

### 4. Inline Expand
Row expands in place to reveal extra content. No navigation, no overlay — the table reflowing is the whole interaction.

**When:** the extra content is a simple preview (checklist items, a status summary, a short note). If it needs more than ~6 fields, use Modal or Full Page instead.

```tsx
const [expanded, setExpanded] = useState<string | null>(null)

<tbody>
  {rows.map(row => (
    <>
      <tr key={row.id}
        onClick={() => setExpanded(expanded === row.id ? null : row.id)}
        className="cursor-pointer tbl-row"
        style={{ borderTop: '1px solid var(--bdr)' }}>
        {/* normal cells */}
        <td>
          <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt2)' }}>
            {expanded === row.id ? 'expand_less' : 'expand_more'}
          </span>
        </td>
      </tr>

      {expanded === row.id && (
        <tr key={`${row.id}-detail`}>
          <td colSpan={cols.length}
            style={{ padding: '12px 20px', background: 'var(--fp-bg)', borderTop: '1px solid var(--bdr)' }}>
            {/* expanded content */}
          </td>
        </tr>
      )}
    </>
  ))}
</tbody>
```

**Live examples:** [compliance/Checklists.tsx](src/pages/compliance/Checklists.tsx), [recovery-ops/Cases.tsx](src/pages/recovery-ops/Cases.tsx)

---

### Sidebar navigation tokens

These live in `Sidebar.tsx` — do not override per-page.

| Token | Use |
|---|---|
| `var(--nav-txt)` | Inactive item text |
| `var(--nav-act-txt)` | Active item text |
| `var(--nav-act-bg)` | Active item background |
| `var(--nav-dot)` | Red indicator bar + sub-item dot (`#C00000`) |
| `var(--nav-hvr-bg)` | Hover background |
| `var(--sub-txt)` / `var(--sub-hvr)` / `var(--sub-act)` | Sub-item text states |

Active indicator: `3px × 16px` bar, `border-radius: 0 3px 3px 0`, absolutely positioned at left edge. Sub-item dot: `1px × 14px`. Accordion expand: `maxHeight 0.22s ease` transition. Sidebar widths: `236px` expanded / `64px` collapsed.
