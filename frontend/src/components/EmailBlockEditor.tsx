/**
 * EmailBlockEditor — custom block-based email builder.
 * Ported to TypeScript from the original EmailBlockEditor.jsx.
 * No third-party editor dependency. Generates email-safe table HTML.
 *
 * Usage:
 *   <EmailBlockEditor value={{ blocks, settings }} onChange={({ blocks, settings }) => ...} />
 *
 * To export HTML: import { exportToHtml } and call exportToHtml(blocks, settings)
 */
import { useState, useRef, useEffect, useCallback, CSSProperties } from 'react'
import { apiFetch } from '../lib/api'

// ── Colours (design system tokens) ──────────────────────────────────
const C = {
  fg1:    '#0f172a',
  fg2:    '#1e293b',
  fg3:    '#64748b',
  fg4:    '#94a3b8',
  surf:   '#ffffff',
  subtle: '#f8fafc',
  muted:  '#f1f5f9',
  b08:    'rgba(15,23,42,0.08)',
  b12:    'rgba(15,23,42,0.12)',
  b15:    'rgba(15,23,42,0.15)',
  b22:    'rgba(15,23,42,0.22)',
  NAVY:   '#0E2841',
  RED:    '#C00000',
}

// ── Shared button styles ─────────────────────────────────────────────
const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
  background: C.NAVY, color: '#fff', border: 'none', cursor: 'pointer',
}
const btnGhost: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 500,
  background: 'transparent', color: C.fg3, border: `1px solid ${C.b15}`, cursor: 'pointer',
}
const btnIcon: CSSProperties = {
  padding: 4, background: 'none', border: 'none',
  cursor: 'pointer', borderRadius: 6, display: 'flex', alignItems: 'center',
}
const formInput: CSSProperties = {
  width: '100%', padding: '5px 9px', borderRadius: 6,
  border: `1px solid ${C.b15}`, outline: 'none',
  fontSize: 12, fontFamily: 'inherit', background: '#fff', color: C.fg2,
}

// ── Types ────────────────────────────────────────────────────────────
export interface EmailBlock {
  id:          string
  type:        string
  // header
  logoText?:   string
  tagline?:    string
  bg?:         string
  textColor?:  string
  padding?:    number
  // text / two_col
  html?:       string
  leftHtml?:   string
  rightHtml?:  string
  split?:      string
  // image
  src?:        string
  alt?:        string
  link?:       string
  align?:      string
  rounded?:    boolean
  // button
  text?:       string
  url?:        string
  size?:       string
  // divider
  color?:      string
  thickness?:  number
  margin?:     number
  // spacer
  height?:     number
  // footer
  unsubscribe?: boolean
}

export interface EmailSettings {
  background?:    string
  contentWidth?:  number
}

interface EditorValue {
  blocks:    EmailBlock[]
  settings?: EmailSettings
}

// ── uid helper ───────────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

// ── Default block constructors ───────────────────────────────────────
const DEF: Record<string, () => EmailBlock> = {
  header:  () => ({ id: uid(), type: 'header',  logoText: 'O3C Cards', tagline: '',   bg: C.NAVY, textColor: '#ffffff', padding: 32 }),
  text:    () => ({ id: uid(), type: 'text',    html: '<p>Enter your message here...</p>' }),
  image:   () => ({ id: uid(), type: 'image',   src: '', alt: '', link: '', align: 'center', rounded: false }),
  button:  () => ({ id: uid(), type: 'button',  text: 'Click Here', url: '', bg: C.RED, textColor: '#ffffff', align: 'center', size: 'md', rounded: true }),
  divider: () => ({ id: uid(), type: 'divider', color: '#e0e0e0', thickness: 1, margin: 20 }),
  spacer:  () => ({ id: uid(), type: 'spacer',  height: 32 }),
  two_col: () => ({ id: uid(), type: 'two_col', leftHtml: '<p>Left content</p>', rightHtml: '<p>Right content</p>', split: '50/50' }),
  footer:  () => ({ id: uid(), type: 'footer',  text: '© 2026 O3C Cards | Lagos, Nigeria', unsubscribe: true }),
}

// ── Block palette ────────────────────────────────────────────────────
const PALETTE = [
  { type: 'header',  label: 'Header',    icon: 'web_asset' },
  { type: 'text',    label: 'Text',      icon: 'article' },
  { type: 'image',   label: 'Image',     icon: 'image' },
  { type: 'button',  label: 'Button',    icon: 'smart_button' },
  { type: 'divider', label: 'Divider',   icon: 'horizontal_rule' },
  { type: 'spacer',  label: 'Spacer',    icon: 'space_bar' },
  { type: 'two_col', label: '2 Columns', icon: 'view_column' },
  { type: 'footer',  label: 'Footer',    icon: 'bottom_navigation' },
]

