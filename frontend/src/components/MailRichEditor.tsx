import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
// Aliased: Tiptap's Node would otherwise shadow the DOM Node type, which this file
// needs for the click-outside handlers on the colour and image popovers.
import { Extension, Node as TiptapNode, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import {
  TextStyle, Color, BackgroundColor, FontFamily, FontSize, LineHeight,
} from '@tiptap/extension-text-style'
import { TEXT, FW } from '../lib/design'

// A Word/Gmail-class WYSIWYG on the Tiptap stack already vendored here. Emits HTML
// that is safe to sanitise and send. Shared by mail compose and the signature editor.
//
// Everything it produces is an INLINE style — colours and fonts as <span style>,
// alignment and spacing as block style attributes. That is deliberate: mail clients
// strip <style> blocks and classes, so anything expressed as CSS-by-class would look
// correct in the composer and arrive unformatted.
//
// `value` is pushed into the editor only when it changes from OUTSIDE (draft load,
// reply prefill, async signature). Normal typing never triggers a reset, so the
// cursor stays put.
//
// Note StarterKit v3 already bundles Link, Underline, HorizontalRule and undo/redo —
// registering those separately (as this file used to) double-registers the extension.

interface Props {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: number
  compact?: boolean
}

// ── Indent ────────────────────────────────────────────────────────────────────
// Word has it and people expect it, but Tiptap only ships list indentation. This
// carries a margin-left on the block itself, which survives the trip into a mail
// client where a class-based indent would not.

const INDENT_STEP = 32
const MAX_INDENT = 8

const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        indent: {
          default: 0,
          parseHTML: el => {
            const px = parseInt(el.style.marginLeft || '0', 10)
            return Number.isFinite(px) ? Math.round(px / INDENT_STEP) : 0
          },
          renderHTML: attrs =>
            attrs.indent ? { style: `margin-left:${attrs.indent * INDENT_STEP}px` } : {},
        },
      },
    }]
  },
  addCommands() {
    const shift = (dir: 1 | -1) => () => ({ state, chain }: any) => {
      const { from, to } = state.selection
      let ok = false
      state.doc.nodesBetween(from, to, (node: any, pos: number) => {
        if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return
        const next = Math.min(MAX_INDENT, Math.max(0, (node.attrs.indent || 0) + dir))
        if (next !== node.attrs.indent) {
          chain().command(({ tr }: any) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
            return true
          }).run()
          ok = true
        }
      })
      return ok
    }
    return { indent: shift(1), outdent: shift(-1) } as any
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => (this.editor.isActive('listItem') ? false : (this.editor.commands as any).indent()),
      'Shift-Tab': () => (this.editor.isActive('listItem') ? false : (this.editor.commands as any).outdent()),
    }
  },
})

// ── Image ─────────────────────────────────────────────────────────────────────
// Hand-rolled rather than pulled from @tiptap/extension-image so the emitted markup
// is exactly what a mail client needs: a plain <img> carrying width as BOTH the
// attribute and an inline style (Outlook honours the attribute, most others the
// style), and max-width:100% so a large image cannot blow out a narrow reading pane.
//
// Animated GIFs work — nothing here re-encodes the file, so the animation survives.

const MailImage = TiptapNode.create({
  name: 'image',
  group: 'block',
  draggable: true,
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      // Percentage of the available width. null = natural size.
      widthPct: {
        default: null,
        parseHTML: el => {
          const w = (el as HTMLElement).style.width
          return w && w.endsWith('%') ? parseInt(w, 10) : null
        },
        renderHTML: () => ({}),
      },
    }
  },
  parseHTML() { return [{ tag: 'img[src]' }] },
  renderHTML({ HTMLAttributes }) {
    const { widthPct, ...rest } = HTMLAttributes
    const style = widthPct
      ? `width:${widthPct}%;max-width:100%;height:auto;`
      : 'max-width:100%;height:auto;'
    return ['img', mergeAttributes(rest, { style })]
  },
  addCommands() {
    return {
      setImage: (attrs: any) => ({ commands }: any) =>
        commands.insertContent({ type: this.name, attrs }),
    } as any
  },
})

// Inline images travel inside every copy of the message. A logo is fine; a 4 MB
// photo pasted into a signature would be attached to every mail that person ever
// sends, so it is refused with an explanation rather than silently accepted.
const MAX_INLINE_IMAGE_BYTES = 200 * 1024

