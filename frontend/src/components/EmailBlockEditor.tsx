import { useState, useCallback, type CSSProperties } from 'react'
import { NAVY, BLUE, INTER } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Align = 'left' | 'center' | 'right'

export interface HeadingBlock { id: string; type: 'heading'; text: string; level: 1 | 2; align: Align }
export interface TextBlock    { id: string; type: 'text';    content: string; align: Align }
export interface ButtonBlock  { id: string; type: 'button';  label: string; url: string; bgColor: string; textColor: string }
export interface DividerBlock { id: string; type: 'divider' }
export interface SpacerBlock  { id: string; type: 'spacer';  height: number }
export interface ImageBlock   { id: string; type: 'image';   src: string; alt: string; align: Align; maxWidth: number }

export type Block = HeadingBlock | TextBlock | ButtonBlock | DividerBlock | SpacerBlock | ImageBlock

// ── HTML renderer ─────────────────────────────────────────────────────────────

function blockHtml(b: Block): string {
  switch (b.type) {
    case 'heading':
      return `<h${b.level} style="margin:0 0 16px;color:#0E2841;font-family:DM Sans,Arial,sans-serif;text-align:${b.align};font-size:${b.level===1?28:22}px;font-weight:700;line-height:1.25">${b.text}</h${b.level}>`
    case 'text':
      return `<p style="margin:0 0 16px;color:#374151;font-family:DM Sans,Arial,sans-serif;text-align:${b.align};font-size:14px;line-height:1.6">${b.content.replace(/\n/g,'<br/>')}</p>`
    case 'button':
      return `<table cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="border-radius:6px;background:${b.bgColor}"><a href="${b.url}" style="display:inline-block;padding:12px 28px;color:${b.textColor};font-family:DM Sans,Arial,sans-serif;font-size:14px;font-weight:600;text-decoration:none">${b.label}</a></td></tr></table>`
    case 'divider':
      return `<hr style="border:none;border-top:1px solid #E5E7EB;margin:8px 0 24px"/>`
    case 'spacer':
      return `<div style="height:${b.height}px;line-height:${b.height}px;font-size:1px">&nbsp;</div>`
    case 'image':
      return b.src
        ? `<div style="text-align:${b.align};margin-bottom:16px"><img src="${b.src}" alt="${b.alt||''}" style="max-width:${b.maxWidth}px;width:100%;display:inline-block;border-radius:4px"/></div>`
        : '<div style="height:8px"></div>'
    default: return ''
  }
}