// ── Templates ────────────────────────────────────────────────────────
const TEMPLATES: { id: string; name: string; icon: string; color: string; desc: string; blocks: EmailBlock[] }[] = [
  {
    id: 'blank', name: 'Blank Canvas', icon: 'add_box', color: '#6B7280',
    desc: 'Start from scratch with an empty canvas',
    blocks: [],
  },
  {
    id: 'simple', name: 'Simple Message', icon: 'article', color: '#3B82F6',
    desc: 'Header · Message · CTA button · Footer',
    blocks: [
      { ...DEF.header(), tagline: 'Your Financial Partner' },
      { ...DEF.text(), html: '<p style="margin:0 0 16px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0 0 16px;">We have an important update regarding your O3C Cards account.</p><p style="margin:0;">Thank you for being a valued customer.</p>' },
      { ...DEF.button(), text: 'View My Account', url: 'https://o3ccards.com' },
      DEF.footer(),
    ],
  },
  {
    id: 'promo', name: 'Promotion', icon: 'local_offer', color: '#059669',
    desc: 'Hero image · Headline · CTA · Footer',
    blocks: [
      DEF.header(),
      { ...DEF.image(), alt: 'Campaign banner' },
      { ...DEF.text(), html: '<h2 style="margin:0 0 12px;font-size:22px;color:#0E2841;">Exclusive Offer, {{first_name}}</h2><p style="margin:0 0 16px;color:#555;">Enjoy premium benefits with your O3C Card — cashback, instant transfers and more.</p>' },
      { ...DEF.button(), text: 'Claim Offer', bg: '#059669' },
      DEF.footer(),
    ],
  },
  {
    id: 'reminder', name: 'Payment Reminder', icon: 'payment', color: '#D97706',
    desc: 'Collections · Bold amount due + pay CTA',
    blocks: [
      { ...DEF.header(), bg: C.RED, tagline: 'Action Required' },
      { ...DEF.text(), html: '<p style="margin:0 0 16px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0 0 16px;">Your outstanding balance of <strong style="font-size:22px;color:#C00000;">₦{{amount}}</strong> is due on <strong>{{due_date}}</strong>.</p><p style="margin:0 0 16px;">Please settle your balance promptly to avoid any disruption to your account.</p>' },
      { ...DEF.button(), text: 'Pay Now', bg: C.RED, url: 'https://o3ccards.com/pay' },
      DEF.divider(),
      { ...DEF.text(), html: '<p style="margin:0;font-size:13px;color:#888;text-align:center;">Need help? Call 07000-O3CARDS or email <a href="mailto:support@o3ccards.com" style="color:#0E2841;">support@o3ccards.com</a></p>' },
      DEF.footer(),
    ],
  },
  {
    id: 'welcome', name: 'Welcome', icon: 'waving_hand', color: '#8B5CF6',
    desc: 'Onboard new cardholders',
    blocks: [
      { ...DEF.header(), tagline: 'Welcome to O3C Cards' },
      { ...DEF.text(), html: "<h2 style=\"margin:0 0 16px;color:#0E2841;font-size:22px;\">Welcome aboard, {{first_name}}!</h2><p style=\"margin:0 0 16px;\">Your O3C Card account is ready. Here's what you get:</p><ul style=\"margin:0;padding-left:20px;color:#444;line-height:2.2;\"><li><strong>Instant payments</strong> — pay anywhere, anytime</li><li><strong>Cashback rewards</strong> — earn on every spend</li><li><strong>Zero forex fees</strong> — international transactions</li><li><strong>24/7 support</strong> — we're always here</li></ul>" },
      { ...DEF.button(), text: 'Activate My Card', bg: C.NAVY },
      DEF.footer(),
    ],
  },
  {
    id: 'statement', name: 'Monthly Statement', icon: 'receipt_long', color: '#0EA5E9',
    desc: 'Statement notification with view link',
    blocks: [
      DEF.header(),
      { ...DEF.text(), html: '<p style="margin:0 0 16px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0 0 16px;">Your monthly statement is now available. Here\'s a summary of your account activity:</p><p style="margin:0 0 8px;"><strong>Total Spend:</strong> ₦{{amount}}</p><p style="margin:0;">Statement Period: {{due_date}}</p>' },
      DEF.divider(),
      { ...DEF.button(), text: 'View Full Statement', bg: '#0EA5E9' },
      DEF.footer(),
    ],
  },
]