// ── Option lists ──────────────────────────────────────────────────────────────
// Web-safe stacks only. A font the recipient's mail client cannot resolve falls back
// to something arbitrary, so offering the whole system font list would be a trap.

const FONTS = [
  { label: 'Default',    value: '' },
  { label: 'Sans Serif', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Serif',      value: 'Georgia, "Times New Roman", serif' },
  { label: 'Fixed Width',value: '"Courier New", Courier, monospace' },
  { label: 'Wide',       value: 'Verdana, Geneva, sans-serif' },
  { label: 'Narrow',     value: '"Arial Narrow", Arial, sans-serif' },
  { label: 'Garamond',   value: 'Garamond, Baskerville, serif' },
  { label: 'Tahoma',     value: 'Tahoma, Verdana, sans-serif' },
  { label: 'Trebuchet',  value: '"Trebuchet MS", Helvetica, sans-serif' },
]

const SIZES = ['10px', '12px', '13px', '14px', '16px', '18px', '24px', '32px', '48px']
const SPACING = [
  { label: 'Single', value: '1.2' },
  { label: '1.15',   value: '1.15' },
  { label: '1.5',    value: '1.5' },
  { label: 'Double', value: '2' },
]

// Two rows: greys, then hues light→dark. Same grid for text and highlight so the
// two pickers behave identically.
const SWATCHES = [
  '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#EFEFEF', '#FFFFFF',
  '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#9900FF',
  '#E6B8AF', '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#C9DAF8', '#D9D2E9',
  '#CC0000', '#E69138', '#F1C232', '#6AA84F', '#45818E', '#3C78D8', '#674EA7', '#A64D79',
]

export default function MailRichEditor({
  value, onChange, placeholder = 'Write your message…', minHeight = 220, compact = false,
}: Props) {
  const lastEmitted = useRef<string>(value)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      BackgroundColor,
      FontFamily,
      FontSize,
      // Spacing is a property of the block, not of a run of characters — matching
      // Word, and the only form that renders predictably in a mail client.
      LineHeight.configure({ types: ['paragraph', 'heading'] }),
      Indent,
      MailImage,
    ],
    content: value || '',
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      lastEmitted.current = html
      onChange(html)
    },
    editorProps: { attributes: { class: 'mail-rte-content', spellcheck: 'true' } },
  })

  useEffect(() => {
    if (!editor) return
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      editor.commands.setContent(value || '', { emitUpdate: false })
    }
  }, [value, editor])

  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden', background: 'var(--card)' }}>
      <Toolbar editor={editor} compact={compact} />
      <div style={{ maxHeight: 520, overflowY: 'auto' }}>
        <EditorContent editor={editor} />
      </div>
      <style>{`
        .mail-rte-content {
          min-height: ${minHeight}px;
          padding: 16px 18px;
          outline: none;
          font-size: ${compact ? 13 : 13.5}px;
          line-height: 1.7;
          color: var(--txt);
          font-family: var(--font-sans);
        }
        .mail-rte-content p { margin: 0 0 10px; }
        .mail-rte-content p:last-child { margin-bottom: 0; }
        .mail-rte-content ul, .mail-rte-content ol { margin: 0 0 10px; padding-left: 24px; }
        .mail-rte-content li { margin: 2px 0; }
        .mail-rte-content h1 { font-size: 1.6em; font-weight: 700; margin: 6px 0 10px; }
        .mail-rte-content h2 { font-size: 1.3em; font-weight: 700; margin: 6px 0 8px; }
        .mail-rte-content h3 { font-size: 1.12em; font-weight: 700; margin: 6px 0 8px; }
        .mail-rte-content a { color: #2563EB; text-decoration: underline; }
        .mail-rte-content hr { border: none; border-top: 1px solid var(--bdr); margin: 14px 0; }
        .mail-rte-content blockquote {
          border-left: 3px solid var(--bdr); margin: 0 0 10px;
          padding-left: 12px; color: var(--txt2);
        }
        .mail-rte-content code {
          background: var(--chip-bg); padding: 1px 4px;
          border-radius: 4px; font-size: .92em;
        }
        .mail-rte-content p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left; height: 0; pointer-events: none;
          color: var(--txt3);
        }
      `}</style>
    </div>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function Toolbar({ editor, compact }: { editor: Editor | null; compact: boolean }) {
  if (!editor) return null

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL', prev ?? 'https://')
    if (url === null) return
    if (url === '') { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  const blockValue =
    editor.isActive('heading', { level: 1 }) ? 'h1'
    : editor.isActive('heading', { level: 2 }) ? 'h2'
    : editor.isActive('heading', { level: 3 }) ? 'h3'
    : 'p'

  const setBlock = (v: string) => {
    const c = editor.chain().focus()
    if (v === 'p') c.setParagraph().run()
    else c.setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
    padding: compact ? '4px 6px' : '6px 8px',
  }

  return (
    <div style={{ borderBottom: '1px solid var(--bdr)', background: 'var(--bg)' }}>
      {/* Row 1 — history, block style, typography, colour */}
      <div style={rowStyle}>
        <Btn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} icon="undo" title="Undo (Ctrl+Z)" />
        <Btn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} icon="redo" title="Redo (Ctrl+Y)" />
        <Sep />

        <Picker value={blockValue} onChange={setBlock} width={92} title="Paragraph style"
          options={[
            { label: 'Normal', value: 'p' },
            { label: 'Heading 1', value: 'h1' },
            { label: 'Heading 2', value: 'h2' },
            { label: 'Heading 3', value: 'h3' },
          ]} />

        <Picker
          value={(editor.getAttributes('textStyle').fontFamily as string) ?? ''}
          onChange={v => v
            ? editor.chain().focus().setFontFamily(v).run()
            : editor.chain().focus().unsetFontFamily().run()}
          width={104} title="Font" options={FONTS} />

        <Picker
          value={(editor.getAttributes('textStyle').fontSize as string) ?? ''}
          onChange={v => v
            ? editor.chain().focus().setFontSize(v).run()
            : editor.chain().focus().unsetFontSize().run()}
          width={68} title="Font size"
          options={[{ label: 'Size', value: '' }, ...SIZES.map(s => ({ label: s.replace('px', ''), value: s }))]} />

        <Sep />
        <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon="format_bold" title="Bold (Ctrl+B)" />
        <Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon="format_italic" title="Italic (Ctrl+I)" />
        <Btn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} icon="format_underlined" title="Underline (Ctrl+U)" />
        <Btn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} icon="strikethrough_s" title="Strikethrough" />

        <Sep />
        <ColorPicker
          icon="format_color_text" title="Text colour"
          current={(editor.getAttributes('textStyle').color as string) ?? '#000000'}
          onPick={c => editor.chain().focus().setColor(c).run()}
          onClear={() => editor.chain().focus().unsetColor().run()} />
        <ColorPicker
          icon="format_color_fill" title="Highlight"
          current={(editor.getAttributes('textStyle').backgroundColor as string) ?? '#FFFF00'}
          onPick={c => editor.chain().focus().setBackgroundColor(c).run()}
          onClear={() => editor.chain().focus().unsetBackgroundColor().run()} />
      </div>

      {/* Row 2 — alignment, lists, indentation, spacing, insert */}
      <div style={{ ...rowStyle, borderTop: '1px solid var(--bdr)' }}>
        <Btn active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} icon="format_align_left" title="Align left" />
        <Btn active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} icon="format_align_center" title="Align centre" />
        <Btn active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} icon="format_align_right" title="Align right" />
        <Btn active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()} icon="format_align_justify" title="Justify" />

        <Sep />
        <Btn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} icon="format_list_bulleted" title="Bulleted list" />
        <Btn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} icon="format_list_numbered" title="Numbered list" />

        <Sep />
        <Btn onClick={() => (editor.chain().focus() as any).outdent().run()} icon="format_indent_decrease" title="Decrease indent (Shift+Tab)" />
        <Btn onClick={() => (editor.chain().focus() as any).indent().run()} icon="format_indent_increase" title="Increase indent (Tab)" />

        <Sep />
        <Picker
          value={(editor.getAttributes('paragraph').lineHeight as string) ?? ''}
          onChange={v => v
            ? editor.chain().focus().setLineHeight(v).run()
            : editor.chain().focus().unsetLineHeight().run()}
          width={86} title="Line spacing"
          options={[{ label: 'Spacing', value: '' }, ...SPACING]} />

        <Sep />
        <Btn active={editor.isActive('link')} onClick={setLink} icon="link" title="Insert link" />
        <ImageButton editor={editor} />
        <Btn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} icon="format_quote" title="Quote" />
        <Btn onClick={() => editor.chain().focus().setHorizontalRule().run()} icon="horizontal_rule" title="Divider" />
        <Btn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} icon="code" title="Inline code" />

        <Sep />
        <Btn onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} icon="format_clear" title="Clear formatting" />
      </div>

      {/* Image sizing appears only while an image is selected — the same place Word
          and Gmail put it, and it keeps the resting toolbar from growing a third row. */}
      {editor.isActive('image') && (
        <div style={{ ...rowStyle, borderTop: '1px solid var(--bdr)', gap: 6 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.semibold, marginRight: 2 }}>Image width</span>
          {[25, 50, 75, 100].map(p => (
            <WidthBtn key={p} label={`${p}%`}
              active={editor.getAttributes('image').widthPct === p}
              onClick={() => editor.chain().focus().updateAttributes('image', { widthPct: p }).run()} />
          ))}
          <WidthBtn label="Original"
            active={!editor.getAttributes('image').widthPct}
            onClick={() => editor.chain().focus().updateAttributes('image', { widthPct: null }).run()} />
          <Sep />
          <Btn onClick={() => {
            const cur = (editor.getAttributes('image').alt as string) ?? ''
            const alt = window.prompt('Alt text — shown when images are blocked', cur)
            if (alt !== null) editor.chain().focus().updateAttributes('image', { alt }).run()
          }} icon="edit_note" title="Alt text" />
          <Btn onClick={() => editor.chain().focus().deleteSelection().run()} icon="delete" title="Remove image" />
        </div>
      )}
    </div>
  )
}

