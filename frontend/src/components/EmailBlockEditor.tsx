/**
 * EmailBlockEditor — professional 3-panel email builder.
 * Features: drag-and-drop, undo/redo (⌘Z), 10 block types (incl. callout & stats),
 * template gallery, contentEditable rich text, image upload, mobile/desktop preview.
 */
import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react'
import DOMPurify from 'dompurify'
import { API, getCsrfToken } from '../lib/api'

const NAVY = '#0E2841'
const BLUE = '#2563EB'
const RED  = '#C00000'
const FONT = "'Inter', Arial, Helvetica, sans-serif"
const sanitize = (html: string) => DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmailBlock {
  id: string; type: string
  logoText?: string; tagline?: string; bg?: string; textColor?: string; padding?: number
  html?: string
  src?: string; alt?: string; link?: string; align?: string; rounded?: boolean; maxWidth?: number
  text?: string; url?: string; size?: string
  color?: string; thickness?: number; margin?: number; height?: number
  leftHtml?: string; rightHtml?: string; split?: string
  unsubscribe?: boolean
  theme?: string; title?: string; body?: string; icon?: string
  cols?: Array<{ value: string; label: string; color: string }>
}

export interface EmailSettings { background?: string; contentWidth?: number }
interface EditorValue { blocks: EmailBlock[]; settings?: EmailSettings }

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

const CT: Record<string, { bg: string; border: string; tc: string; bc: string }> = {
  warning: { bg: '#FEF3C7', border: '#D97706', tc: '#92400E', bc: '#78350F' },
  info:    { bg: '#DBEAFE', border: BLUE,       tc: '#1E40AF', bc: '#1D4ED8' },
  success: { bg: '#DCFCE7', border: '#16A34A',  tc: '#14532D', bc: '#166534' },
  error:   { bg: '#FEE2E2', border: '#EF4444',  tc: '#991B1B', bc: '#B91C1C' },
}

// ── Block defaults ─────────────────────────────────────────────────────────────
const DEF: Record<string, () => EmailBlock> = {
  header:  () => ({ id: uid(), type: 'header',  logoText: 'O3 Capital', tagline: 'Your Financial Partner', bg: NAVY, textColor: '#ffffff', padding: 36 }),
  text:    () => ({ id: uid(), type: 'text',    html: '<p style="margin:0 0 14px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0;">Enter your message here. You can format text and insert merge tags.</p>' }),
  image:   () => ({ id: uid(), type: 'image',   src: '', alt: '', link: '', align: 'center', rounded: false }),
  button:  () => ({ id: uid(), type: 'button',  text: 'Get Started', url: '{{cta_url}}', bg: NAVY, textColor: '#ffffff', align: 'center', size: 'md', rounded: true }),
  divider: () => ({ id: uid(), type: 'divider', color: '#E5E7EB', thickness: 1, margin: 20 }),
  spacer:  () => ({ id: uid(), type: 'spacer',  height: 32 }),
  two_col: () => ({ id: uid(), type: 'two_col', leftHtml: '<p style="margin:0;font-size:14px;line-height:1.7;"><strong>Left column</strong><br/>Your content here.</p>', rightHtml: '<p style="margin:0;font-size:14px;line-height:1.7;"><strong>Right column</strong><br/>Your content here.</p>', split: '50/50' }),
  footer:  () => ({ id: uid(), type: 'footer',  text: '© 2026 O3 Capital Financial Services Ltd · Lagos, Nigeria', unsubscribe: true }),
  callout: () => ({ id: uid(), type: 'callout', theme: 'warning', icon: '⚠️', title: 'Important Notice', body: 'Enter your callout message here. This block draws attention to critical information.' }),
  stats:   () => ({ id: uid(), type: 'stats',   cols: [{ value: '₦{{amount}}', label: 'Outstanding Balance', color: RED }, { value: '{{due_date}}', label: 'Payment Due', color: '#D97706' }] }),
}

const PALETTE = [
  { type: 'header',  label: 'Header',  icon: 'web_asset' },
  { type: 'text',    label: 'Text',    icon: 'article' },
  { type: 'image',   label: 'Image',   icon: 'image' },
  { type: 'button',  label: 'Button',  icon: 'smart_button' },
  { type: 'callout', label: 'Callout', icon: 'info' },
  { type: 'stats',   label: 'Stats',   icon: 'bar_chart' },
  { type: 'divider', label: 'Divider', icon: 'horizontal_rule' },
  { type: 'spacer',  label: 'Spacer',  icon: 'height' },
  { type: 'two_col', label: '2 Cols',  icon: 'view_column' },
  { type: 'footer',  label: 'Footer',  icon: 'bottom_navigation' },
]

const MERGE_TAGS = ['{{first_name}}', '{{last_name}}', '{{amount}}', '{{due_date}}', '{{company}}', '{{cta_url}}', '{{phone}}', '{{cif}}']

// ── Template presets ───────────────────────────────────────────────────────────
const TEMPLATES = [
  { id: 'blank', name: 'Blank Canvas', icon: 'add_box', color: '#6B7280', desc: 'Start from scratch', blocks: [] as EmailBlock[] },
  { id: 'simple', name: 'Simple Message', icon: 'article', color: BLUE, desc: 'Header · Message · CTA · Footer',
    blocks: [DEF.header(), { ...DEF.text(), html: '<p style="margin:0 0 16px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0 0 16px;">We have an important update regarding your O3 Capital account.</p><p style="margin:0;">Thank you for being a valued customer.</p>' }, { ...DEF.button(), text: 'View My Account' }, DEF.footer()] },
  { id: 'reminder', name: 'Payment Reminder', icon: 'payment', color: RED, desc: 'Stats block · Callout · Pay CTA',
    blocks: [{ ...DEF.header(), bg: RED, tagline: 'Action Required' }, { ...DEF.text(), html: '<p style="margin:0 0 14px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0;">Your O3C account has an outstanding balance that requires your immediate attention.</p>' }, { ...DEF.stats(), cols: [{ value: '₦{{amount}}', label: 'Outstanding Balance', color: RED }, { value: '{{due_date}}', label: 'Payment Due', color: '#D97706' }] }, { ...DEF.callout(), theme: 'warning', icon: '⚠️', title: 'Avoid Late Fees', body: 'Payments after the due date attract a 2% monthly penalty. Pay now to avoid additional charges.' }, { ...DEF.button(), text: 'Pay Now — Clear My Balance', bg: RED }, DEF.footer()] },
  { id: 'welcome', name: 'Welcome', icon: 'waving_hand', color: '#7C3AED', desc: 'Onboard new customers',
    blocks: [DEF.header(), { ...DEF.text(), html: '<h2 style="margin:0 0 14px;color:#0E2841;font-size:22px;font-weight:700;">Welcome aboard, {{first_name}}! 🎉</h2><p style="margin:0 0 14px;">Your O3C account is ready.</p><ul style="margin:0;padding-left:20px;color:#374151;line-height:2.1;"><li><strong>Instant payments</strong> — pay anywhere, anytime</li><li><strong>Cashback rewards</strong> — earn on every spend</li><li><strong>Zero forex fees</strong> — international transfers</li><li><strong>24/7 support</strong> — always here for you</li></ul>' }, { ...DEF.callout(), theme: 'info', icon: 'ℹ️', title: 'Complete Your Profile', body: 'Verify your BVN and NIN within 30 days to unlock your full credit limit and all account features.' }, { ...DEF.button(), text: 'Activate My Account' }, DEF.footer()] },
  { id: 'promo', name: 'Promotion', icon: 'local_offer', color: '#059669', desc: 'Hero image · Headline · CTA',
    blocks: [DEF.header(), DEF.image(), { ...DEF.text(), html: '<h2 style="margin:0 0 12px;font-size:22px;color:#0E2841;font-weight:700;">Exclusive Offer, {{first_name}} ✨</h2><p style="margin:0 0 16px;color:#4B5563;line-height:1.7;">Enjoy premium benefits with your O3C Card — cashback rewards, zero forex fees, and instant transfers.</p>' }, { ...DEF.button(), text: 'Claim Your Offer', bg: '#059669' }, DEF.footer()] },
  { id: 'statement', name: 'Monthly Statement', icon: 'receipt_long', color: '#0EA5E9', desc: 'Statement notification + stats',
    blocks: [DEF.header(), { ...DEF.text(), html: '<p style="margin:0 0 14px;">Dear <strong>{{first_name}}</strong>,</p><p style="margin:0;">Your monthly account statement is now available for review.</p>' }, { ...DEF.stats(), cols: [{ value: '₦{{amount}}', label: 'Total Spend', color: NAVY }, { value: '{{due_date}}', label: 'Statement Period', color: '#0EA5E9' }] }, { ...DEF.button(), text: 'View Full Statement', bg: '#0EA5E9' }, DEF.footer()] },
  { id: 'loan', name: 'Loan Update', icon: 'account_balance', color: '#D97706', desc: 'Approval · 3-col stats · Next steps',
    blocks: [{ ...DEF.header(), tagline: 'Loan Update' }, { ...DEF.callout(), theme: 'success', icon: '✅', title: 'Your Loan Has Been Approved!', body: 'Congratulations! Your application has been reviewed and approved. Funds will be disbursed within 1 business day.' }, { ...DEF.stats(), cols: [{ value: '₦{{amount}}', label: 'Approved Amount', color: '#059669' }, { value: '{{due_date}}', label: 'First Repayment', color: '#D97706' }, { value: '12 months', label: 'Loan Tenure', color: NAVY }] }, { ...DEF.text(), html: '<p style="margin:0 0 14px;">Please ensure you have sufficient balance for your monthly repayments on the due date to avoid late fees.</p>' }, { ...DEF.button(), text: 'View Loan Dashboard' }, DEF.footer()] },
]

