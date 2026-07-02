import { useState } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, ErrBanner, NAVY } from '../../components/UI'

interface Recipient {
  email: string
  name: string
}

interface MailAttachment {
  filename: string
  content_type: string
  content: string
  size: number
}

const emptyRecipient = (): Recipient => ({ email: '', name: '' })
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${bytes} B`
}

function readFileAsAttachment(file: File): Promise<MailAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result || '')
      const [, content = ''] = result.split(',', 2)
      resolve({
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        content,
        size: file.size,
      })
    }
    reader.readAsDataURL(file)
  })
}

function RecipientRows({
  label,
  recipients,
  setRecipients,
}: {
  label: string
  recipients: Recipient[]
  setRecipients: (next: Recipient[]) => void
}) {
  function update(index: number, patch: Partial<Recipient>) {
    setRecipients(recipients.map((r, i) => i === index ? { ...r, ...patch } : r))
  }

  function remove(index: number) {
    setRecipients(recipients.filter((_, i) => i !== index))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="block text-[12px] font-semibold text-[color:var(--txt2)]">{label}</label>
        <button
          type="button"
          onClick={() => setRecipients([...recipients, emptyRecipient()])}
          className="inline-flex items-center gap-1 text-[12px] font-semibold"
          style={{ color: NAVY }}
        >
          <span className="material-symbols-rounded text-[14px]">add</span>
          Add
        </button>
      </div>
      <div className="space-y-2">
        {recipients.map((recipient, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <input
              type="email"
              value={recipient.email}
              onChange={e => update(index, { email: e.target.value })}
              placeholder="email@company.com"
              className="px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'var(--bdr)' }}
            />
            <input
              value={recipient.name}
              onChange={e => update(index, { name: e.target.value })}
              placeholder="Name"
              className="px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'var(--bdr)' }}
            />
            <button
              type="button"
              onClick={() => remove(index)}
              disabled={recipients.length === 1}
              className="w-9 h-9 rounded-lg flex items-center justify-center disabled:opacity-30 hover:bg-[var(--chip-bg)]"
              title="Remove recipient"
            >
              <span className="material-symbols-rounded text-[17px] text-[color:var(--txt2)]">close</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function compactRecipients(recipients: Recipient[]) {
  return recipients
    .map(r => ({ email: r.email.trim(), name: r.name.trim() }))
    .filter(r => r.email)
}

export default function ComposeMail() {
  const [to, setTo] = useState<Recipient[]>([emptyRecipient()])
  const [cc, setCc] = useState<Recipient[]>([])
  const [bcc, setBcc] = useState<Recipient[]>([])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<MailAttachment[]>([])
  const [copyMe, setCopyMe] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  async function addAttachments(files: FileList | null) {
    setError('')
    if (!files?.length) return
    const incoming = Array.from(files)
    if (attachments.length + incoming.length > 10) {
      setError('You can attach up to 10 files.')
      return
    }
    const tooLarge = incoming.find(file => file.size > MAX_FILE_BYTES)
    if (tooLarge) {
      setError(`${tooLarge.name} is larger than 10 MB.`)
      return
    }
    const total = attachments.reduce((sum, file) => sum + file.size, 0) + incoming.reduce((sum, file) => sum + file.size, 0)
    if (total > MAX_TOTAL_BYTES) {
      setError('Attachments cannot exceed 20 MB total.')
      return
    }
    try {
      const encoded = await Promise.all(incoming.map(readFileAsAttachment))
      setAttachments([...attachments, ...encoded])
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const cleanTo = compactRecipients(to)
    if (!cleanTo.length) {
      setError('Add at least one recipient.')
      return
    }
    if (!subject.trim()) {
      setError('Subject is required.')
      return
    }
    if (!body.trim()) {
      setError('Message body is required.')
      return
    }
    setSending(true)
    try {
      await apiFetch('/api/mail/send', {
        method: 'POST',
          body: JSON.stringify({
          to: cleanTo,
          cc: compactRecipients(cc),
          bcc: compactRecipients(bcc),
          subject,
            html_body: body.replace(/\n/g, '<br>'),
            text_body: body,
            attachments: attachments.map(({ filename, content_type, content }) => ({ filename, content_type, content })),
            send_copy_to_sender: copyMe,
          }),
      })
      toast.success('Email queued')
      setTo([emptyRecipient()])
      setCc([])
      setBcc([])
      setSubject('')
      setBody('')
      setAttachments([])
      setCopyMe(true)
    } catch (e: any) {
      setError(e.message)
      toast.error(e.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Page dept="Campaigns" title="Compose Mail" subtitle="Send one-off staff emails with tracking">
      <ErrBanner msg={error} />

      <form onSubmit={send} className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5">
        <SectionCard title="Message">
          <div className="p-5 space-y-4">
            <RecipientRows label="To" recipients={to} setRecipients={setTo} />
            <RecipientRows label="CC" recipients={cc.length ? cc : []} setRecipients={setCc} />
            <RecipientRows label="BCC" recipients={bcc.length ? bcc : []} setRecipients={setBcc} />

            <div>
              <label className="block text-[12px] font-semibold text-[color:var(--txt2)] mb-1.5">Subject</label>
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Subject line"
                className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                style={{ borderColor: 'var(--bdr)' }}
              />
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-[color:var(--txt2)] mb-1.5">Body</label>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={12}
                placeholder="Write your email..."
                className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-y"
                style={{ borderColor: 'var(--bdr)', minHeight: 260 }}
              />
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-[color:var(--txt2)] mb-1.5">Attachments</label>
              <label
                className="flex items-center justify-center gap-2 px-3 py-3 rounded-lg border border-dashed text-[13px] font-semibold cursor-pointer hover:bg-[var(--bg)]"
                style={{ borderColor: 'rgba(15,23,42,0.2)', color: NAVY }}
              >
                <span className="material-symbols-rounded text-[18px]">attach_file</span>
                Add images or files
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => {
                    addAttachments(e.target.files)
                    e.currentTarget.value = ''
                  }}
                />
              </label>
              {attachments.length > 0 && (
                <div className="mt-2 space-y-2">
                  {attachments.map((file, index) => (
                    <div key={`${file.filename}-${index}`} className="flex items-center gap-3 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--bdr)' }}>
                      <span className="material-symbols-rounded text-[17px] text-[color:var(--txt2)]">
                        {file.content_type.startsWith('image/') ? 'image' : 'description'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-[color:var(--txt)]">{file.filename}</div>
                        <div className="text-[11px] text-[color:var(--txt2)]">{formatBytes(file.size)}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAttachments(attachments.filter((_, i) => i !== index))}
                        className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--chip-bg)]"
                        title="Remove attachment"
                      >
                        <span className="material-symbols-rounded text-[16px] text-[color:var(--txt2)]">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Delivery">
          <div className="p-5 space-y-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={copyMe}
                onChange={e => setCopyMe(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="block text-[13px] font-semibold text-[color:var(--txt)]">Keep a copy</span>
                <span className="block text-[12px] text-[color:var(--txt2)] mt-0.5">
                  Graph saves to Sent Items when configured; SendGrid sends you a copy.
                </span>
              </span>
            </label>

            <div className="rounded-lg px-3 py-3 text-[12px] text-[color:var(--txt2)]" style={{ background: 'rgba(14,40,65,0.05)' }}>
              Messages are tracked in Mail Health. Suppressed recipients are blocked automatically.
            </div>

            <button
              type="submit"
              disabled={sending}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}
            >
              <span className="material-symbols-rounded text-[16px]">send</span>
              {sending ? 'Sending...' : 'Send Email'}
            </button>
          </div>
        </SectionCard>
      </form>
    </Page>
  )
}