// ── Toolbar pieces ────────────────────────────────────────────────────────────

function Btn({ active = false, onClick, icon, title, disabled = false }: {
  active?: boolean; onClick: () => void; icon: string; title: string; disabled?: boolean
}) {
  return (
    <button
      type="button" title={title} disabled={disabled}
      // Keep the selection alive: focus must not leave the document when the button
      // is pressed, or the command has nothing to apply itself to.
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        border: 'none', background: active ? 'var(--chip-bg)' : 'transparent',
        color: disabled ? 'var(--txt3)' : active ? 'var(--txt)' : 'var(--txt2)',
        opacity: disabled ? 0.45 : 1,
      }}
      onMouseEnter={e => { if (!active && !disabled) e.currentTarget.style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { if (!active && !disabled) e.currentTarget.style.background = 'transparent' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 18, fontWeight: FW.medium as any, fontVariationSettings: "'wght' 500" }}>{icon}</span>
    </button>
  )
}

function Sep() {
  return <span style={{ width: 1, height: 18, background: 'var(--bdr)', margin: '0 4px' }} />
}

function WidthBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onMouseDown={e => e.preventDefault()} onClick={onClick}
      style={{
        height: 24, padding: '0 8px', borderRadius: 5, cursor: 'pointer',
        border: '1px solid var(--bdr)',
        background: active ? 'var(--chip-bg)' : 'var(--card)',
        color: active ? 'var(--txt)' : 'var(--txt2)',
        fontSize: TEXT.xs, fontWeight: FW.semibold,
      }}>
      {label}
    </button>
  )
}