// ── HTML generator ─────────────────────────────────────────────────────────────
function blockToHtml(b: EmailBlock): string {
  const wrap = (inner: string, pad = '0 32px') => `<tr><td style="font-family:${FONT};padding:${pad};">${inner}</td></tr>`
  switch (b.type) {
    case 'header':
      return `<tr><td style="background:${b.bg || NAVY};padding:${b.padding || 36}px 40px;text-align:center;font-family:${FONT};"><div style="font-size:22px;font-weight:800;color:${b.textColor || '#fff'};letter-spacing:-0.4px;">${b.logoText || 'O3 Capital'}</div>${b.tagline ? `<div style="font-size:11px;color:${b.textColor || '#fff'}90;margin-top:8px;text-transform:uppercase;letter-spacing:0.1em;">${b.tagline}</div>` : ''}</td></tr>`
    case 'text':
      return wrap(b.html || '', '20px 40px')
    case 'image':
      return wrap(`<div style="text-align:${b.align || 'center'};">${b.link ? `<a href="${b.link}" target="_blank">` : ''}${b.src ? `<img src="${b.src}" alt="${b.alt || ''}" style="max-width:${b.maxWidth ? b.maxWidth + 'px' : '100%'};height:auto;display:inline-block;${b.rounded ? 'border-radius:8px;' : ''}" />` : `<div style="height:180px;background:#F3F4F6;border-radius:8px;border:2px dashed #D1D5DB;text-align:center;padding-top:70px;box-sizing:border-box;color:#9CA3AF;font-size:13px;">[ Image placeholder ]</div>`}${b.link ? '</a>' : ''}</div>`, '12px 32px')
    case 'button':
      return wrap(`<div style="text-align:${b.align || 'center'};padding:8px 0 16px;"><a href="${b.url || '#'}" target="_blank" style="display:inline-block;padding:${b.size === 'lg' ? '16px 48px' : b.size === 'sm' ? '9px 24px' : '13px 36px'};background:${b.bg || NAVY};color:${b.textColor || '#fff'};font-weight:700;font-size:${b.size === 'lg' ? '16px' : '14px'};text-decoration:none;border-radius:${b.rounded !== false ? '7px' : '2px'};font-family:${FONT};">${b.text || 'Click Here'}</a></div>`, '0 32px')
    case 'divider':
      return wrap(`<hr style="border:none;border-top:${b.thickness || 1}px solid ${b.color || '#E5E7EB'};margin:${b.margin || 20}px 0;" />`, '0 32px')
    case 'spacer':
      return `<tr><td style="height:${b.height || 32}px;line-height:${b.height || 32}px;font-size:0;">&nbsp;</td></tr>`
    case 'two_col': {
      const [l, r] = (b.split || '50/50').split('/').map(Number)
      return wrap(`<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="${l}%" valign="top" style="padding-right:16px;font-size:14px;color:#374151;line-height:1.75;font-family:${FONT};">${b.leftHtml || ''}</td><td width="${r}%" valign="top" style="padding-left:16px;font-size:14px;color:#374151;line-height:1.75;font-family:${FONT};">${b.rightHtml || ''}</td></tr></table>`, '12px 32px')
    }
    case 'footer':
      return `<tr><td style="background:#F9FAFB;border-top:1px solid #E5E7EB;padding:24px 40px;text-align:center;font-family:${FONT};"><p style="margin:0 0 6px;font-size:11px;color:#9CA3AF;">${b.text || '© 2026 O3 Capital'}</p>${b.unsubscribe ? `<p style="margin:0;font-size:10px;color:#D1D5DB;">You received this email as an O3 Capital customer. <a href="{{unsubscribe_url}}" style="color:#D1D5DB;">Unsubscribe</a></p>` : ''}</td></tr>`
    case 'callout': {
      const ct = CT[b.theme || 'warning']
      return wrap(`<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${ct.bg};border-left:4px solid ${ct.border};border-radius:6px;padding:16px 20px;"><p style="margin:0 0 6px;font-size:14px;font-weight:700;color:${ct.tc};font-family:${FONT};">${b.icon || '⚠️'} ${b.title || 'Notice'}</p><p style="margin:0;font-size:13px;color:${ct.bc};line-height:1.65;font-family:${FONT};">${b.body || ''}</p></td></tr></table>`, '6px 32px')
    }
    case 'stats': {
      const cols = b.cols || []; if (!cols.length) return ''
      const w = Math.floor(100 / cols.length)
      const tds = cols.map((c, i) => `<td width="${w}%" style="text-align:center;padding:22px 12px;${i < cols.length - 1 ? 'border-right:1px solid #E5E7EB;' : ''}"><div style="font-size:24px;font-weight:800;color:${c.color || NAVY};font-family:${FONT};line-height:1.2;">${c.value}</div><div style="font-size:11px;color:#6B7280;margin-top:7px;font-family:${FONT};text-transform:uppercase;letter-spacing:0.07em;">${c.label}</div></td>`).join('')
      return wrap(`<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;"><tr>${tds}</tr></table>`, '6px 32px')
    }
    default: return ''
  }
}