/* ══════════════════════════════════════════════════════
   HTML GENERATOR — email-safe table-based HTML
══════════════════════════════════════════════════════ */
function blockToHtml(b: EmailBlock): string {
  const wrap = (inner: string, style = '') =>
    `<tr><td style="font-family:DM Sans,Arial,Helvetica,sans-serif;${style}">${inner}</td></tr>`

  switch (b.type) {
    case 'header':
      return wrap(
        `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="padding:${b.padding || 32}px 40px;background:${b.bg || C.NAVY};text-align:center;">` +
        `<span style="font-size:24px;font-weight:700;color:${b.textColor || '#fff'};letter-spacing:-0.5px;display:block;">${b.logoText || 'O3C Cards'}</span>` +
        (b.tagline ? `<span style="font-size:11px;color:${b.textColor || '#fff'}99;display:block;margin-top:6px;text-transform:uppercase;letter-spacing:0.1em;">${b.tagline}</span>` : '') +
        `</td></tr></table>`
      )

    case 'text':
      return wrap(b.html || '<p>Enter text...</p>', 'padding:24px 40px;color:#1a1a1a;font-size:15px;line-height:1.75;')

    case 'image':
      return b.src
        ? wrap(
            `<div style="text-align:${b.align || 'center'};padding:16px 40px;">` +
            (b.link ? `<a href="${b.link}" target="_blank">` : '') +
            `<img src="${b.src}" alt="${b.alt || ''}" style="max-width:100%;height:auto;display:inline-block;${b.rounded ? 'border-radius:8px;' : ''}" />` +
            (b.link ? '</a>' : '') +
            `</div>`
          )
        : wrap('<div style="height:180px;background:#f5f5f5;margin:16px 40px;border-radius:8px;text-align:center;padding-top:70px;color:#ccc;font-size:14px;">[ Image Placeholder ]</div>')

    case 'button':
      return wrap(
        `<div style="text-align:${b.align || 'center'};padding:8px 40px 24px;">` +
        `<a href="${b.url || '#'}" target="_blank" style="display:inline-block;padding:${b.size === 'lg' ? '16px 48px' : '13px 36px'};background:${b.bg || C.RED};color:${b.textColor || '#fff'};font-weight:700;font-size:${b.size === 'lg' ? '16px' : '14px'};text-decoration:none;border-radius:${b.rounded !== false ? '6px' : '2px'};letter-spacing:0.02em;">${b.text || 'Click Here'}</a>` +
        `</div>`
      )

    case 'divider':
      return wrap(
        `<div style="padding:${b.margin || 16}px 40px;">` +
        `<hr style="border:none;border-top:${b.thickness || 1}px solid ${b.color || '#e0e0e0'};margin:0;" />` +
        `</div>`
      )

    case 'spacer':
      return `<tr><td style="height:${b.height || 32}px;line-height:${b.height || 32}px;">&nbsp;</td></tr>`

    case 'two_col': {
      const [l, r] = (b.split || '50/50').split('/').map(Number)
      return wrap(
        `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:16px 40px;">` +
        `<tr><td width="${l}%" valign="top" style="padding-right:16px;font-size:14px;color:#333;line-height:1.7;">${b.leftHtml || ''}</td>` +
        `<td width="${r}%" valign="top" style="padding-left:16px;font-size:14px;color:#333;line-height:1.7;">${b.rightHtml || ''}</td></tr>` +
        `</table>`
      )
    }

    case 'footer':
      return wrap(
        `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="padding:24px 40px;background:#f8f9fa;border-top:1px solid #ececec;text-align:center;">` +
        `<p style="margin:0 0 6px;font-size:12px;color:#888;">${b.text || '© 2026 O3C Cards'}</p>` +
        (b.unsubscribe ? '<p style="margin:0;font-size:11px;color:#bbb;">You received this because you are an O3C Cards customer. <a href="{{unsubscribe_url}}" style="color:#bbb;">Unsubscribe</a></p>' : '') +
        `</td></tr></table>`
      )

    default: return ''
  }
}