// Insert an image either from disk or from a URL.
//
// A file becomes a data: URI. That is not the usual choice, but it is the only one
// that works here: object storage is not configured, and the local upload fallback
// returns a path that no route serves and that a recipient's mail client could not
// authenticate against anyway. A data URI renders everywhere without infrastructure.
// Once R2_* is configured, uploading and referencing a hosted URL becomes the better
// default and this is where that would change.
function ImageButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) { setOpen(false); setNote(null) }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  function pickFile(f: File | null | undefined) {
    if (!f) return
    if (!f.type.startsWith('image/')) { setNote('That is not an image file.'); return }
    if (f.size > MAX_INLINE_IMAGE_BYTES) {
      setNote(`That image is ${Math.round(f.size / 1024)} KB. Inline images are capped at ${MAX_INLINE_IMAGE_BYTES / 1024} KB because a copy travels with every message — resize it, or host it and use “By URL”.`)
      return
    }
    setBusy(true)
    const reader = new FileReader()
    reader.onload = () => {
      (editor.chain().focus() as any).setImage({ src: String(reader.result), alt: f.name }).run()
      setBusy(false); setOpen(false); setNote(null)
    }
    reader.onerror = () => { setNote('Could not read that file.'); setBusy(false) }
    reader.readAsDataURL(f)
  }

  function byUrl() {
    const url = window.prompt('Image URL (must be publicly reachable, or recipients will see a broken image)', 'https://')
    if (!url || url === 'https://') return
    (editor.chain().focus() as any).setImage({ src: url, alt: '' }).run()
    setOpen(false)
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <Btn active={open} onClick={() => setOpen(o => !o)} icon="image" title="Insert image" />
      <input
        ref={fileRef} type="file" accept="image/*" hidden
        onChange={e => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
      {open && (
        <div style={{
          position: 'absolute', top: 32, left: 0, zIndex: 60,
          background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,.16)', padding: 8, width: 236,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <MenuRow icon="upload" label={busy ? 'Reading…' : 'Upload from computer'} onClick={() => fileRef.current?.click()} />
          <MenuRow icon="link" label="By URL" onClick={byUrl} />
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5, paddingTop: 2 }}>
            {note ?? `PNG, JPG, GIF or SVG up to ${MAX_INLINE_IMAGE_BYTES / 1024} KB. Animated GIFs keep their animation.`}
          </div>
        </div>
      )}
    </div>
  )
}