export function exportToHtml(blocks: EmailBlock[] = [], settings: EmailSettings = {}): string {
  const bg = settings.background || '#E8ECF2'; const w = settings.contentWidth || 660
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{margin:0;padding:0;background:${bg};}a{color:inherit;}img{border:0;max-width:100%;height:auto;}@media(max-width:600px){.ec{width:100%!important;border-radius:0!important;}}</style></head><body style="margin:0;padding:0;background:${bg};"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${bg};"><tr><td align="center" style="padding:36px 16px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" class="ec" style="width:100%;max-width:${w}px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.09);">${blocks.map(blockToHtml).join('')}</table></td></tr></table></body></html>`
}

export const blocksToHtml = (blocks: EmailBlock[], s?: EmailSettings) => exportToHtml(blocks, s)
export type Block = EmailBlock

// ── History hook ───────────────────────────────────────────────────────────────
function useHistory<T>(initial: T) {
  const [h, setH] = useState<{ stack: T[]; idx: number }>({ stack: [initial], idx: 0 })
  const push = useCallback((next: T) => setH(({ stack, idx }) => { const s = [...stack.slice(0, idx + 1), next].slice(-60); return { stack: s, idx: s.length - 1 } }), [])
  const undo = useCallback(() => setH(s => s.idx > 0 ? { ...s, idx: s.idx - 1 } : s), [])
  const redo = useCallback(() => setH(s => s.idx < s.stack.length - 1 ? { ...s, idx: s.idx + 1 } : s), [])
  return { value: h.stack[h.idx], push, undo, redo, canUndo: h.idx > 0, canRedo: h.idx < h.stack.length - 1 }
}

const fi: CSSProperties = { width: '100%', padding: '5px 9px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.13)', outline: 'none', fontSize: 12, fontFamily: 'inherit', background: '#fff', color: '#1e293b', boxSizing: 'border-box' }

// ── PropsPanel helper components (module-level — MUST stay outside PropsPanel
//    so React sees a stable function reference on every render and never remounts
//    the underlying DOM inputs, which would kill focus after every keystroke) ──
const PPField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 13 }}>
    <label style={{ display: 'block', fontSize: 9.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 5 }}>{label}</label>
    {children}
  </div>
)
const PPInp = (props: React.InputHTMLAttributes<HTMLInputElement>) =>
  <input style={{ ...fi, ...props.style }} {...props} />

