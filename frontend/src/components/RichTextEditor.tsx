import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import Color from '@tiptap/extension-color'
import { TextStyle } from '@tiptap/extension-text-style'
import { useEffect } from 'react'

interface RichTextEditorProps {
  content: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: number
  className?: string
}

function ToolbarBtn({
  onClick, active, title, children,
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={e => { e.preventDefault(); onClick() }}
      className={`flex items-center justify-center w-7 h-7 rounded-md text-[13px] transition-colors ${
        active
          ? 'bg-slate-200 text-slate-900'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="w-px h-5 bg-slate-200 mx-0.5 flex-shrink-0" />
}

export default function RichTextEditor({
  content,
  onChange,
  placeholder = 'Write your message…',
  minHeight = 240,
  className = '',
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        code: false,
        horizontalRule: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', style: 'color:#0E2841;text-decoration:underline' },
      }),
      Placeholder.configure({ placeholder }),
      TextAlign.configure({ types: ['paragraph'] }),
      TextStyle,
      Color,
    ],
    content,
    onUpdate: ({ editor }: { editor: { getHTML(): string } }) => {
      onChange(editor.getHTML())
    },
    editorProps: {
      attributes: {
        style: `min-height:${minHeight}px;outline:none;font-size:14px;line-height:1.75;color:#1e293b;font-family:inherit;`,
      },
    },
  })

  // Sync external content changes (e.g. when loading a draft)
  useEffect(() => {
    if (!editor) return
    if (editor.getHTML() !== content) {
      editor.commands.setContent(content, { emitUpdate: false })
    }
  }, [content]) // eslint-disable-line react-hooks/exhaustive-deps

  function addLink() {
    const url = window.prompt('Enter URL', 'https://')
    if (!url) return
    if (editor?.state.selection.empty) {
      editor?.chain().focus().insertContent(`<a href="${url}">${url}</a>`).run()
    } else {
      editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    }
  }

  function removeLink() {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run()
  }

  if (!editor) return null

  const isLink = editor.isActive('link')

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Toolbar */}
      <div
        className="flex items-center flex-wrap gap-0.5 px-3 py-2 border-b"
        style={{ borderColor: 'rgba(15,23,42,0.08)', background: '#FAFAFA' }}
      >
        {/* Text formatting */}
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive('bold')}
          title="Bold (Ctrl+B)"
        >
          <span className="material-symbols-rounded text-[15px]">format_bold</span>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive('italic')}
          title="Italic (Ctrl+I)"
        >
          <span className="material-symbols-rounded text-[15px]">format_italic</span>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive('underline')}
          title="Underline (Ctrl+U)"
        >
          <span className="material-symbols-rounded text-[15px]">format_underlined</span>
        </ToolbarBtn>

        <Divider />

        {/* Link */}
        <ToolbarBtn
          onClick={isLink ? removeLink : addLink}
          active={isLink}
          title={isLink ? 'Remove link' : 'Add link'}
        >
          <span className="material-symbols-rounded text-[15px]">{isLink ? 'link_off' : 'link'}</span>
        </ToolbarBtn>

        <Divider />

        {/* Lists */}
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive('orderedList')}
          title="Ordered list"
        >
          <span className="material-symbols-rounded text-[15px]">format_list_numbered</span>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive('bulletList')}
          title="Bullet list"
        >
          <span className="material-symbols-rounded text-[15px]">format_list_bulleted</span>
        </ToolbarBtn>

        <Divider />

        {/* Alignment */}
        <ToolbarBtn
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          active={editor.isActive({ textAlign: 'left' })}
          title="Align left"
        >
          <span className="material-symbols-rounded text-[15px]">format_align_left</span>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          active={editor.isActive({ textAlign: 'center' })}
          title="Align center"
        >
          <span className="material-symbols-rounded text-[15px]">format_align_center</span>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          active={editor.isActive({ textAlign: 'right' })}
          title="Align right"
        >
          <span className="material-symbols-rounded text-[15px]">format_align_right</span>
        </ToolbarBtn>

        <Divider />

        {/* Clear formatting */}
        <ToolbarBtn
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
          title="Clear formatting"
        >
          <span className="material-symbols-rounded text-[15px]">format_clear</span>
        </ToolbarBtn>
      </div>

      {/* Editor area */}
      <EditorContent
        editor={editor}
        className="flex-1 px-5 py-4 [&_.ProseMirror]:outline-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-slate-300 [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_li]:my-0.5"
      />
    </div>
  )
}
