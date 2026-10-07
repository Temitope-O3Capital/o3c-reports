// Tests for the email builder's editing and save path.
//
// These exist because of two reported symptoms: text typed into a block
// disappeared, and the formatting options were limited. Neither was a toolbar
// problem. The text loss came from the editable div never being focused (it only
// becomes contentEditable on the render AFTER the selecting click, so the click
// could not place a caret, and content was saved only on a blur that therefore
// never fired). The second symptom had a second half: the page-level settings the
// toolbar sets were silently dropped on save.
//
// The tests pin the contract between EmailBlockEditor and its two parents:
//
//   Report.tsx     value={editorValue}  onChange={setEditorValue}          (whole envelope)
//   TemplateEditor value={memoised}     onChange={v => set(blocks+settings)}
//
// A parent that rebuilds `value` every render used to drive the two sync effects
// into an endless ping-pong that froze the tab. The last describe block covers it.

import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import EmailBlockEditor, {
  exportToHtml, parseBlocks, parseEditorValue, type EmailBlock, type EmailSettings,
} from './EmailBlockEditor'

interface EditorValue { blocks: EmailBlock[]; settings?: EmailSettings }

const textBlock = (html: string): EmailBlock => ({ id: 'b1', type: 'text', html })

// Report.tsx's parent: holds the whole envelope, echoes it back by identity.
function EnvelopeParent({ initial, onValue }: { initial: EditorValue; onValue?: (v: EditorValue) => void }) {
  const [v, setV] = useState<EditorValue>(initial)
  return <EmailBlockEditor value={v} onChange={nv => { setV(nv); onValue?.(nv) }} suppressAutoTemplate />
}

// A parent that rebuilds `value` as a fresh object on every render, and keeps only
// blocks — the shape TemplateEditor used to have. Kept here deliberately: it is the
// hostile case, and the editor must survive it.
function FreshObjectParent({ initial, onBlocks }: {
  initial: EmailBlock[]; onBlocks?: (b: EmailBlock[]) => void
}) {
  const [blocks, setBlocks] = useState<EmailBlock[]>(initial)
  const [, setTick] = useState(0)
  return (
    <>
      <button data-testid="unrelated" onClick={() => setTick(t => t + 1)}>rerender</button>
      <EmailBlockEditor
        value={{ blocks }}
        onChange={v => { setBlocks(v.blocks); onBlocks?.(v.blocks) }}
        suppressAutoTemplate
      />
    </>
  )
}

const editable = () => document.querySelector('[contenteditable]') as HTMLElement | null

describe('selecting a text block makes it genuinely editable', () => {
  it('focuses the block and puts a caret in it, so typing is not dropped', async () => {
    await act(async () => {
      render(<EnvelopeParent initial={{ blocks: [textBlock('<p>Original</p>')] }} />)
    })
    const el = editable()
    expect(el).toBeTruthy()
    expect(el!.getAttribute('contenteditable')).toBe('false')

    await act(async () => { fireEvent.click(el!) })

    const sel = editable()!
    expect(sel.getAttribute('contenteditable')).toBe('true')
    // The regression: contentEditable turned on but nothing was focused, so the
    // caret was nowhere and every keystroke went to the document.
    expect(document.activeElement).toBe(sel)
  })

  it('text typed into the block is committed on blur', async () => {
    const seen: EditorValue[] = []
    await act(async () => {
      render(<EnvelopeParent initial={{ blocks: [textBlock('<p>Original</p>')] }} onValue={v => seen.push(v)} />)
    })
    await act(async () => { fireEvent.click(editable()!) })

    const el = editable()!
    el.innerHTML = '<p>Typed by the user</p>'
    await act(async () => {
      fireEvent.input(el)
      fireEvent.blur(el)
    })

    const last = seen[seen.length - 1]
    expect(last.blocks[0].html).toContain('Typed by the user')
  })

  it('typing is committed on a debounce, with no blur at all', async () => {
    const seen: EditorValue[] = []
    await act(async () => {
      render(<EnvelopeParent initial={{ blocks: [textBlock('<p>Original</p>')] }} onValue={v => seen.push(v)} />)
    })
    await act(async () => { fireEvent.click(editable()!) })

    const el = editable()!
    el.innerHTML = '<p>Never blurred</p>'
    // Only an input event — the field keeps focus throughout.
    await act(async () => { fireEvent.input(el) })
    await act(async () => { await new Promise(r => setTimeout(r, 550)) })

    expect(seen[seen.length - 1].blocks[0].html).toContain('Never blurred')
  })

  it('a burst of typing collapses into one document revision, not one per keystroke', async () => {
    const seen: EditorValue[] = []
    await act(async () => {
      render(<EnvelopeParent initial={{ blocks: [textBlock('<p>a</p>')] }} onValue={v => seen.push(v)} />)
    })
    await act(async () => { fireEvent.click(editable()!) })
    const before = seen.length

    const el = editable()!
    for (const ch of ['ab', 'abc', 'abcd', 'abcde']) {
      el.innerHTML = `<p>${ch}</p>`
      await act(async () => { fireEvent.input(el) })
    }
    await act(async () => { await new Promise(r => setTimeout(r, 550)) })

    // One commit for the burst keeps undo useful and the 60-entry history honest.
    expect(seen.length - before).toBe(1)
    expect(seen[seen.length - 1].blocks[0].html).toContain('abcde')
  })
})