const ColorField = ({ label, value, def, onPick }: { label: string; value?: string; def: string; onPick: (v: string) => void }) => (
  <PPField label={label}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="color" value={value || def} onChange={e => onPick(e.target.value)}
        style={{ width: 30, height: 28, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.13)', flexShrink: 0, padding: 1 }} />
      <PPInp value={value || def} onChange={e => onPick(e.target.value)} />
    </div>
  </PPField>
)

const SegBtn = ({ label, opts, value, onPick }: { label: string; opts: [string, string][]; value: string; onPick: (v: string) => void }) => (
  <PPField label={label}>
    <div style={{ display: 'flex', gap: 4 }}>
      {opts.map(([k, l]) => { const on = value === k; return (
        <button key={k} type="button" onClick={() => onPick(k)}
          style={{ flex: 1, padding: '5px 0', borderRadius: 6, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${on ? BLUE : 'rgba(0,0,0,0.13)'}`, background: on ? `${BLUE}12` : 'transparent', color: on ? BLUE : '#64748b' }}>{l}</button>
      )})}
    </div>
  </PPField>
)

// ── PropsPanel ─────────────────────────────────────────────────────────────────
function PropsPanel({ block, onUpdate }: { block: EmailBlock | null; onUpdate: (p: Partial<EmailBlock>) => void }) {
  if (!block) return (
    <div style={{ padding: '28px 16px', textAlign: 'center', color: '#94a3b8' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 40, display: 'block', marginBottom: 12, color: '#e2e8f0' }}>touch_app</span>
      <p style={{ fontSize: 12, lineHeight: 1.65, margin: 0 }}>Click any block in the canvas to edit its properties</p>
    </div>
  )

  switch (block.type) {
    case 'header':
      return <><PPField label="Brand Name"><PPInp value={block.logoText || ''} onChange={e => onUpdate({ logoText: e.target.value })} /></PPField>
        <PPField label="Tagline"><PPInp value={block.tagline || ''} placeholder="optional" onChange={e => onUpdate({ tagline: e.target.value })} /></PPField>
        <ColorField label="Background" value={block.bg} def={NAVY} onPick={v => onUpdate({ bg: v })} />
        <ColorField label="Text Color" value={block.textColor} def="#ffffff" onPick={v => onUpdate({ textColor: v })} />
        <PPField label="Padding (px)"><PPInp type="number" value={block.padding || 36} style={{ width: 80 }} onChange={e => onUpdate({ padding: Number(e.target.value) })} /></PPField></>
    case 'text':
      return <div style={{ padding: 14, background: '#F1F5F9', borderRadius: 8, textAlign: 'center' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 28, color: BLUE, display: 'block', marginBottom: 8 }}>edit</span>
        <p style={{ fontSize: 12, color: '#334155', lineHeight: 1.6, margin: 0 }}>Click the text block in the canvas to edit directly. Use the toolbar that appears for formatting.</p>
      </div>
    case 'image':
      return <><PPField label="Upload Image">
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', background: '#F8FAFC', borderRadius: 7, border: '1.5px dashed rgba(0,0,0,0.15)', cursor: 'pointer', fontSize: 12, color: '#475569' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>upload</span>Choose file
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => {
            const file = e.target.files?.[0]; if (!file) return
            const fd = new FormData(); fd.append('image', file)
            try { const res = await fetch(`${API}/api/campaigns/upload-image`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() }, body: fd }); if (!res.ok) throw new Error(`Upload failed (${res.status})`); onUpdate({ src: (await res.json()).url }) }
            catch (err: any) { alert(err?.message || 'Upload failed') }
          }} />
        </label></PPField>
        <PPField label="Or paste URL"><PPInp value={block.src || ''} placeholder="https://…" onChange={e => onUpdate({ src: e.target.value })} /></PPField>
        <PPField label="Alt Text"><PPInp value={block.alt || ''} onChange={e => onUpdate({ alt: e.target.value })} /></PPField>
        <PPField label="Click Link"><PPInp value={block.link || ''} placeholder="https://…" onChange={e => onUpdate({ link: e.target.value })} /></PPField>
        <SegBtn label="Alignment" opts={[['left', 'Left'], ['center', 'Center'], ['right', 'Right']]} value={(block.align as string) || 'center'} onPick={v => onUpdate({ align: v })} />
        <PPField label="Rounded Corners"><label style={{ display: 'flex', gap: 8, fontSize: 12, cursor: 'pointer', alignItems: 'center' }}><input type="checkbox" checked={!!block.rounded} onChange={e => onUpdate({ rounded: e.target.checked })} />Apply 8px radius</label></PPField></>
    case 'button':
      return <><PPField label="Label"><PPInp value={block.text || ''} onChange={e => onUpdate({ text: e.target.value })} /></PPField>
        <PPField label="Link URL"><PPInp value={block.url || ''} placeholder="{{cta_url}}" onChange={e => onUpdate({ url: e.target.value })} /></PPField>
        <ColorField label="Background" value={block.bg} def={NAVY} onPick={v => onUpdate({ bg: v })} />
        <ColorField label="Text Color" value={block.textColor} def="#ffffff" onPick={v => onUpdate({ textColor: v })} />
        <SegBtn label="Alignment" opts={[['left', 'Left'], ['center', 'Center'], ['right', 'Right']]} value={(block.align as string) || 'center'} onPick={v => onUpdate({ align: v })} />
        <SegBtn label="Size" opts={[['sm', 'Small'], ['md', 'Normal'], ['lg', 'Large']]} value={(block.size as string) || 'md'} onPick={v => onUpdate({ size: v })} />
        <PPField label="Shape"><label style={{ display: 'flex', gap: 8, fontSize: 12, cursor: 'pointer', alignItems: 'center' }}><input type="checkbox" checked={block.rounded !== false} onChange={e => onUpdate({ rounded: e.target.checked })} />Rounded corners</label></PPField></>
    case 'divider':
      return <><ColorField label="Line Color" value={block.color} def="#E5E7EB" onPick={v => onUpdate({ color: v })} />
        <div style={{ display: 'flex', gap: 10 }}>
          <PPField label="Thickness (px)"><PPInp type="number" value={block.thickness || 1} min={1} max={8} style={{ width: 70 }} onChange={e => onUpdate({ thickness: Number(e.target.value) })} /></PPField>
          <PPField label="Margin (px)"><PPInp type="number" value={block.margin || 20} style={{ width: 70 }} onChange={e => onUpdate({ margin: Number(e.target.value) })} /></PPField>
        </div></>
    case 'spacer':
      return <PPField label={`Height: ${block.height || 32}px`}><input type="range" min={8} max={120} step={8} value={block.height || 32} onChange={e => onUpdate({ height: Number(e.target.value) })} style={{ width: '100%' }} /></PPField>
    case 'two_col':
      return <><PPField label="Split">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {['50/50', '60/40', '40/60', '70/30'].map(v => { const on = block.split === v; return (
            <button key={v} type="button" onClick={() => onUpdate({ split: v })}
              style={{ flex: '1 1 calc(50% - 4px)', padding: '5px 0', borderRadius: 6, fontSize: 10.5, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${on ? BLUE : 'rgba(0,0,0,0.13)'}`, background: on ? `${BLUE}12` : 'transparent', color: on ? BLUE : '#64748b' }}>{v}</button>
          )})}
        </div></PPField>
        <PPField label="Left HTML"><textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...fi, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }} rows={4} value={block.leftHtml || ''} onChange={e => onUpdate({ leftHtml: e.target.value })} /></PPField>
        <PPField label="Right HTML"><textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...fi, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }} rows={4} value={block.rightHtml || ''} onChange={e => onUpdate({ rightHtml: e.target.value })} /></PPField></>
    case 'footer':
      return <><PPField label="Footer Text"><textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...fi, resize: 'vertical', fontSize: 12 }} rows={3} value={block.text || ''} onChange={e => onUpdate({ text: e.target.value })} /></PPField>
        <PPField label="Unsubscribe"><label style={{ display: 'flex', gap: 8, fontSize: 12, cursor: 'pointer', alignItems: 'center' }}><input type="checkbox" checked={block.unsubscribe !== false} onChange={e => onUpdate({ unsubscribe: e.target.checked })} />Include unsubscribe link</label></PPField></>
    case 'callout':
      return <><PPField label="Theme">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {[['warning', '⚠️ Warning', '#D97706'], ['info', 'ℹ️ Info', BLUE], ['success', '✅ Success', '#16A34A'], ['error', '🚨 Error', '#EF4444']].map(([k, l, c]) => {
            const on = (block.theme || 'warning') === k; return (
              <button key={k} type="button" onClick={() => onUpdate({ theme: k })}
                style={{ flex: '1 1 calc(50% - 5px)', padding: '7px 4px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${on ? c : 'rgba(0,0,0,0.13)'}`, background: on ? c + '14' : 'transparent', color: on ? c : '#64748b' }}>{l}</button>
            )
          })}
        </div></PPField>
        <PPField label="Icon (emoji)"><PPInp value={block.icon || ''} placeholder="⚠️" onChange={e => onUpdate({ icon: e.target.value })} /></PPField>
        <PPField label="Title"><PPInp value={block.title || ''} onChange={e => onUpdate({ title: e.target.value })} /></PPField>
        <PPField label="Body"><textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...fi, resize: 'vertical', fontSize: 12, lineHeight: 1.6 }} rows={3} value={block.body || ''} onChange={e => onUpdate({ body: e.target.value })} /></PPField></>
    case 'stats': {
      const sc = block.cols || []
      return <><PPField label="Columns">
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {[2, 3].map(n => { const on = sc.length === n; return (
            <button key={n} type="button" onClick={() => { const next = [...sc]; while (next.length < n) next.push({ value: '—', label: 'Metric', color: NAVY }); onUpdate({ cols: next.slice(0, n) }) }}
              style={{ flex: 1, padding: '6px 0', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1.5px solid ${on ? BLUE : 'rgba(0,0,0,0.13)'}`, background: on ? `${BLUE}12` : 'transparent', color: on ? BLUE : '#64748b' }}>{n} cols</button>
          )})}
        </div></PPField>
        {sc.map((col, i) => (
          <div key={i} style={{ marginBottom: 12, padding: '10px 12px', background: '#F8FAFC', borderRadius: 8, border: '1px solid rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Column {i + 1}</div>
            <PPField label="Value"><PPInp value={col.value} onChange={e => { const n = [...sc]; n[i] = { ...n[i], value: e.target.value }; onUpdate({ cols: n }) }} /></PPField>
            <PPField label="Label"><PPInp value={col.label} onChange={e => { const n = [...sc]; n[i] = { ...n[i], label: e.target.value }; onUpdate({ cols: n }) }} /></PPField>
            <PPField label="Color"><div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="color" value={col.color || NAVY} onChange={e => { const n = [...sc]; n[i] = { ...n[i], color: e.target.value }; onUpdate({ cols: n }) }} style={{ width: 30, height: 28, borderRadius: 5, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.13)', flexShrink: 0, padding: 1 }} />
              <PPInp value={col.color || NAVY} onChange={e => { const n = [...sc]; n[i] = { ...n[i], color: e.target.value }; onUpdate({ cols: n }) }} />
            </div></PPField>
          </div>
        ))}</>
    }
    default: return <p style={{ fontSize: 12, color: '#94a3b8' }}>No properties for this block.</p>
  }
}

// ── CanvasBlock ────────────────────────────────────────────────────────────────
interface CBP {
  block: EmailBlock; selected: boolean; idx: number; total: number
  isDragging: boolean; dropAbove: boolean | null
  onSelect(): void; onUpdate(p: Partial<EmailBlock>): void
  onMove(d: number): void; onDelete(): void; onDuplicate(): void
  onDragStart(): void; onDragEnd(): void
  onDragOver(e: React.DragEvent): void; onDrop(): void
}

function CanvasBlock({ block, selected, idx, total, isDragging, dropAbove, onSelect, onUpdate, onMove, onDelete, onDuplicate, onDragStart, onDragEnd, onDragOver, onDrop }: CBP) {
  const textRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (textRef.current && block.type === 'text' && !selected && textRef.current.innerHTML !== block.html)
      textRef.current.innerHTML = sanitize(block.html || '')
  }, [block.html, selected, block.type])

  const ct = CT[block.theme || 'warning']

  const renderContent = () => {
    switch (block.type) {
      case 'header':
        return <div style={{ padding: `${block.padding || 36}px 40px`, background: block.bg || NAVY, textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: block.textColor || '#fff', letterSpacing: '-0.3px' }}>{block.logoText || 'O3 Capital'}</div>
          {block.tagline && <div style={{ fontSize: 11, color: (block.textColor || '#fff') + '90', marginTop: 7, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{block.tagline}</div>}
        </div>
      case 'text':
        return <>
          {selected && <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', background: '#1e293b', flexWrap: 'wrap' }}>
            {[
              { icon: 'format_bold',         fn: () => { const s = window.getSelection(); if (!s?.rangeCount) return; const r = s.getRangeAt(0); const e = document.createElement('strong'); e.appendChild(r.extractContents()); r.insertNode(e) } },
              { icon: 'format_italic',       fn: () => { const s = window.getSelection(); if (!s?.rangeCount) return; const r = s.getRangeAt(0); const e = document.createElement('em'); e.appendChild(r.extractContents()); r.insertNode(e) } },
              { icon: 'format_underlined',   fn: () => { const s = window.getSelection(); if (!s?.rangeCount) return; const r = s.getRangeAt(0); const e = document.createElement('u'); e.appendChild(r.extractContents()); r.insertNode(e) } },
              { icon: 'format_align_left',   fn: () => { const el = window.getSelection()?.anchorNode?.parentElement?.closest('p,div,h1,h2,h3') as HTMLElement|null; if (el) el.style.textAlign = 'left' } },
              { icon: 'format_align_center', fn: () => { const el = window.getSelection()?.anchorNode?.parentElement?.closest('p,div,h1,h2,h3') as HTMLElement|null; if (el) el.style.textAlign = 'center' } },
              { icon: 'link',                fn: () => { const s = window.getSelection(); if (!s?.rangeCount) return; const url = prompt('URL:'); if (!url) return; const r = s.getRangeAt(0); const a = document.createElement('a'); a.href = url; a.style.color = NAVY; a.appendChild(r.extractContents()); r.insertNode(a) } },
            ].map(({ icon, fn }) => (
              <button key={icon} type="button" onMouseDown={e => { e.preventDefault(); fn() }} style={{ padding: '2px 4px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', borderRadius: 3, display: 'flex' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{icon}</span>
              </button>
            ))}
            <div style={{ width: 1, height: 14, background: '#334155', margin: '0 2px' }} />
            {MERGE_TAGS.slice(0, 5).map(t => (
              <button key={t} type="button" onMouseDown={e => { e.preventDefault(); const s = window.getSelection(); if (!s?.rangeCount) return; const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(document.createTextNode(t)) }}
                style={{ fontSize: 9.5, padding: '1px 5px', background: '#334155', border: 'none', color: '#94a3b8', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace' }}>{t}</button>
            ))}
          </div>}
          <div ref={textRef} contentEditable={selected} suppressContentEditableWarning
            onBlur={() => { if (textRef.current) onUpdate({ html: textRef.current.innerHTML }) }}
            style={{ padding: '20px 36px', fontSize: 14.5, lineHeight: 1.78, color: '#1a1a1a', outline: 'none', minHeight: 60 }}
            {...(!selected ? { dangerouslySetInnerHTML: { __html: sanitize(block.html || '') } } : {})}
          />
        </>
      case 'image':
        return <div style={{ textAlign: (block.align as any) || 'center', padding: '14px 36px' }}>
          {block.src ? <img src={block.src} alt={block.alt} style={{ maxWidth: '100%', display: 'inline-block', borderRadius: block.rounded ? 8 : 0 }} />
            : <div style={{ height: 150, background: '#F3F4F6', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, border: '2px dashed #D1D5DB', color: '#9CA3AF' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 32, color: '#D1D5DB' }}>image</span>
                <span style={{ fontSize: 12 }}>Upload in properties panel →</span>
              </div>}
        </div>
      case 'button':
        return <div style={{ textAlign: (block.align as any) || 'center', padding: '10px 36px 22px' }}>
          <div style={{ display: 'inline-block', padding: block.size === 'lg' ? '14px 44px' : block.size === 'sm' ? '8px 22px' : '12px 32px', background: block.bg || NAVY, color: block.textColor || '#fff', fontWeight: 700, fontSize: block.size === 'lg' ? 15 : 13.5, borderRadius: block.rounded !== false ? 7 : 2 }}>
            {block.text || 'Click Here'}
          </div>
        </div>
      case 'divider':
        return <div style={{ padding: `${block.margin || 20}px 36px` }}><hr style={{ border: 'none', borderTop: `${block.thickness || 1}px solid ${block.color || '#E5E7EB'}`, margin: 0 }} /></div>
      case 'spacer':
        return <div style={{ height: block.height || 32, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-linear-gradient(45deg,#F8FAFC,#F8FAFC 4px,#fff 4px,#fff 8px)' }}>
          <span style={{ fontSize: 9, color: '#CBD5E1', textTransform: 'uppercase', letterSpacing: '0.08em', background: '#fff', padding: '1px 8px', borderRadius: 3 }}>{block.height || 32}px</span>
        </div>
      case 'two_col': {
        const [l, r] = (block.split || '50/50').split('/').map(Number)
        return <div style={{ display: 'flex', padding: '14px 36px', gap: 16 }}>
          <div style={{ flex: l, fontSize: 13.5, lineHeight: 1.75, color: '#374151' }} dangerouslySetInnerHTML={{ __html: sanitize(block.leftHtml || '<p>Left column</p>') }} />
          <div style={{ width: 1, background: '#F0F0F0', flexShrink: 0 }} />
          <div style={{ flex: r, fontSize: 13.5, lineHeight: 1.75, color: '#374151' }} dangerouslySetInnerHTML={{ __html: sanitize(block.rightHtml || '<p>Right column</p>') }} />
        </div>
      }
      case 'footer':
        return <div style={{ padding: '22px 36px', background: '#F9FAFB', borderTop: '1px solid #E5E7EB', textAlign: 'center' }}>
          <p style={{ margin: '0 0 4px', fontSize: 11, color: '#9CA3AF' }}>{block.text || '© 2026 O3 Capital'}</p>
          {block.unsubscribe && <p style={{ margin: 0, fontSize: 10, color: '#D1D5DB' }}>Unsubscribe link included</p>}
        </div>
      case 'callout':
        return <div style={{ padding: '8px 32px' }}>
          <div style={{ background: ct.bg, borderLeft: `4px solid ${ct.border}`, borderRadius: 7, padding: '14px 18px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: ct.tc, marginBottom: 5 }}>{block.icon || '⚠️'} {block.title || 'Notice'}</div>
            <div style={{ fontSize: 13, color: ct.bc, lineHeight: 1.65 }}>{block.body || 'Enter your callout message.'}</div>
          </div>
        </div>
      case 'stats': {
        const cols = block.cols || []
        if (!cols.length) return <div style={{ padding: '16px 32px', textAlign: 'center', color: '#9CA3AF', fontSize: 12 }}>Configure stats in properties panel →</div>
        return <div style={{ padding: '8px 32px' }}>
          <div style={{ display: 'flex', border: '1px solid #E5E7EB', borderRadius: 8, overflow: 'hidden' }}>
            {cols.map((col, i) => (
              <div key={i} style={{ flex: 1, textAlign: 'center', padding: '20px 12px', borderRight: i < cols.length - 1 ? '1px solid #E5E7EB' : 'none' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: col.color || NAVY, lineHeight: 1.2 }}>{col.value}</div>
                <div style={{ fontSize: 10.5, color: '#6B7280', marginTop: 7, textTransform: 'uppercase', letterSpacing: '0.07em' }}>{col.label}</div>
              </div>
            ))}
          </div>
        </div>
      }
      default: return null
    }
  }

  return (
    <div draggable={!selected}
      onDragStart={e => { if (selected) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; onDragStart() }}
      onDragEnd={onDragEnd}
      onDragOver={e => { e.preventDefault(); onDragOver(e) }}
      onDrop={e => { e.preventDefault(); onDrop() }}
      onClick={e => { e.stopPropagation(); onSelect() }}
      style={{ position: 'relative', opacity: isDragging ? 0.35 : 1, cursor: selected ? 'default' : 'grab' }}
    >
      {dropAbove === true  && <div style={{ position: 'absolute', top: 0,    left: 0, right: 0, height: 3, background: BLUE, zIndex: 10, borderRadius: 2 }} />}
      <div style={{ outline: selected ? `2px solid ${BLUE}` : '2px solid transparent', outlineOffset: -1, position: 'relative', transition: 'outline 0.1s' }}>
        {selected && <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 5, background: BLUE, color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: '0 0 6px 0', textTransform: 'uppercase', letterSpacing: '0.08em', pointerEvents: 'none' }}>{block.type.replace('_', ' ')}</div>}
        {renderContent()}
        {selected && (
          <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 1, zIndex: 20, background: '#1e293b', borderRadius: 7, padding: '3px 4px', boxShadow: '0 2px 10px rgba(0,0,0,.35)' }}>
            {([['↑', idx === 0, () => onMove(-1)], ['↓', idx === total - 1, () => onMove(1)]] as [string, boolean, () => void][]).map(([lbl, dis, fn]) => (
              <button key={lbl} type="button" disabled={dis} onClick={e => { e.stopPropagation(); fn() }}
                style={{ padding: '2px 7px', background: 'none', border: 'none', color: dis ? '#475569' : '#cbd5e1', cursor: dis ? 'default' : 'pointer', borderRadius: 4, fontWeight: 700, fontSize: 13 }}>{lbl}</button>
            ))}
            <div style={{ width: 1, background: '#334155', margin: '2px 1px' }} />
            <button type="button" title="Duplicate" onClick={e => { e.stopPropagation(); onDuplicate() }} style={{ padding: '2px 5px', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', borderRadius: 4, display: 'flex' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>content_copy</span>
            </button>
            <button type="button" title="Delete" onClick={e => { e.stopPropagation(); onDelete() }} style={{ padding: '2px 5px', background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', borderRadius: 4, display: 'flex' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>delete</span>
            </button>
          </div>
        )}
      </div>
      {dropAbove === false && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: BLUE, zIndex: 10, borderRadius: 2 }} />}
    </div>
  )
}

// ── Template Gallery ───────────────────────────────────────────────────────────
function TemplateGallery({ onPick, onClose }: { onPick(t: typeof TEMPLATES[0]): void; onClose(): void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 780, maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 14, boxShadow: '0 24px 64px rgba(0,0,0,.22)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #F1F5F9' }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: '0 0 3px' }}>Choose a Starting Template</h2>
            <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>Pick a preset or start blank — you can change anything after</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 4 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {TEMPLATES.map(tpl => (
              <button key={tpl.id} type="button" onClick={() => onPick(tpl)}
                style={{ padding: 18, borderRadius: 12, border: '1.5px solid #E5E7EB', background: '#FAFAFA', cursor: 'pointer', textAlign: 'left', transition: 'all 0.14s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = tpl.color; e.currentTarget.style.background = tpl.color + '0d'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 6px 18px ${tpl.color}28` }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#E5E7EB'; e.currentTarget.style.background = '#FAFAFA'; e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = '' }}>
                <div style={{ width: 38, height: 38, borderRadius: 9, background: tpl.color + '1a', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 20, color: tpl.color }}>{tpl.icon}</span>
                </div>
                <p style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a', margin: '0 0 5px' }}>{tpl.name}</p>
                <p style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.5, margin: 0 }}>{tpl.desc}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Preview Modal ──────────────────────────────────────────────────────────────
function PreviewModal({ html, subject, onClose }: { html: string; subject: string; onClose(): void }) {
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop')
  const [copied, setCopied] = useState(false)
  const ff = '-apple-system, BlinkMacSystemFont, sans-serif'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 3000, display: 'flex', flexDirection: 'column' }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', background: NAVY, flexShrink: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff', letterSpacing: -0.2 }}>Email Preview</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.1)', borderRadius: 7, padding: 3 }}>
            {(['desktop', 'mobile'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)} style={{ padding: '5px 14px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.15s', background: mode === m ? '#fff' : 'transparent', color: mode === m ? NAVY : 'rgba(255,255,255,0.6)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{m === 'desktop' ? 'desktop_windows' : 'smartphone'}</span>
                {m === 'desktop' ? 'Desktop (Gmail)' : 'Mobile (Gmail)'}
              </button>
            ))}
          </div>
          <button onClick={() => { navigator.clipboard.writeText(html); setCopied(true); setTimeout(() => setCopied(false), 2200) }}
            style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.08)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{copied ? 'check' : 'content_copy'}</span>
            {copied ? 'Copied!' : 'Copy HTML'}
          </button>
          <button onClick={onClose} style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.22)', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 12 }}>Close</button>
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, overflow: 'auto', background: '#b8bcc8', display: 'flex', alignItems: mode === 'mobile' ? 'center' : 'flex-start', justifyContent: 'center', padding: mode === 'mobile' ? '36px 20px' : '28px 28px' }}>

        {mode === 'desktop' ? (
          /* ── Gmail desktop ── */
          <div style={{ width: '100%', maxWidth: 1060, background: '#fff', borderRadius: 10, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}>
            {/* Browser chrome */}
            <div style={{ background: '#f1f3f4', padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', borderBottom: '1px solid #dadce0' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {['#ff5f57', '#febc2e', '#28c840'].map(c => <div key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />)}
              </div>
              <div style={{ flex: 1, background: '#fff', borderRadius: 20, padding: '5px 14px', fontSize: 12, color: '#5f6368', border: '1px solid #dadce0', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#aaa' }}>🔒</span> mail.google.com
              </div>
            </div>

            {/* Gmail layout */}
            <div style={{ display: 'flex', height: 680 }}>
              {/* Sidebar */}
              <div style={{ width: 200, background: '#fff', borderRight: '1px solid #f1f3f4', padding: '10px 0', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '4px 18px 14px', display: 'flex', gap: 1, fontSize: 18, fontWeight: 700, letterSpacing: -0.5 }}>
                  {[['G','#4285f4'],['m','#ea4335'],['a','#fbbc04'],['i','#4285f4'],['l','#34a853']].map(([ch,c]) => <span key={ch + c} style={{ color: c as string }}>{ch}</span>)}
                </div>
                {[['Inbox', true], ['Starred', false], ['Sent', false], ['Drafts', false]].map(([label, active]) => (
                  <div key={label as string} style={{ padding: '7px 16px', fontSize: 13.5, fontWeight: active ? 700 : 400, background: active ? '#d3e3fd' : 'transparent', borderRadius: active ? '0 20px 20px 0' : 0, color: active ? '#001d35' : '#444746', cursor: 'default', marginRight: active ? 8 : 0 }}>{label}</div>
                ))}
              </div>

              {/* Email open */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Roboto, Arial, sans-serif' }}>
                {/* Subject + meta */}
                <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #f1f3f4', flexShrink: 0 }}>
                  <div style={{ fontSize: 20, fontWeight: 500, color: '#202124', marginBottom: 12 }}>{subject || '(no subject)'}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: NAVY, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, flexShrink: 0 }}>O</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, color: '#202124' }}>
                        <strong>O3 Capital</strong>
                        <span style={{ color: '#5f6368', fontWeight: 400 }}> &lt;noreply@o3capital.ng&gt;</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: '#5f6368', marginTop: 2 }}>to me</div>
                    </div>
                    <div style={{ fontSize: 12.5, color: '#5f6368' }}>9:41 AM</div>
                  </div>
                </div>
                {/* Body */}
                <div style={{ flex: 1, overflow: 'auto' }}>
                  <iframe srcDoc={html} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title="Email preview" />
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ── Gmail on iPhone ── */
          <div style={{ position: 'relative', width: 295 }}>
            {/* Side buttons */}
            <div style={{ position: 'absolute', left: -3, top: 88, width: 3, height: 28, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
            <div style={{ position: 'absolute', left: -3, top: 126, width: 3, height: 54, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
            <div style={{ position: 'absolute', left: -3, top: 190, width: 3, height: 54, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
            <div style={{ position: 'absolute', right: -3, top: 148, width: 3, height: 72, background: '#3a3a3c', borderRadius: '0 2px 2px 0' }} />

            {/* Body */}
            <div style={{ background: 'linear-gradient(160deg, #2d2d2f 0%, #1c1c1e 100%)', borderRadius: 50, padding: 10, boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 0 0 2px #0a0a0a, 0 60px 120px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.1)' }}>
              {/* Screen */}
              <div style={{ borderRadius: 40, overflow: 'hidden', background: '#fff', height: 620, display: 'flex', flexDirection: 'column' }}>
                {/* Dynamic Island */}
                <div style={{ position: 'relative', height: 54, flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 13, left: '50%', transform: 'translateX(-50%)', width: 116, height: 33, background: '#000', borderRadius: 20, zIndex: 2 }} />
                  {/* Status bar */}
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', padding: '0 22px 8px', justifyContent: 'space-between', fontFamily: ff, zIndex: 1 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: -0.3 }}>9:41</span>
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      <svg width="17" height="12" viewBox="0 0 17 12"><rect x="0" y="8" width="3" height="4" rx="1" fill="#000"/><rect x="4.5" y="5.5" width="3" height="6.5" rx="1" fill="#000"/><rect x="9" y="2.5" width="3" height="9.5" rx="1" fill="#000"/><rect x="13.5" y="0" width="3" height="12" rx="1" fill="#000" opacity="0.25"/></svg>
                      <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill="#000"/><path d="M3.2 6.3C4.6 4.9 6.2 4.2 8 4.2s3.4.7 4.8 2.1" stroke="#000" strokeWidth="1.5" fill="none" strokeLinecap="round"/><path d="M.5 3.5C2.4 1.6 5 .5 8 .5s5.6 1.1 7.5 3" stroke="#000" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <div style={{ width: 23, height: 12, borderRadius: 3.5, border: '1px solid rgba(0,0,0,0.3)', padding: '1.5px' }}><div style={{ width: '82%', height: '100%', background: '#34C759', borderRadius: 2 }} /></div>
                        <div style={{ width: 2, height: 5, background: 'rgba(0,0,0,0.3)', borderRadius: '0 1.5px 1.5px 0', marginLeft: -1 }} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Gmail app */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, fontFamily: 'Roboto, Arial, sans-serif' }}>
                  {/* Header */}
                  <div style={{ padding: '6px 12px 8px', display: 'flex', alignItems: 'center', gap: 8, background: '#fff', borderBottom: '1px solid #f1f3f4', flexShrink: 0 }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#5f6368"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                    <div style={{ flex: 1, fontSize: 14, fontWeight: 500, color: '#202124', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject || '(no subject)'}</div>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="#5f6368"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
                  </div>
                  {/* Sender */}
                  <div style={{ padding: '8px 12px 6px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '0.5px solid #f1f3f4', flexShrink: 0 }}>
                    <div style={{ width: 34, height: 34, borderRadius: '50%', background: NAVY, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>O</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#202124' }}>O3 Capital</div>
                      <div style={{ fontSize: 11, color: '#5f6368' }}>to me · 9:41 AM</div>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#5f6368"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 3l5 5h-3v5h-4v-5H7l5-5z"/></svg>
                  </div>
                  {/* Body */}
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    <iframe srcDoc={html} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title="Email mobile preview" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main export ────────────────────────────────────────────────────────────────
interface EmailBlockEditorProps {
  value?: EditorValue
  onChange?: (v: EditorValue) => void
  previewSubject?: string
  suppressAutoTemplate?: boolean
}

export default function EmailBlockEditor({ value, onChange, previewSubject = '', suppressAutoTemplate = false }: EmailBlockEditorProps) {
  const [settings, setSettings]           = useState<EmailSettings>(value?.settings || { background: '#E8ECF2', contentWidth: 660 })
  const { value: blocks, push, undo, redo, canUndo, canRedo } = useHistory<EmailBlock[]>((value?.blocks || []).map(b => ({ ...b, id: b.id || uid() })))
  const [selectedId, setSelectedId]       = useState<string | null>(null)
  const [showTemplates, setShowTemplates]  = useState(!suppressAutoTemplate && !value?.blocks?.length)
  const [preview, setPreview]             = useState(false)
  const [previewHtml, setPreviewHtml]     = useState('')
  const [dragId, setDragId]               = useState<string | null>(null)
  const [dropState, setDropState]         = useState<{ id: string; above: boolean } | null>(null)

  const selected = blocks.find(b => b.id === selectedId) ?? null

  useEffect(() => { onChange?.({ blocks, settings }) }, [blocks, settings])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [undo, redo])

  const addBlock    = useCallback((type: string, afterId: string | null = null) => {
    const nb = DEF[type]?.(); if (!nb) return
    const next = [...blocks]; next.splice(afterId != null ? next.findIndex(b => b.id === afterId) + 1 : next.length, 0, nb)
    push(next); setSelectedId(nb.id)
  }, [blocks, push])

  const updateBlock = useCallback((id: string, p: Partial<EmailBlock>) => push(blocks.map(b => b.id === id ? { ...b, ...p } : b)), [blocks, push])
  const duplicate   = useCallback((id: string) => { const orig = blocks.find(b => b.id === id); if (!orig) return; const copy = { ...orig, id: uid() }; const next = [...blocks]; next.splice(blocks.findIndex(b => b.id === id) + 1, 0, copy); push(next); setSelectedId(copy.id) }, [blocks, push])
  const moveBlock   = useCallback((id: string, dir: number) => { const i = blocks.findIndex(b => b.id === id); if (i + dir < 0 || i + dir >= blocks.length) return; const next = [...blocks];[next[i], next[i + dir]] = [next[i + dir], next[i]]; push(next) }, [blocks, push])
  const delBlock    = useCallback((id: string) => { push(blocks.filter(b => b.id !== id)); if (selectedId === id) setSelectedId(null) }, [blocks, push, selectedId])

  const handleDrop  = useCallback((targetId?: string, above?: boolean) => {
    if (!dragId) return
    const moved = blocks.find(b => b.id === dragId); if (!moved) return
    const rest = blocks.filter(b => b.id !== dragId)
    if (!targetId) { push([...rest, moved]) }
    else { const ti = rest.findIndex(b => b.id === targetId); rest.splice(above ? ti : ti + 1, 0, moved); push(rest) }
    setDragId(null); setDropState(null)
  }, [dragId, blocks, push])

  const TB = ({ icon, label, onClick, disabled = false, active = false }: { icon: string; label: string; onClick(): void; disabled?: boolean; active?: boolean }) => (
    <button type="button" title={label} onClick={onClick} disabled={disabled}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 6, border: `1px solid ${active ? BLUE + '50' : '#E5E7EB'}`, background: active ? `${BLUE}10` : 'none', fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', color: disabled ? '#CBD5E1' : active ? BLUE : '#334155' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{icon}</span>{label}
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#fff', borderBottom: '1px solid #E5E7EB', flexShrink: 0, flexWrap: 'wrap' }}>
        <TB icon="grid_view" label="Templates" onClick={() => setShowTemplates(true)} />
        <div style={{ width: 1, height: 18, background: '#E5E7EB' }} />
        <TB icon="undo" label="Undo" onClick={undo} disabled={!canUndo} />
        <TB icon="redo" label="Redo" onClick={redo} disabled={!canRedo} />
        <div style={{ width: 1, height: 18, background: '#E5E7EB' }} />
        <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{blocks.length} block{blocks.length !== 1 ? 's' : ''}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b', cursor: 'pointer' }}>
            BG <input type="color" value={settings.background || '#E8ECF2'} onChange={e => setSettings(s => ({ ...s, background: e.target.value }))} style={{ width: 22, height: 22, border: '1px solid #E5E7EB', borderRadius: 4, cursor: 'pointer', padding: 1 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b' }}>
            Width <select value={settings.contentWidth || 660} onChange={e => setSettings(s => ({ ...s, contentWidth: Number(e.target.value) }))} style={{ fontSize: 11, border: '1px solid #E5E7EB', borderRadius: 4, padding: '2px 4px', background: '#fff', color: '#334155' }}>
              {[560, 600, 640, 660, 700, 720].map(w => <option key={w} value={w}>{w}px</option>)}
            </select>
          </label>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <TB icon="preview" label="Preview" onClick={() => { setPreviewHtml(exportToHtml(blocks, settings)); setPreview(true) }} active />
        </div>
      </div>

      {/* 3-panel */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {/* Left palette */}
        <div style={{ width: 76, flexShrink: 0, background: NAVY, overflowY: 'auto', padding: '10px 5px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {PALETTE.map(p => (
            <button key={p.type} type="button" title={`Add ${p.label}`} onClick={() => addBlock(p.type, selectedId)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: '100%', padding: '8px 4px', borderRadius: 7, border: 'none', background: 'rgba(255,255,255,0.04)', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', transition: 'all 0.12s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.13)'; e.currentTarget.style.color = '#fff' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.5)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{p.icon}</span>
              <span style={{ fontSize: 9, letterSpacing: '0.02em', textAlign: 'center', lineHeight: 1.2 }}>{p.label}</span>
            </button>
          ))}
        </div>

        {/* Canvas */}
        <div style={{ flex: 1, overflowY: 'auto', background: '#D5D9E2', padding: '24px 16px' }}
          onClick={() => setSelectedId(null)}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleDrop() }}
        >
          <div style={{ maxWidth: settings.contentWidth || 660, margin: '0 auto', background: '#fff', borderRadius: 10, overflow: 'hidden', boxShadow: '0 4px 24px rgba(0,0,0,.16)' }}>
            {blocks.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 52, color: '#E2E8F0', display: 'block', marginBottom: 16 }}>email</span>
                <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 20 }}>Your canvas is empty</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button type="button" onClick={() => setShowTemplates(true)} style={{ padding: '9px 20px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Choose Template</button>
                  <button type="button" onClick={() => addBlock('header', null)} style={{ padding: '9px 20px', borderRadius: 7, border: '1px solid #E5E7EB', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13 }}>Start from scratch</button>
                </div>
              </div>
            ) : (
              <>
                {blocks.map((block, i) => (
                  <div key={block.id}>
                    <CanvasBlock
                      block={block} idx={i} total={blocks.length}
                      selected={selectedId === block.id}
                      isDragging={dragId === block.id}
                      dropAbove={dropState?.id === block.id ? dropState.above : null}
                      onSelect={() => setSelectedId(block.id)}
                      onUpdate={p => updateBlock(block.id, p)}
                      onMove={d => moveBlock(block.id, d)}
                      onDelete={() => delBlock(block.id)}
                      onDuplicate={() => duplicate(block.id)}
                      onDragStart={() => { setDragId(block.id); setSelectedId(null) }}
                      onDragEnd={() => { setDragId(null); setDropState(null) }}
                      onDragOver={e => { const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); setDropState({ id: block.id, above: e.clientY < rect.top + rect.height / 2 }) }}
                      onDrop={() => handleDrop(block.id, dropState?.above ?? true)}
                    />
                    <div style={{ height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={e => { const b = e.currentTarget.querySelector('button') as HTMLButtonElement|null; if (b) b.style.opacity = '1' }}
                      onMouseLeave={e => { const b = e.currentTarget.querySelector('button') as HTMLButtonElement|null; if (b) b.style.opacity = '0' }}>
                      <button type="button" onClick={e => { e.stopPropagation(); addBlock('text', block.id) }}
                        style={{ fontSize: 10.5, padding: '0 14px', height: 18, lineHeight: '18px', borderRadius: 999, background: BLUE, color: '#fff', border: 'none', cursor: 'pointer', opacity: 0, transition: 'opacity 0.15s', fontWeight: 600 }}>
                        + insert block
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div style={{ width: 232, flexShrink: 0, borderLeft: '1px solid #E5E7EB', background: '#fff', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '9px 14px', borderBottom: '1px solid #F1F5F9', background: '#FAFAFA', flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.09em', color: '#94a3b8' }}>
              {selected ? selected.type.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Properties'}
            </span>
          </div>
          <div style={{ padding: 14, flex: 1 }}>
            <PropsPanel block={selected} onUpdate={p => selected && updateBlock(selected.id, p)} />
          </div>
        </div>
      </div>

      {showTemplates && <TemplateGallery onPick={t => { push(t.blocks.map(b => ({ ...b, id: uid() }))); setSelectedId(null); setShowTemplates(false) }} onClose={() => setShowTemplates(false)} />}
      {preview && <PreviewModal html={previewHtml} subject={previewSubject} onClose={() => setPreview(false)} />}
    </div>
  )
}
