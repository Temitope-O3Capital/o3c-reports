// scriptKit — shared building blocks for the Call Scripts library.
// Used by the standalone Call Scripts page and the global Scripts drawer so the
// markup, categories and reader rendering stay identical everywhere a script shows.

import { NAVY, RED, MONO, FW, RADIUS, TEXT } from '../lib/design'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CallScript {
  id: number
  title: string      // aliased from name in backend
  category: string
  body: string       // aliased from body_text in backend
  last_used_at: string | null
  created_by: string // joined from o3c_users; '' for seeded standard scripts
}

// ── Categories ─────────────────────────────────────────────────────────────────
// Scenario-based buckets that match how a call actually unfolds. Each carries an
// icon for the filter rail. Any category found in the data but not listed here is
// appended after these, so custom scripts never disappear.

export const CALL_CATEGORIES: { name: string; icon: string }[] = [
  { name: 'Openings',            icon: 'call' },
  { name: 'Verification',        icon: 'verified_user' },
  { name: 'Loans',               icon: 'payments' },
  { name: 'Cards',               icon: 'credit_card' },
  { name: 'Fixed Deposits',      icon: 'savings' },
  { name: 'Collections',         icon: 'event_repeat' },
  { name: 'Failed Transactions', icon: 'sync_problem' },
  { name: 'App Support',         icon: 'smartphone' },
  { name: 'Complaints',          icon: 'sentiment_dissatisfied' },
  { name: 'Objection Handling',  icon: 'forum' },
  { name: 'Closings',            icon: 'waving_hand' },
]
export const CATEGORY_NAMES = CALL_CATEGORIES.map(c => c.name)
export const CAT_ICON = (c: string) => CALL_CATEGORIES.find(x => x.name === c)?.icon ?? 'description'

// ── Script markup parser ────────────────────────────────────────────────────────
// Lightweight, line-based markup authored in the seed migration and the editor:
//   ## Heading        → section header
//   > Spoken line     → talk-track the agent says (highlighted)
//   [ Note ]          → agent-only cue (a whole line beginning with "[")
//   - Bullet          → list item
//   plain text        → context paragraph
//   {Token}           → inline fill-in placeholder (rendered as a chip)

export type BlockKind = 'heading' | 'say' | 'cue' | 'bullet' | 'text'
export interface Block { kind: BlockKind; text: string }

export function parseScript(body: string): Block[] {
  const out: Block[] = []
  for (const raw of (body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('## '))      out.push({ kind: 'heading', text: line.slice(3).trim() })
    else if (line.startsWith('> '))  out.push({ kind: 'say',     text: line.slice(2).trim() })
    else if (line.startsWith('[') && line.endsWith(']'))
                                     out.push({ kind: 'cue',     text: line.slice(1, -1).trim() })
    else if (line.startsWith('- '))  out.push({ kind: 'bullet',  text: line.slice(2).trim() })
    else                             out.push({ kind: 'text',    text: line })
  }
  return out
}

// A clean, copy-friendly plaintext version of a script (drops markup symbols,
// keeps agent cues in parentheses so nothing is lost on paste).
export function toPlainText(body: string): string {
  return parseScript(body).map(b => {
    switch (b.kind) {
      case 'heading': return `\n${b.text.toUpperCase()}`
      case 'say':     return b.text
      case 'cue':     return `(${b.text})`
      case 'bullet':  return `• ${b.text}`
      default:        return b.text
    }
  }).join('\n').trim()
}

// First readable line for the list preview.
export function previewLine(body: string): string {
  const b = parseScript(body).find(x => x.kind === 'say' || x.kind === 'text' || x.kind === 'bullet')
  return b ? b.text.replace(/\{([^}]+)\}/g, '$1') : ''
}

// Render inline text, turning {tokens} into fill-in chips.
export function renderInline(text: string) {
  const parts = text.split(/(\{[^}]+\})/g)
  return parts.map((p, i) => {
    if (p.startsWith('{') && p.endsWith('}')) {
      return (
        <span key={i} style={{
          fontFamily: MONO, fontSize: '0.86em', fontWeight: FW.semibold,
          color: 'var(--txt)', background: 'var(--chip-bg)',
          border: '1px dashed var(--input-bdr)', borderRadius: RADIUS.sm,
          padding: '0 5px', margin: '0 1px', whiteSpace: 'nowrap',
        }}>{p.slice(1, -1)}</span>
      )
    }
    return <span key={i}>{p}</span>
  })
}

// ── Reader ───────────────────────────────────────────────────────────────────────

export function ScriptReader({ blocks }: { blocks: Block[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          return (
            <div key={i} style={{
              fontSize: TEXT.xs, fontWeight: FW.bold, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: 'var(--txt3)',
              marginTop: i === 0 ? 0 : 18, marginBottom: 4,
            }}>{b.text}</div>
          )
        }
        if (b.kind === 'say') {
          return (
            <div key={i} style={{
              borderLeft: `3px solid ${NAVY}`, background: 'var(--row-hvr)',
              borderRadius: `0 ${RADIUS.md} ${RADIUS.md} 0`,
              padding: '9px 13px', margin: '3px 0',
              fontSize: TEXT.md, lineHeight: 1.55, color: 'var(--txt)',
            }}>{renderInline(b.text)}</div>
          )
        }
        if (b.kind === 'cue') {
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'flex-start', gap: 7,
              padding: '5px 2px', color: 'var(--txt2)',
              fontSize: TEXT.sm, fontStyle: 'italic', lineHeight: 1.5,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt3)', marginTop: 1, flexShrink: 0, fontStyle: 'normal' }}>info</span>
              <span>{renderInline(b.text)}</span>
            </div>
          )
        }
        if (b.kind === 'bullet') {
          return (
            <div key={i} style={{ display: 'flex', gap: 9, padding: '2px 0 2px 4px', fontSize: TEXT.base, lineHeight: 1.5, color: 'var(--txt)' }}>
              <span style={{ color: RED, fontWeight: FW.bold, lineHeight: 1.5 }}>•</span>
              <span>{renderInline(b.text)}</span>
            </div>
          )
        }
        return (
          <div key={i} style={{ fontSize: TEXT.base, lineHeight: 1.55, color: 'var(--txt2)', padding: '2px 0' }}>
            {renderInline(b.text)}
          </div>
        )
      })}
    </div>
  )
}