describe('page settings round-trip', () => {
  it('the editor reports settings as part of the document', async () => {
    const seen: EditorValue[] = []
    await act(async () => {
      render(<EnvelopeParent initial={{ blocks: [textBlock('<p>Hi</p>')] }} onValue={v => seen.push(v)} />)
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1].settings?.contentWidth).toBe(660)
  })

  it('a preheader typed in the toolbar reaches the parent', async () => {
    const seen: EditorValue[] = []
    await act(async () => {
      render(<EnvelopeParent initial={{ blocks: [textBlock('<p>Hi</p>')] }} onValue={v => seen.push(v)} />)
    })
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Preview text/i), { target: { value: 'Statement ready' } })
    })
    expect(seen[seen.length - 1].settings?.preheader).toBe('Statement ready')
  })

  it('exportToHtml honours the settings it is given', () => {
    const html = exportToHtml([textBlock('<p>Hello</p>')], { preheader: 'Peek inside', contentWidth: 560 })
    expect(html).toContain('Peek inside')
    expect(html).toContain('560')
  })

  it('parseEditorValue reads the envelope, a bare array, and a JSON string of either', () => {
    const blocks = [textBlock('<p>a</p>')]
    const settings: EmailSettings = { background: '#fff', contentWidth: 600, preheader: 'p' }

    const env = parseEditorValue({ blocks, settings })
    expect(env.blocks).toHaveLength(1)
    expect(env.settings.preheader).toBe('p')

    // Older templates stored a bare array — still has to load, with default settings.
    expect(parseEditorValue(blocks).blocks).toHaveLength(1)
    expect(parseEditorValue(blocks).settings).toEqual({})

    // jsonb arrives as a string.
    expect(parseEditorValue(JSON.stringify({ blocks, settings })).settings.contentWidth).toBe(600)
    expect(parseEditorValue(JSON.stringify(blocks)).blocks).toHaveLength(1)

    expect(parseEditorValue(null).blocks).toEqual([])
    expect(parseEditorValue('not json').blocks).toEqual([])
    expect(parseBlocks(JSON.stringify({ blocks, settings }))).toHaveLength(1)
  })
})

describe('a parent that rebuilds value every render', () => {
  // Each of these hung the process before the fix: the editor adopted the parent's
  // lagging revision, re-emitted it, and the parent lagged again, forever. A
  // synchronous loop, so not even the per-test timeout could interrupt it.
  it('settles instead of ping-ponging when blocks arrive without an id', async () => {
    const emitted: EmailBlock[][] = []
    const noId = { type: 'text', html: '<p>No id</p>' } as EmailBlock
    await act(async () => {
      render(<FreshObjectParent initial={[noId]} onBlocks={b => emitted.push(b)} />)
    })
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted[emitted.length - 1][0].html).toContain('No id')
    expect(emitted[emitted.length - 1][0].id).toBeTruthy()
  })

  it('keeps ids stable across unrelated re-renders', async () => {
    const emitted: EmailBlock[][] = []
    const noId = { type: 'text', html: '<p>No id</p>' } as EmailBlock
    await act(async () => {
      render(<FreshObjectParent initial={[noId]} onBlocks={b => emitted.push(b)} />)
    })
    const firstId = emitted[0]?.[0]?.id
    for (let i = 0; i < 4; i++) {
      await act(async () => { fireEvent.click(screen.getByTestId('unrelated')) })
    }
    expect(emitted[emitted.length - 1]?.[0]?.id).toBe(firstId)
  })

  it('does not create a new document revision on every unrelated re-render', async () => {
    const emitted: EmailBlock[][] = []
    await act(async () => {
      render(<FreshObjectParent initial={[textBlock('<p>Keep me</p>')]} onBlocks={b => emitted.push(b)} />)
    })
    const afterMount = emitted.length
    for (let i = 0; i < 5; i++) {
      await act(async () => { fireEvent.click(screen.getByTestId('unrelated')) })
    }
    expect(emitted.length - afterMount).toBeLessThanOrEqual(1)
  })

  it('an unrelated re-render does not deselect the block being edited', async () => {
    await act(async () => {
      render(<FreshObjectParent initial={[textBlock('<p>Editing</p>')]} />)
    })
    await act(async () => { fireEvent.click(editable()!) })
    expect(editable()!.getAttribute('contenteditable')).toBe('true')

    await act(async () => { fireEvent.click(screen.getByTestId('unrelated')) })

    // Losing the selection here is what turned contentEditable back off mid-edit
    // and let the DOM be overwritten with the pre-edit html.
    expect(editable()!.getAttribute('contenteditable')).toBe('true')
  })
})

describe('export keeps merge tags intact', () => {
  it('a text block and a button url survive export verbatim', () => {
    const html = exportToHtml([
      textBlock('<p>Dear <strong>{{first_name}}</strong>,</p>'),
      { id: 'x', type: 'button', text: 'Pay', url: '{{cta_url}}' },
    ], {})
    expect(html).toContain('{{first_name}}')
    expect(html).toContain('<strong>')
    expect(html).toContain('{{cta_url}}')
  })
})
