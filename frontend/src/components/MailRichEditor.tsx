import { useEffect, useRef } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import { TEXT, FW } from '../lib/design'

// A lightweight Gmail-style WYSIWYG built on the Tiptap stack already vendored in
// this app. Emits sanitised-ready HTML via onChange. Reused by mail compose and
// the signature editor. The `value` prop is only pushed into the editor when it
// changes from OUTSIDE (draft load, reply prefill, async signature) — normal
// typing never triggers a reset, so the cursor is stable.

interface Props {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: number
  compact?: boolean
}

const EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [2, 3] } }),
  Underline,
  Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
]

export default function MailRichEditor({ value, onChange, placeholder = 'Write your message…', minHeight = 220, compact = false }: Props) {
  const lastEmitted = useRef<string>(value)

  const editor = useEditor({
    extensions: [...EXTENSIONS, Placeholder.configure({ placeholder })],
    content: value || '',
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      lastEmitted.current = html
      onChange(html)
    },
    editorProps: {
      attributes: { class: 'mail-rte-content', spellcheck: 'true' },
    },
  })

  // Push external value changes into the editor (not on every keystroke).
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
      <div style={{ maxHeight: 460, overflowY: 'auto' }}>
        <EditorContent editor={editor} />
      </div>
      <style>{`
        .mail-rte-content {
          min-height: ${minHeight}px;
          padding: 12px 14px;
          outline: none;
          font-size: ${compact ? 13 : 13.5}px;
          line-height: 1.7;
          color: var(--txt);
          font-family: var(--font-sans);
        }
        .mail-rte-content p { margin: 0 0 10px; }
        .mail-rte-content p:last-child { margin-bottom: 0; }
        .mail-rte-content ul, .mail-rte-content ol { margin: 0 0 10px; padding-left: 22px; }
        .mail-rte-content h2 { font-size: 1.3em; font-weight: 700; margin: 4px 0 8px; }
        .mail-rte-content h3 { font-size: 1.12em; font-weight: 700; margin: 4px 0 8px; }
        .mail-rte-content a { color: #2563EB; text-decoration: underline; }
        .mail-rte-content blockquote { border-left: 3px solid var(--bdr); margin: 0 0 10px; padding-left: 12px; color: var(--txt2); }
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

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
      padding: compact ? '5px 6px' : '7px 8px', borderBottom: '1px solid var(--bdr)', background: 'var(--bg)',
    }}>
      <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} icon="format_bold" title="Bold" />
      <Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} icon="format_italic" title="Italic" />
      <Btn active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} icon="format_underlined" title="Underline" />
      <Btn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} icon="strikethrough_s" title="Strikethrough" />
      <Sep />
      <Btn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} icon="format_list_bulleted" title="Bulleted list" />
      <Btn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} icon="format_list_numbered" title="Numbered list" />
      <Btn active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} icon="format_quote" title="Quote" />
      <Sep />
      <Btn active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} icon="format_align_left" title="Align left" />
      <Btn active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} icon="format_align_center" title="Align center" />
      <Btn active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} icon="format_align_right" title="Align right" />
      <Sep />
      <Btn active={editor.isActive('link')} onClick={setLink} icon="link" title="Insert link" />
      <Btn active={false} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} icon="format_clear" title="Clear formatting" />
    </div>
  )
}

function Btn({ active, onClick, icon, title }: { active: boolean; onClick: () => void; icon: string; title: string }) {
  return (
    <button
      type="button" title={title} onMouseDown={e => e.preventDefault()} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
        border: 'none', background: active ? 'var(--chip-bg)' : 'transparent',
        color: active ? 'var(--txt)' : 'var(--txt2)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 18, fontWeight: FW.medium as any, fontVariationSettings: "'wght' 500" }}>{icon}</span>
    </button>
  )
}

function Sep() {
  return <span style={{ width: 1, height: 18, background: 'var(--bdr)', margin: '0 4px' }} />
}

// Exported so pages can render the SAME formatted output read-only (e.g. preview).
export const RTE_TEXT = TEXT