export function exportToHtml(blocks: EmailBlock[] = [], settings: EmailSettings = {}): string {
  const bg = settings.background || '#f4f4f4'
  const w  = settings.contentWidth || 680
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>Email</title>
<style>
  body{margin:0;padding:0;}a{color:inherit;}img{border:0;max-width:100%;}
  @media only screen and (max-width:600px){.ec{width:100%!important;border-radius:0!important;}}
</style>
</head>
<body style="margin:0;padding:0;background-color:${bg};">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:${bg};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" class="ec"
  style="width:100%;max-width:${w}px;background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
${blocks.map(blockToHtml).join('\n')}
</table>
</td></tr>
</table>
</body></html>`
}

/* ══════════════════════════════════════════════════════
   CANVAS BLOCK — visual render inside editor
══════════════════════════════════════════════════════ */
interface CanvasBlockProps {
  block:       EmailBlock
  selected:    boolean
  idx:         number
  total:       number
  onSelect:    () => void
  onUpdate:    (patch: Partial<EmailBlock>) => void
  onMove:      (dir: number) => void
  onDelete:    () => void
  onDuplicate: () => void
}

function CanvasBlock({ block, selected, idx, total, onSelect, onUpdate, onMove, onDelete, onDuplicate }: CanvasBlockProps) {
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (textRef.current && block.type === 'text' && !selected) {
      if (textRef.current.innerHTML !== block.html) {
        textRef.current.innerHTML = block.html || ''
      }
    }
  }, [block.html, selected, block.type])

  const saveText = () => {
    if (textRef.current) onUpdate({ html: textRef.current.innerHTML })
  }

  const renderContent = () => {
    switch (block.type) {
      case 'header':
        return (
          <div style={{ padding: `${block.padding || 32}px 40px`, background: block.bg || C.NAVY, textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: block.textColor || '#fff', letterSpacing: '-0.3px' }}>
              {block.logoText || 'O3C Cards'}
            </div>
            {block.tagline && (
              <div style={{ fontSize: 11, color: (block.textColor || '#fff') + '99', marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {block.tagline}
              </div>
            )}
          </div>
        )

      case 'text':
        return (
          <>
            {selected && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', background: '#1e293b', borderBottom: '1px solid #334155', flexWrap: 'wrap' }}>
                {[
                  { title: 'Bold',         icon: 'format_bold',        cmd: () => document.execCommand('bold') },
                  { title: 'Italic',       icon: 'format_italic',      cmd: () => document.execCommand('italic') },
                  { title: 'Underline',    icon: 'format_underlined',  cmd: () => document.execCommand('underline') },
                  { title: 'Align Left',   icon: 'format_align_left',  cmd: () => document.execCommand('justifyLeft') },
                  { title: 'Align Center', icon: 'format_align_center',cmd: () => document.execCommand('justifyCenter') },
                  { title: 'Link', icon: 'link', cmd: () => { const u = prompt('URL:'); if (u) document.execCommand('createLink', false, u) } },
                ].map(({ title, icon, cmd }) => (
                  <button key={title} type="button" title={title}
                    onMouseDown={e => { e.preventDefault(); cmd() }}
                    style={{ padding: '2px 4px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', borderRadius: 3, display: 'flex' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{icon}</span>
                  </button>
                ))}
                <div style={{ width: 1, height: 16, background: '#334155', margin: '0 2px' }} />
                {['{{first_name}}', '{{amount}}', '{{due_date}}', '{{cif}}'].map(t => (
                  <button key={t} type="button"
                    onMouseDown={e => { e.preventDefault(); document.execCommand('insertText', false, t) }}
                    style={{ fontSize: 9, padding: '1px 5px', background: '#334155', border: 'none', color: '#94a3b8', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace' }}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            <div
              ref={textRef}
              contentEditable={selected}
              suppressContentEditableWarning
              onBlur={saveText}
              style={{ padding: '20px 40px', fontSize: 14, lineHeight: 1.75, color: '#1a1a1a', outline: 'none', minHeight: 60 }}
              {...(!selected ? { dangerouslySetInnerHTML: { __html: block.html || '' } } : {})}
            />
          </>
        )

      case 'image':
        return (
          <div style={{ textAlign: (block.align as any) || 'center', padding: '16px 40px' }}>
            {block.src ? (
              <img src={block.src} alt={block.alt} style={{ maxWidth: '100%', display: 'inline-block', borderRadius: block.rounded ? 8 : 0 }} />
            ) : (
              <div style={{ height: 160, background: '#f5f5f5', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, border: '2px dashed #e0e0e0', color: '#bbb' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 32, color: '#ddd' }}>image</span>
                <span style={{ fontSize: 12 }}>Upload in properties panel →</span>
              </div>
            )}
          </div>
        )

      case 'button':
        return (
          <div style={{ textAlign: (block.align as any) || 'center', padding: '8px 40px 20px' }}>
            <div style={{
              display: 'inline-block',
              padding: block.size === 'lg' ? '14px 44px' : '11px 32px',
              background: block.bg || C.RED,
              color: block.textColor || '#fff',
              fontWeight: 700,
              fontSize: block.size === 'lg' ? 15 : 13,
              borderRadius: block.rounded !== false ? 6 : 2,
              letterSpacing: '0.02em',
            }}>
              {block.text || 'Click Here'}
            </div>
          </div>
        )

      case 'divider':
        return (
          <div style={{ padding: `${block.margin || 16}px 40px` }}>
            <hr style={{ border: 'none', borderTop: `${block.thickness || 1}px solid ${block.color || '#e0e0e0'}`, margin: 0 }} />
          </div>
        )

      case 'spacer':
        return (
          <div style={{ height: block.height || 32, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-linear-gradient(45deg,#f8fafc,#f8fafc 4px,#fff 4px,#fff 8px)' }}>
            <span style={{ fontSize: 9, color: '#ccc', textTransform: 'uppercase', letterSpacing: '0.08em', background: '#fff', padding: '1px 6px', borderRadius: 3 }}>{block.height || 32}px spacer</span>
          </div>
        )

      case 'two_col': {
        const [l, r] = (block.split || '50/50').split('/').map(Number)
        return (
          <div style={{ display: 'flex', padding: '16px 40px', gap: 16 }}>
            <div style={{ flex: l, fontSize: 13, lineHeight: 1.7, color: '#444' }} dangerouslySetInnerHTML={{ __html: block.leftHtml || '<p>Left column content</p>' }} />
            <div style={{ width: 1, background: '#f0f0f0', flexShrink: 0 }} />
            <div style={{ flex: r, fontSize: 13, lineHeight: 1.7, color: '#444' }} dangerouslySetInnerHTML={{ __html: block.rightHtml || '<p>Right column content</p>' }} />
          </div>
        )
      }

      case 'footer':
        return (
          <div style={{ padding: '20px 40px', background: '#f8f9fa', borderTop: '1px solid #ececec', textAlign: 'center' }}>
            <p style={{ margin: '0 0 4px', fontSize: 11, color: '#888' }}>{block.text || '© 2026 O3C Cards'}</p>
            {block.unsubscribe && <p style={{ margin: 0, fontSize: 10, color: '#bbb' }}>Unsubscribe link included automatically</p>}
          </div>
        )

      default: return null
    }
  }

  return (
    <div
      onClick={e => { e.stopPropagation(); onSelect() }}
      style={{
        position: 'relative',
        outline: selected ? '2px solid #3B82F6' : '2px solid transparent',
        outlineOffset: -1,
        cursor: 'default',
        transition: 'outline 0.1s',
      }}>
      {renderContent()}

      {selected && (
        <div style={{
          position: 'absolute', top: 4, right: 4, display: 'flex', gap: 1, zIndex: 20,
          background: '#1e293b', borderRadius: 7, padding: '3px 4px', boxShadow: '0 2px 8px rgba(0,0,0,.35)',
        }}>
          {[
            { title: 'Move up',   label: '↑', disabled: idx === 0,           action: () => onMove(-1) },
            { title: 'Move down', label: '↓', disabled: idx === total - 1,   action: () => onMove(1) },
          ].map(b => (
            <button key={b.title} type="button" title={b.title} disabled={b.disabled}
              onClick={e => { e.stopPropagation(); b.action() }}
              style={{ padding: '2px 7px', background: 'none', border: 'none', color: b.disabled ? '#475569' : '#cbd5e1', cursor: b.disabled ? 'default' : 'pointer', borderRadius: 4, fontWeight: 700, fontSize: 13 }}>
              {b.label}
            </button>
          ))}
          <div style={{ width: 1, background: '#334155', margin: '2px 1px' }} />
          <button type="button" title="Duplicate" onClick={e => { e.stopPropagation(); onDuplicate() }}
            style={{ padding: '2px 5px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', borderRadius: 4, display: 'flex' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>content_copy</span>
          </button>
          <button type="button" title="Delete" onClick={e => { e.stopPropagation(); onDelete() }}
            style={{ padding: '2px 5px', background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', borderRadius: 4, display: 'flex' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
          </button>
        </div>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════════
   PROPERTIES PANEL
══════════════════════════════════════════════════════ */
function PropsPanel({ block, onUpdate }: { block: EmailBlock | null; onUpdate: (p: Partial<EmailBlock>) => void }) {
  if (!block) return (
    <div style={{ padding: 20, textAlign: 'center' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 36, color: C.fg4, display: 'block', marginBottom: 10 }}>touch_app</span>
      <p style={{ fontSize: 12, color: C.fg3 }}>Click a block to edit its properties</p>
    </div>
  )

  const F = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 10, fontWeight: 700, color: C.fg3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  )

  const Inp = (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    <input style={{ ...formInput, fontSize: 12, padding: '5px 9px', ...props.style }} {...props} />

  const ColorRow = ({ label, field, def }: { label: string; field: keyof EmailBlock; def: string }) => (
    <F label={label}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="color" value={(block[field] as string) || def}
          onChange={e => onUpdate({ [field]: e.target.value })}
          style={{ width: 32, height: 28, borderRadius: 6, cursor: 'pointer', border: `1px solid ${C.b15}`, flexShrink: 0 }} />
        <Inp value={(block[field] as string) || def} onChange={e => onUpdate({ [field]: e.target.value })} />
      </div>
    </F>
  )

  const AlignRow = ({ field = 'align', def = 'center' }: { field?: keyof EmailBlock; def?: string }) => (
    <F label="Alignment">
      <div style={{ display: 'flex', gap: 4 }}>
        {(['left', 'center', 'right'] as const).map(a => (
          <button key={a} type="button" onClick={() => onUpdate({ [field]: a })}
            style={{ flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
              border: `1.5px solid ${(block[field] || def) === a ? '#3B82F6' : C.b15}`,
              background: (block[field] || def) === a ? '#EFF6FF' : 'transparent',
              color: (block[field] || def) === a ? '#3B82F6' : C.fg3 }}>
            {a}
          </button>
        ))}
      </div>
    </F>
  )

  switch (block.type) {
    case 'header':
      return <>
        <F label="Logo Text"><Inp value={block.logoText || ''} onChange={e => onUpdate({ logoText: e.target.value })} /></F>
        <F label="Tagline (optional)"><Inp value={block.tagline || ''} placeholder="e.g. Your Financial Partner" onChange={e => onUpdate({ tagline: e.target.value })} /></F>
        <ColorRow label="Background" field="bg" def={C.NAVY} />
        <ColorRow label="Text Color" field="textColor" def="#ffffff" />
        <F label="Vertical Padding">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Inp type="number" value={block.padding || 32} style={{ width: 70 }} onChange={e => onUpdate({ padding: Number(e.target.value) })} />
            <span style={{ fontSize: 11, color: C.fg4 }}>px</span>
          </div>
        </F>
      </>

    case 'text':
      return (
        <div style={{ padding: 10, background: C.muted, borderRadius: 8, textAlign: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 24, color: '#3B82F6', display: 'block', marginBottom: 8 }}>edit</span>
          <p style={{ fontSize: 12, color: C.fg2, lineHeight: 1.6 }}>Click the text block to edit it directly in the canvas.<br />Use the toolbar that appears for formatting.</p>
        </div>
      )

    case 'image':
      return <>
        <F label="Upload Image">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: C.muted, borderRadius: 8, border: `1.5px dashed ${C.b22}`, cursor: 'pointer', fontSize: 12, color: C.fg2 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>upload</span>
            Upload image
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => {
              const file = e.target.files?.[0]; if (!file) return
              try {
                const fd = new FormData(); fd.append('file', file)
                const res = await apiFetch('/api/campaigns/upload-image', { method: 'POST', body: fd } as any)
                onUpdate({ src: (res as any).url })
              } catch { alert('Upload failed') }
            }} />
          </label>
        </F>
        <F label="Or paste URL"><Inp value={block.src || ''} placeholder="https://…" onChange={e => onUpdate({ src: e.target.value })} /></F>
        <F label="Alt Text"><Inp value={block.alt || ''} onChange={e => onUpdate({ alt: e.target.value })} /></F>
        <F label="Click Link (optional)"><Inp value={block.link || ''} placeholder="https://…" onChange={e => onUpdate({ link: e.target.value })} /></F>
        <AlignRow />
        <F label="Rounded corners">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={block.rounded || false} onChange={e => onUpdate({ rounded: e.target.checked })} />
            Apply 8px border radius
          </label>
        </F>
      </>

    case 'button':
      return <>
        <F label="Button Text"><Inp value={block.text || ''} onChange={e => onUpdate({ text: e.target.value })} /></F>
        <F label="Link URL"><Inp value={block.url || ''} placeholder="https://…" onChange={e => onUpdate({ url: e.target.value })} /></F>
        <ColorRow label="Background" field="bg" def={C.RED} />
        <ColorRow label="Text Color" field="textColor" def="#ffffff" />
        <AlignRow />
        <F label="Size">
          <div style={{ display: 'flex', gap: 4 }}>
            {([['md', 'Normal'], ['lg', 'Large']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => onUpdate({ size: k })}
                style={{ flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${(block.size || 'md') === k ? '#3B82F6' : C.b15}`,
                  background: (block.size || 'md') === k ? '#EFF6FF' : 'transparent',
                  color: (block.size || 'md') === k ? '#3B82F6' : C.fg3 }}>
                {l}
              </button>
            ))}
          </div>
        </F>
        <F label="Shape">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={block.rounded !== false} onChange={e => onUpdate({ rounded: e.target.checked })} />
            Rounded corners
          </label>
        </F>
      </>

    case 'divider':
      return <>
        <ColorRow label="Color" field="color" def="#e0e0e0" />
        <F label="Thickness">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Inp type="number" value={block.thickness || 1} min={1} max={8} style={{ width: 70 }} onChange={e => onUpdate({ thickness: Number(e.target.value) })} />
            <span style={{ fontSize: 11, color: C.fg4 }}>px</span>
          </div>
        </F>
        <F label="Vertical Margin">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Inp type="number" value={block.margin || 20} style={{ width: 70 }} onChange={e => onUpdate({ margin: Number(e.target.value) })} />
            <span style={{ fontSize: 11, color: C.fg4 }}>px</span>
          </div>
        </F>
      </>

    case 'spacer':
      return (
        <F label="Height">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Inp type="number" value={block.height || 32} min={8} max={200} step={8} style={{ width: 70 }} onChange={e => onUpdate({ height: Number(e.target.value) })} />
            <span style={{ fontSize: 11, color: C.fg4 }}>px</span>
          </div>
        </F>
      )

    case 'two_col':
      return <>
        <F label="Column Split">
          {(['50/50', '60/40', '40/60', '70/30'] as const).map(v => (
            <button key={v} type="button" onClick={() => onUpdate({ split: v })}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', marginBottom: 4, borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: `1.5px solid ${block.split === v ? '#3B82F6' : C.b15}`,
                background: block.split === v ? '#EFF6FF' : 'transparent',
                color: block.split === v ? '#3B82F6' : C.fg2 }}>
              {v === '50/50' ? 'Equal (50/50)' : v === '60/40' ? '60 / 40' : v === '40/60' ? '40 / 60' : '70 / 30'}
            </button>
          ))}
        </F>
        <F label="Left Column HTML">
          <textarea style={{ ...formInput, fontSize: 11, fontFamily: 'monospace', resize: 'vertical' }}
            rows={4} value={block.leftHtml || ''} onChange={e => onUpdate({ leftHtml: e.target.value })} />
        </F>
        <F label="Right Column HTML">
          <textarea style={{ ...formInput, fontSize: 11, fontFamily: 'monospace', resize: 'vertical' }}
            rows={4} value={block.rightHtml || ''} onChange={e => onUpdate({ rightHtml: e.target.value })} />
        </F>
      </>

    case 'footer':
      return <>
        <F label="Footer Text">
          <textarea style={{ ...formInput, fontSize: 12, resize: 'vertical' }}
            rows={3} value={block.text || ''} onChange={e => onUpdate({ text: e.target.value })} />
        </F>
        <F label="Unsubscribe Link">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={block.unsubscribe || false} onChange={e => onUpdate({ unsubscribe: e.target.checked })} />
            Include unsubscribe link
          </label>
        </F>
      </>

    default: return <p style={{ fontSize: 12, color: C.fg3 }}>No properties for this block.</p>
  }
}