export function blocksToHtml(blocks: Block[]): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F4F6FA">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:24px 12px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:36px 44px;max-width:600px;width:100%">
<tr><td>${blocks.map(blockHtml).join('\n')}</td></tr>
</table></td></tr></table>
</body></html>`
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 9)

const BLOCK_DEFS: Record<string, () => Block> = {
  heading: () => ({ id: uid(), type: 'heading', text: 'Your Heading Here', level: 1, align: 'left' }),
  text:    () => ({ id: uid(), type: 'text',    content: 'Enter your message here. Use {{first_name}} to personalise.', align: 'left' }),
  button:  () => ({ id: uid(), type: 'button',  label: 'Click Here', url: '{{cta_url}}', bgColor: '#0E2841', textColor: '#ffffff' }),
  divider: () => ({ id: uid(), type: 'divider' }),
  spacer:  () => ({ id: uid(), type: 'spacer',  height: 24 }),
  image:   () => ({ id: uid(), type: 'image',   src: '', alt: '', align: 'center', maxWidth: 500 }),
}

const BLOCK_ICONS: Record<string, string> = {
  heading: 'title', text: 'notes', button: 'smart_button',
  divider: 'horizontal_rule', spacer: 'height', image: 'image',
}

const MERGE_TAGS = ['{{first_name}}','{{last_name}}','{{amount}}','{{due_date}}','{{company}}','{{cta_url}}','{{phone}}']

// ── Main component ─────────────────────────────────────────────────────────────

interface Props { blocks: Block[]; onChange(b: Block[]): void }

export default function EmailBlockEditor({ blocks, onChange }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const patch = useCallback((id: string, p: Partial<Block>) => {
    onChange(blocks.map(b => b.id === id ? { ...b, ...p } as Block : b))
  }, [blocks, onChange])

  const move = (id: string, dir: -1 | 1) => {
    const i = blocks.findIndex(b => b.id === id)
    if (i < 0 || i + dir < 0 || i + dir >= blocks.length) return
    const nb = [...blocks]; [nb[i], nb[i + dir]] = [nb[i + dir], nb[i]]; onChange(nb)
  }

  const remove = (id: string) => {
    onChange(blocks.filter(b => b.id !== id))
    if (activeId === id) setActiveId(null)
  }

  const add = (type: string) => {
    const b = BLOCK_DEFS[type]?.(); if (!b) return
    onChange([...blocks, b]); setActiveId(b.id)
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

      {/* ── Canvas (left) ── */}
      <div style={{ width: 380, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--bdr)', overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {blocks.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--txt3)', fontSize: 13 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 32, display: 'block', marginBottom: 8, opacity: 0.35 }}>view_agenda</span>
              Add blocks below to build your email
            </div>
          )}
          {blocks.map((b, i) => (
            <BlockRow
              key={b.id} block={b} isActive={activeId === b.id} isFirst={i === 0} isLast={i === blocks.length - 1}
              onActivate={() => setActiveId(activeId === b.id ? null : b.id)}
              onMove={dir => move(b.id, dir)} onRemove={() => remove(b.id)}
              onChange={p => patch(b.id, p)}
            />
          ))}
        </div>

        {/* Add-block bar */}
        <div style={{ borderTop: '1px solid var(--bdr)', padding: '8px 10px', background: 'var(--th-bg)', flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--txt3)', letterSpacing: 1, marginBottom: 6, fontFamily: INTER }}>ADD BLOCK</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.keys(BLOCK_DEFS).map(type => (
              <button key={type} onClick={() => add(type)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 9px', fontSize: 11, fontFamily: INTER, fontWeight: 500, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 5, cursor: 'pointer', color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{BLOCK_ICONS[type]}</span>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Preview (right) ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#F4F6FA' }}>
        <div style={{ padding: '6px 12px', background: 'var(--card)', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)' }}>preview</span>
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.8 }}>LIVE PREVIEW</span>
        </div>
        <iframe
          srcDoc={blocksToHtml(blocks)}
          style={{ flex: 1, border: 'none', width: '100%', minHeight: 0 }}
          title="Email preview"
          sandbox="allow-same-origin"
        />
      </div>
    </div>
  )
}

// ── BlockRow ──────────────────────────────────────────────────────────────────

function BlockRow({
  block, isActive, isFirst, isLast, onActivate, onMove, onRemove, onChange,
}: {
  block: Block; isActive: boolean; isFirst: boolean; isLast: boolean
  onActivate(): void; onMove(d: -1 | 1): void; onRemove(): void; onChange(p: Partial<Block>): void
}) {
  const typeLabel = block.type === 'heading'
    ? `H${(block as HeadingBlock).level} Heading`
    : block.type.charAt(0).toUpperCase() + block.type.slice(1)

  return (
    <div style={{ border: `1.5px solid ${isActive ? BLUE : 'var(--bdr)'}`, borderRadius: 6, background: 'var(--card)', overflow: 'hidden' }}>
      <div
        onClick={onActivate}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer', userSelect: 'none', background: isActive ? `${BLUE}0D` : 'var(--card)' }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 13, color: isActive ? BLUE : 'var(--txt3)', flexShrink: 0 }}>{BLOCK_ICONS[block.type]}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: isActive ? BLUE : 'var(--txt2)', fontFamily: INTER, flexShrink: 0 }}>{typeLabel}</span>
        <span style={{ fontSize: 10.5, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{blockSummary(block)}</span>
        <div style={{ display: 'flex', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <IBtn icon="keyboard_arrow_up"   disabled={isFirst} onClick={() => onMove(-1)} />
          <IBtn icon="keyboard_arrow_down" disabled={isLast}  onClick={() => onMove(1)} />
          <IBtn icon="delete_outline" onClick={onRemove} danger />
        </div>
      </div>
      {isActive && (
        <div style={{ padding: '10px 10px 12px', borderTop: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <BlockFields block={block} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

function blockSummary(b: Block): string {
  switch (b.type) {
    case 'heading': return (b as HeadingBlock).text
    case 'text':    return (b as TextBlock).content.slice(0, 60)
    case 'button':  return `"${(b as ButtonBlock).label}"`
    case 'divider': return '─ ─ ─ ─ ─ ─'
    case 'spacer':  return `${(b as SpacerBlock).height}px gap`
    case 'image':   return (b as ImageBlock).src || '(no image URL set)'
    default: return ''
  }
}

// ── Field editors ─────────────────────────────────────────────────────────────

const IS: CSSProperties = {
  fontSize: 12.5, padding: '5px 8px', border: '1px solid var(--bdr)',
  borderRadius: 5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: INTER, boxSizing: 'border-box',
}

function FL({ ch }: { ch: string }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--txt3)', fontFamily: INTER, letterSpacing: 0.5, marginBottom: 2 }}>{ch}</div>
}

function BlockFields({ block, onChange }: { block: Block; onChange(p: Partial<Block>): void }) {
  switch (block.type) {
    case 'heading': {
      const b = block as HeadingBlock
      return (<>
        <div><FL ch="TEXT" /><input value={b.text} onChange={e => onChange({ text: e.target.value } as any)} style={{ ...IS, width: '100%' }} /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><FL ch="LEVEL" />
            <select value={b.level} onChange={e => onChange({ level: Number(e.target.value) as 1 | 2 } as any)} style={{ ...IS, width: '100%' }}>
              <option value={1}>H1 — Large (28px)</option>
              <option value={2}>H2 — Medium (22px)</option>
            </select>
          </div>
          <div><FL ch="ALIGN" /><AlignBtns value={b.align} onChange={v => onChange({ align: v } as any)} /></div>
        </div>
        <MTagRow onInsert={t => onChange({ text: b.text + t } as any)} />
      </>)
    }
    case 'text': {
      const b = block as TextBlock
      return (<>
        <div><FL ch="CONTENT" /><textarea value={b.content} onChange={e => onChange({ content: e.target.value } as any)} rows={4} style={{ ...IS, width: '100%', resize: 'vertical', lineHeight: 1.5 }} /></div>
        <div><FL ch="ALIGN" /><AlignBtns value={b.align} onChange={v => onChange({ align: v } as any)} /></div>
        <MTagRow onInsert={t => onChange({ content: b.content + t } as any)} />
      </>)
    }
    case 'button': {
      const b = block as ButtonBlock
      return (<>
        <div><FL ch="BUTTON LABEL" /><input value={b.label} onChange={e => onChange({ label: e.target.value } as any)} style={{ ...IS, width: '100%' }} /></div>
        <div><FL ch="LINK / URL" /><input value={b.url} onChange={e => onChange({ url: e.target.value } as any)} style={{ ...IS, width: '100%' }} placeholder="https://… or {{cta_url}}" /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><FL ch="BUTTON COLOR" /><ColorRow value={b.bgColor} onChange={v => onChange({ bgColor: v } as any)} /></div>
          <div style={{ flex: 1 }}><FL ch="TEXT COLOR" /><ColorRow value={b.textColor} onChange={v => onChange({ textColor: v } as any)} /></div>
        </div>
      </>)
    }
    case 'divider':
      return <div style={{ fontSize: 12, color: 'var(--txt3)', textAlign: 'center', padding: '4px 0' }}>Horizontal rule — no settings needed.</div>
    case 'spacer': {
      const b = block as SpacerBlock
      return (<div><FL ch="HEIGHT (PX)" /><input type="number" value={b.height} min={4} max={200} step={4} onChange={e => onChange({ height: Number(e.target.value) } as any)} style={{ ...IS, width: 90 }} /></div>)
    }
    case 'image': {
      const b = block as ImageBlock
      return (<>
        <div><FL ch="IMAGE URL" /><input value={b.src} onChange={e => onChange({ src: e.target.value } as any)} style={{ ...IS, width: '100%' }} placeholder="https://cdn.example.com/logo.png" /></div>
        <div><FL ch="ALT TEXT" /><input value={b.alt} onChange={e => onChange({ alt: e.target.value } as any)} style={{ ...IS, width: '100%' }} /></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div><FL ch="MAX WIDTH (PX)" /><input type="number" value={b.maxWidth} min={100} max={600} step={50} onChange={e => onChange({ maxWidth: Number(e.target.value) } as any)} style={{ ...IS, width: 90 }} /></div>
          <div><FL ch="ALIGN" /><AlignBtns value={b.align} onChange={v => onChange({ align: v } as any)} /></div>
        </div>
      </>)
    }
    default: return null
  }
}

function AlignBtns({ value, onChange }: { value: Align; onChange(v: Align): void }) {
  return (
    <div style={{ display: 'flex', border: '1px solid var(--bdr)', borderRadius: 5, overflow: 'hidden' }}>
      {(['left', 'center', 'right'] as Align[]).map(a => (
        <button key={a} onClick={() => onChange(a)} style={{ border: 'none', padding: '4px 7px', cursor: 'pointer', lineHeight: 1, background: value === a ? NAVY : 'var(--card)', color: value === a ? '#fff' : 'var(--txt3)' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 13 }}>
            {a === 'left' ? 'format_align_left' : a === 'center' ? 'format_align_center' : 'format_align_right'}
          </span>
        </button>
      ))}
    </div>
  )
}

function ColorRow({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="color" value={value} onChange={e => onChange(e.target.value)} style={{ width: 30, height: 26, padding: 2, border: '1px solid var(--bdr)', borderRadius: 4, cursor: 'pointer' }} />
      <input value={value} onChange={e => onChange(e.target.value)} style={{ ...IS, flex: 1, fontFamily: 'monospace', fontSize: 11.5, width: 0, minWidth: 60 }} />
    </div>
  )
}

function MTagRow({ onInsert }: { onInsert(t: string): void }) {
  return (
    <div>
      <FL ch="INSERT MERGE TAG" />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 2 }}>
        {MERGE_TAGS.map(t => (
          <button key={t} onClick={() => onInsert(t)} style={{ fontSize: 10.5, padding: '2px 7px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--chip-bg)', color: 'var(--txt2)', cursor: 'pointer', fontFamily: 'monospace' }}>{t}</button>
        ))}
      </div>
    </div>
  )
}

function IBtn({ icon, onClick, disabled, danger }: { icon: string; onClick(): void; disabled?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ background: 'none', border: 'none', padding: '2px 3px', cursor: disabled ? 'default' : 'pointer', color: danger ? '#EF4444' : disabled ? 'var(--txt3)' : 'var(--txt2)', opacity: disabled ? 0.35 : 1 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span>
    </button>
  )
}