function MenuRow({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button" onMouseDown={e => e.preventDefault()} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
        border: 'none', background: 'transparent', color: 'var(--txt)',
        fontSize: TEXT.sm, fontWeight: FW.semibold, textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 17, color: 'var(--txt2)' }}>{icon}</span>
      {label}
    </button>
  )
}

function Picker({ value, onChange, options, width, title }: {
  value: string
  onChange: (v: string) => void
  options: { label: string; value: string }[]
  width: number
  title: string
}) {
  return (
    <select
      title={title}
      value={value}
      onMouseDown={e => e.stopPropagation()}
      onChange={e => onChange(e.target.value)}
      style={{
        width, height: 28, borderRadius: 6, border: '1px solid var(--bdr)',
        background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.xs,
        padding: '0 4px', cursor: 'pointer', outline: 'none',
      }}>
      {options.map(o => <option key={o.value || o.label} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function ColorPicker({ icon, title, current, onPick, onClear }: {
  icon: string; title: string; current: string
  onPick: (c: string) => void; onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button
        type="button" title={title}
        onMouseDown={e => e.preventDefault()}
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
          border: 'none', background: open ? 'var(--chip-bg)' : 'transparent', color: 'var(--txt2)', gap: 1,
        }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, lineHeight: 1, fontVariationSettings: "'wght' 500" }}>{icon}</span>
        <span style={{ width: 15, height: 3, borderRadius: 1, background: current, border: '1px solid var(--bdr)' }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 32, left: 0, zIndex: 60,
          background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,.16)', padding: 8, width: 208,
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8,1fr)', gap: 4 }}>
            {SWATCHES.map(c => (
              <button
                key={c} type="button" title={c}
                onMouseDown={e => e.preventDefault()}
                onClick={() => { onPick(c); setOpen(false) }}
                style={{
                  width: 20, height: 20, borderRadius: 4, cursor: 'pointer',
                  background: c, border: '1px solid rgba(0,0,0,.18)',
                }} />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--bdr)' }}>
            <input
              type="color" value={/^#[0-9a-f]{6}$/i.test(current) ? current : '#000000'}
              onChange={e => onPick(e.target.value)}
              title="Custom colour"
              style={{ width: 26, height: 24, padding: 0, border: '1px solid var(--bdr)', borderRadius: 4, background: 'none', cursor: 'pointer' }} />
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onClear(); setOpen(false) }}
              style={{
                flex: 1, height: 24, borderRadius: 4, cursor: 'pointer',
                border: '1px solid var(--bdr)', background: 'var(--card)',
                color: 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold,
              }}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Exported so pages can render the SAME formatted output read-only (e.g. preview).
export const RTE_TEXT = TEXT