/* ══════════════════════════════════════════════════════
   TEMPLATE GALLERY
══════════════════════════════════════════════════════ */
function TemplateGallery({ onPick, onClose, hasBlocks }: {
  onPick: (tpl: typeof TEMPLATES[0]) => void
  onClose: () => void
  hasBlocks: boolean
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 740, maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,.2)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: `1px solid ${C.b08}` }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: C.fg1, margin: 0 }}>Choose a Template</h2>
            <p style={{ fontSize: 12, color: C.fg3, marginTop: 3, marginBottom: 0 }}>Start from a template or build from scratch — you can always switch later</p>
          </div>
          {hasBlocks && (
            <button style={btnIcon} onClick={onClose}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: C.fg3 }}>close</span>
            </button>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {TEMPLATES.map(tpl => (
              <button key={tpl.id} type="button"
                onClick={() => onPick(tpl)}
                style={{ padding: 16, borderRadius: 12, border: `1.5px solid ${C.b12}`, background: C.subtle, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = tpl.color; e.currentTarget.style.background = tpl.color + '0c' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.b12; e.currentTarget.style.background = C.subtle }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: tpl.color + '20', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 20, color: tpl.color }}>{tpl.icon}</span>
                </div>
                <p style={{ fontSize: 13, fontWeight: 700, color: C.fg1, marginBottom: 4, margin: '0 0 4px' }}>{tpl.name}</p>
                <p style={{ fontSize: 11, color: C.fg3, lineHeight: 1.5, margin: 0 }}>{tpl.desc}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════
   MAIN EDITOR COMPONENT
══════════════════════════════════════════════════════ */
interface EmailBlockEditorProps {
  value?:    EditorValue
  onChange?: (v: EditorValue) => void
}

export default function EmailBlockEditor({ value, onChange }: EmailBlockEditorProps) {
  const [blocks, setBlocks]           = useState<EmailBlock[]>(() => (value?.blocks || []).map(b => ({ ...b, id: b.id || uid() })))
  const [settings]                    = useState<EmailSettings>(value?.settings || { background: '#f4f4f4', contentWidth: 680 })
  const [selectedId, setSelectedId]   = useState<string | null>(null)
  const [showTemplates, setShowTemplates] = useState(!value?.blocks?.length)
  const [preview, setPreview]         = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')

  const selected = blocks.find(b => b.id === selectedId) || null

  const push = useCallback((next: EmailBlock[]) => {
    setBlocks(next)
    onChange?.({ blocks: next, settings })
  }, [settings, onChange])

  const addBlock = (type: string, afterId: string | null) => {
    const nb = DEF[type]?.(); if (!nb) return
    const idx = afterId != null ? blocks.findIndex(b => b.id === afterId) + 1 : blocks.length
    const next = [...blocks]; next.splice(idx, 0, nb)
    push(next); setSelectedId(nb.id)
  }

  const updateBlock = (id: string, patch: Partial<EmailBlock>) =>
    push(blocks.map(b => b.id === id ? { ...b, ...patch } : b))

  const duplicateBlock = (id: string) => {
    const orig = blocks.find(b => b.id === id); if (!orig) return
    const copy = { ...orig, id: uid() }
    const idx  = blocks.findIndex(b => b.id === id) + 1
    const next = [...blocks]; next.splice(idx, 0, copy)
    push(next); setSelectedId(copy.id)
  }

  const moveBlock = (id: string, dir: number) => {
    const i = blocks.findIndex(b => b.id === id)
    if (i + dir < 0 || i + dir >= blocks.length) return
    const next = [...blocks];
    [next[i], next[i + dir]] = [next[i + dir], next[i]]
    push(next)
  }

  const deleteBlock = (id: string) => {
    push(blocks.filter(b => b.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const openPreview = () => { setPreviewHtml(exportToHtml(blocks, settings)); setPreview(true) }

  const pickTemplate = (tpl: typeof TEMPLATES[0]) => {
    const next = tpl.blocks.map(b => ({ ...b, id: uid() }))
    push(next); setSelectedId(null); setShowTemplates(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 560, border: `1px solid ${C.b12}`, borderRadius: 10, overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: C.surf, borderBottom: `1px solid ${C.b08}`, flexShrink: 0 }}>
        <button type="button" style={btnGhost} onClick={() => setShowTemplates(true)}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>grid_view</span>
          Templates
        </button>
        <span style={{ fontSize: 11, color: C.fg4 }}>·</span>
        <span style={{ fontSize: 11, color: C.fg3 }}>{blocks.length} block{blocks.length !== 1 ? 's' : ''}</span>
        <div style={{ marginLeft: 'auto' }}>
          <button type="button" style={btnGhost} onClick={openPreview}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>preview</span>
            Preview
          </button>
        </div>
      </div>

      {/* Three-panel layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {/* LEFT — Block palette */}
        <div style={{ width: 88, flexShrink: 0, borderRight: `1px solid ${C.b08}`, background: C.subtle, overflowY: 'auto', padding: '10px 6px' }}>
          <p style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: C.fg4, textAlign: 'center', marginBottom: 10 }}>Blocks</p>
          {PALETTE.map(p => (
            <button key={p.type} type="button"
              onClick={() => addBlock(p.type, selectedId)}
              title={`Add ${p.label} ${selectedId ? 'after selected' : 'at end'}`}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: '100%', padding: '7px 2px', borderRadius: 8, border: '1px solid transparent', background: 'none', cursor: 'pointer', marginBottom: 2, transition: 'all 0.12s' }}
              onMouseEnter={e => { e.currentTarget.style.background = C.surf; e.currentTarget.style.borderColor = C.b15 }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.borderColor = 'transparent' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: C.fg2 }}>{p.icon}</span>
              <span style={{ fontSize: 9, color: C.fg3, textAlign: 'center', lineHeight: 1.2 }}>{p.label}</span>
            </button>
          ))}
        </div>

        {/* CENTER — Canvas */}
        <div style={{ flex: 1, overflowY: 'auto', background: '#dde1e7', padding: '20px 12px' }}
          onClick={() => setSelectedId(null)}>
          <div style={{ maxWidth: 680, margin: '0 auto', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,.14)' }}>
            {blocks.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: '#bbb' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 44, display: 'block', marginBottom: 12, color: '#d0d5dd' }}>email</span>
                <p style={{ fontSize: 14, color: '#9ca3af', marginBottom: 16 }}>Canvas is empty</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button type="button" style={btnPrimary} onClick={() => setShowTemplates(true)}>Choose Template</button>
                  <button type="button" style={btnGhost} onClick={() => addBlock('header', null)}>Add Header</button>
                </div>
              </div>
            ) : (
              blocks.map((block, i) => (
                <div key={block.id}>
                  <CanvasBlock
                    block={block} idx={i} total={blocks.length}
                    selected={selectedId === block.id}
                    onSelect={() => setSelectedId(block.id)}
                    onUpdate={(patch) => updateBlock(block.id, patch)}
                    onMove={(dir) => moveBlock(block.id, dir)}
                    onDelete={() => deleteBlock(block.id)}
                    onDuplicate={() => duplicateBlock(block.id)}
                  />
                  {/* Inter-block insert */}
                  <div style={{ height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={e => (e.currentTarget.style.opacity = '0')}>
                    <button type="button" onClick={e => { e.stopPropagation(); addBlock('text', block.id) }}
                      style={{ fontSize: 10, padding: '1px 12px', borderRadius: 999, background: '#3B82F6', color: '#fff', border: 'none', cursor: 'pointer' }}>
                      + Add block
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* RIGHT — Properties */}
        <div style={{ width: 220, flexShrink: 0, borderLeft: `1px solid ${C.b08}`, background: C.surf, overflowY: 'auto' }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.b08}` }}>
            <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.fg3, margin: 0 }}>
              {selected ? selected.type.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Properties'}
            </p>
          </div>
          <div style={{ padding: '14px' }}>
            <PropsPanel block={selected} onUpdate={(patch) => selected && updateBlock(selected.id, patch)} />
          </div>
        </div>
      </div>

      {/* Template gallery */}
      {showTemplates && (
        <TemplateGallery hasBlocks={blocks.length > 0} onPick={pickTemplate} onClose={() => setShowTemplates(false)} />
      )}

      {/* Preview modal */}
      {preview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 2000, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', background: C.NAVY, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>Email Preview</span>
            <button type="button" onClick={() => setPreview(false)}
              style={{ color: '#fff', background: 'none', border: '1px solid rgba(255,255,255,0.25)', fontSize: 12, cursor: 'pointer', padding: '4px 14px', borderRadius: 6 }}>
              Close
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', background: '#dde1e7', padding: 20 }}>
            <div style={{ maxWidth: 720, margin: '0 auto', background: '#fff', borderRadius: 8, boxShadow: '0 4px 24px rgba(0,0,0,.15)', overflow: 'hidden' }}>
              <iframe srcDoc={previewHtml} style={{ width: '100%', minHeight: 700, border: 'none', display: 'block' }} title="Email preview" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
