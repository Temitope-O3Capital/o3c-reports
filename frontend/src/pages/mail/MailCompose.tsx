import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import DOMPurify from 'dompurify'
import RecipientAutocomplete from '../../components/RecipientAutocomplete'
import SenderPicker from '../../components/SenderPicker'
import RichTextEditor from '../../components/RichTextEditor'

const NAVY = '#0E2841'

interface Recipient { email: string; name?: string }
interface AttachmentMeta {
  filename: string
  content_type: string
  content?: string
  size?: number
}

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function normalizeRecipients(value: unknown): Recipient[] {
  return asArray(value)
    .map(item => ({
      email: String(item?.email ?? '').trim(),
      name: item?.name ? String(item.name) : '',
    }))
    .filter(item => item.email)
}

function recipientsWithInput(recipients: Recipient[], input: string): Recipient[] {
  const next = [...recipients]
  input
    .split(/[,\s;]+/)
    .map(email => email.trim())
    .filter(email => email.includes('@'))
    .forEach(email => {
      if (!next.some(item => item.email.toLowerCase() === email.toLowerCase())) {
        next.push({ email, name: '' })
      }
    })
  return next
}

function normalizeAttachments(value: unknown): AttachmentMeta[] {
  return asArray(value)
    .map(item => ({
      filename: String(item?.filename ?? item?.name ?? '').trim(),
      content_type: String(item?.content_type ?? item?.type ?? 'application/octet-stream'),
      content: item?.content ? String(item.content) : undefined,
      size: typeof item?.size === 'number' ? item.size : typeof item?.size_bytes === 'number' ? item.size_bytes : undefined,
    }))
    .filter(item => item.filename)
}

function RecipientTag({ email, onRemove }: { email: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-medium bg-[var(--chip-bg)] text-[color:var(--txt)] flex-shrink-0">
      {email}
      <button type="button" onClick={onRemove} className="hover:text-red-500 ml-0.5">
        <span className="material-symbols-rounded text-[13px]">close</span>
      </button>
    </span>
  )
}

function readFileAsAttachment(file: File): Promise<AttachmentMeta> {
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

function AttachmentChip({ att, onRemove }: { att: AttachmentMeta; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium bg-[var(--chip-bg)] text-[color:var(--txt)] border border-[var(--bdr)]">
      <span className="material-symbols-rounded text-[14px] text-[color:var(--txt2)]">attach_file</span>
      <span className="truncate max-w-[140px]">{att.filename}</span>
      {att.size !== undefined && (
        <span className="text-[color:var(--txt2)]">({fmtBytes(att.size)})</span>
      )}
      <button type="button" onClick={onRemove} className="hover:text-red-500 ml-0.5 flex-shrink-0">
        <span className="material-symbols-rounded text-[13px]">close</span>
      </button>
    </span>
  )
}

export default function MailCompose() {
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [to, setTo]           = useState<Recipient[]>([])
  const [toInput, setToInput] = useState(params.get('to') ?? '')
  const [cc, setCc]           = useState<Recipient[]>([])
  const [ccInput, setCcInput] = useState('')
  const [bcc, setBcc]         = useState<Recipient[]>([])
  const [bccInput, setBccInput] = useState('')
  const [showCc, setShowCc]   = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState(params.get('subject') ?? '')
  const [body, setBody]       = useState('')
  const [sender, setSender]   = useState<{ address: string; name: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [draftId, setDraftId] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([])
  const [uploading, setUploading] = useState(false)
  const [signature, setSignature] = useState('')
  const [editingSignature, setEditingSignature] = useState(false)
  const [signatureInput, setSignatureInput] = useState('')
  const [wordCount, setWordCount] = useState(0)
  const [scheduledAt, setScheduledAt] = useState<string | null>(null)
  const [showSchedule, setShowSchedule] = useState(false)
  const scheduleRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // Word count from HTML body
  useEffect(() => {
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    setWordCount(text ? text.split(' ').length : 0)
  }, [body])

  // Load signature on mount
  useEffect(() => {
    apiFetch('/api/mail/signature')
      .then((d: any) => {
        const html = d?.signature_html ?? ''
        setSignature(html)
        setSignatureInput(html)
      })
      .catch(() => {
        const fallback = `<span style="color:#94a3b8">--</span><br/>${sender?.name ?? 'Me'}`
        setSignature(fallback)
        setSignatureInput(fallback)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load draft if URL has ?draft_id=N
  useEffect(() => {
    const draftParam = params.get('draft_id')
    if (!draftParam) return
    const id = parseInt(draftParam, 10)
    if (!id) return
    apiFetch(`/api/mail/drafts/${id}`)
      .then((d: any) => {
        const draftTo = normalizeRecipients(d.to_addrs)
        const draftCc = normalizeRecipients(d.cc_addrs)
        const draftBcc = normalizeRecipients(d.bcc_addrs)
        setDraftId(d.id)
        setSubject(d.subject ?? '')
        setBody(d.html_body ?? '')
        setTo(draftTo)
        setCc(draftCc)
        setBcc(draftBcc)
        if (draftCc.length) setShowCc(true)
        if (draftBcc.length) setShowBcc(true)
        setAttachments(normalizeAttachments(d.attachments))
        if (d.from_email && d.from_name) setSender({ address: d.from_email, name: d.from_name })
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill reply / forward
  useEffect(() => {
    const replyTo = params.get('reply_to')
    const forward = params.get('forward')
    const msgId = replyTo ?? forward
    if (!msgId) return
    apiFetch(`/api/mail/messages/${msgId}`)
      .then((d: any) => {
        if (replyTo) {
          setTo([{ email: d.from_email, name: d.from_name ?? '' }])
          setSubject(`Re: ${d.subject ?? ''}`)
        } else {
          setSubject(`Fwd: ${d.subject ?? ''}`)
          const quoted = `<br/><br/><div style="border-left:3px solid #e2e8f0;padding-left:12px;color:#64748b;margin-top:16px"><p><b>From:</b> ${d.from_email}</p><p><b>Subject:</b> ${d.subject}</p><br/>${d.html_body ?? ''}</div>`
          setBody(quoted)
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save draft every 30s
  const saveDraft = useCallback(async () => {
    if (!subject.trim() && !body.trim()) return
    setDraftStatus('saving')
    try {
      const draftTo = recipientsWithInput(to, toInput)
      const draftCc = recipientsWithInput(cc, ccInput)
      const draftBcc = recipientsWithInput(bcc, bccInput)
      const payload = {
        subject,
        html_body: body,
        text_body: body.replace(/<[^>]+>/g, ''),
        to_addrs: draftTo,
        cc_addrs: draftCc,
        bcc_addrs: draftBcc,
        from_email: sender?.address ?? '',
        from_name: sender?.name ?? '',
        attachments,
        ...(draftId ? { id: draftId } : {}),
      }
      const d: any = await apiFetch('/api/mail/drafts', { method: 'POST', body: JSON.stringify(payload) })
      if (d?.id) setDraftId(d.id)
      setDraftStatus('saved')
      setTimeout(() => setDraftStatus('idle'), 3000)
    } catch {
      setDraftStatus('idle')
    }
  }, [subject, body, to, toInput, cc, ccInput, bcc, bccInput, sender, attachments, draftId])

  useEffect(() => {
    autoSaveTimer.current = setInterval(() => saveDraft(), 30_000)
    return () => { if (autoSaveTimer.current) clearInterval(autoSaveTimer.current) }
  }, [saveDraft])

  // Close schedule picker on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (scheduleRef.current && !scheduleRef.current.contains(e.target as Node)) {
        setShowSchedule(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function addRecipient(field: 'to' | 'cc' | 'bcc', email: string, name?: string) {
    if (!email.includes('@')) return
    if (field === 'to') {
      if (!to.find(r => r.email === email)) setTo(prev => [...prev, { email, name }])
      setToInput('')
    } else if (field === 'cc') {
      if (!cc.find(r => r.email === email)) setCc(prev => [...prev, { email, name }])
      setCcInput('')
    } else {
      if (!bcc.find(r => r.email === email)) setBcc(prev => [...prev, { email, name }])
      setBccInput('')
    }
  }

  function commitRecipientInput(field: 'to' | 'cc' | 'bcc', inputVal: string) {
    inputVal
      .split(/[,\s;]+/)
      .map(email => email.trim())
      .filter(email => email.includes('@'))
      .forEach(email => addRecipient(field, email))
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    setUploading(true)
    try {
      if (attachments.length + files.length > 10) {
        toast.error('You can attach up to 10 files')
        return
      }
      const tooLarge = files.find(file => file.size > MAX_FILE_BYTES)
      if (tooLarge) {
        toast.error(`${tooLarge.name} is larger than 10 MB`)
        return
      }
      const existingTotal = attachments.reduce((sum, file) => sum + (file.size ?? 0), 0)
      const incomingTotal = files.reduce((sum, file) => sum + file.size, 0)
      if (existingTotal + incomingTotal > MAX_TOTAL_BYTES) {
        toast.error('Attachments cannot exceed 20 MB total')
        return
      }
      const encoded = await Promise.all(files.map(readFileAsAttachment))
      setAttachments(prev => [...prev, ...encoded])
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to attach file')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function saveSignature() {
    try {
      await apiFetch('/api/mail/signature', {
        method: 'PUT',
        body: JSON.stringify({ signature_html: signatureInput, signature_text: signatureInput.replace(/<[^>]+>/g, '') }),
      })
      setSignature(signatureInput)
      setEditingSignature(false)
      toast.success('Signature saved')
    } catch {
      toast.error('Failed to save signature')
    }
  }

  async function send() {
    const sendTo = recipientsWithInput(to, toInput)
    const sendCc = recipientsWithInput(cc, ccInput)
    const sendBcc = recipientsWithInput(bcc, bccInput)
    if (sendTo.length === 0) { toast.error('Add at least one recipient'); return }
    if (!subject.trim()) { toast.error('Subject is required'); return }
    setSending(true)
    try {
      const fullBody = body + (signature ? `<div style="margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px;font-size:13px;color:#64748b">${signature}</div>` : '')
      await apiFetch('/api/mail/send', {
        method: 'POST',
        body: JSON.stringify({
          to: sendTo.map(r => ({ email: r.email, name: r.name ?? '' })),
          cc: sendCc.map(r => ({ email: r.email, name: r.name ?? '' })),
          bcc: sendBcc.map(r => ({ email: r.email, name: r.name ?? '' })),
          subject,
          html_body: fullBody,
          text_body: fullBody.replace(/<[^>]+>/g, ''),
          from_address: sender?.address,
          from_name: sender?.name,
          send_at: scheduledAt ?? null,
          attachments: attachments
            .filter(att => att.content)
            .map(({ filename, content_type, content }) => ({ filename, content_type, content })),
          send_copy_to_sender: true,
        }),
      })
      // Delete draft if one existed
      if (draftId) {
        apiFetch(`/api/mail/drafts/${draftId}`, { method: 'DELETE' }).catch(() => {})
      }
      toast.success(scheduledAt ? 'Email scheduled' : 'Email sent')
      navigate('/mail/sent')
    } catch (e: any) {
      toast.error(e.message ?? 'Send failed')
    } finally {
      setSending(false)
    }
  }

  async function handleSaveDraftManual() {
    setSavingDraft(true)
    await saveDraft()
    setSavingDraft(false)
    toast.success('Draft saved')
  }

  return (
    <div className="max-w-[860px] mx-auto px-6 py-8 w-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-[13px] text-[color:var(--txt2)] hover:text-[color:var(--txt)] transition-colors"
        >
          <span className="material-symbols-rounded text-[16px]">arrow_back</span>
          Back
        </button>
        <h1 className="text-[18px] font-bold text-[color:var(--txt)] flex-1">New Message</h1>
        {draftStatus === 'saving' && (
          <span className="text-[11px] text-[color:var(--txt2)] flex items-center gap-1">
            <span className="material-symbols-rounded text-[13px] animate-spin">refresh</span>
            Saving…
          </span>
        )}
        {draftStatus === 'saved' && (
          <span className="text-[11px] text-[color:var(--txt2)]">Draft saved</span>
        )}
      </div>

      <div className="rounded-2xl border shadow-sm overflow-hidden bg-[var(--card)]"
        style={{ borderColor: 'var(--bdr)' }}>

        {/* From */}
        <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--bdr)' }}>
          <SenderPicker purpose="general" label="" value={sender} onChange={setSender} />
        </div>

        {/* To */}
        <div className="px-5 py-2.5 border-b flex items-start gap-3"
          style={{ borderColor: 'var(--bdr)', minHeight: 44 }}>
          <span className="text-[12px] font-semibold text-[color:var(--txt2)] pt-2 w-8 flex-shrink-0">To</span>
          <div className="flex-1 flex flex-wrap gap-1.5 items-center min-h-[36px]">
            {to.map(r => (
              <RecipientTag key={r.email} email={r.email}
                onRemove={() => setTo(prev => prev.filter(x => x.email !== r.email))} />
            ))}
            <div className="flex-1 min-w-[160px]">
              <RecipientAutocomplete
                value={toInput}
                onChange={setToInput}
                onSelect={s => addRecipient('to', s.email, s.name)}
                onCommit={email => commitRecipientInput('to', email)}
                placeholder="recipient@example.com"
              />
            </div>
          </div>
          <div className="flex items-center gap-1 pt-2 flex-shrink-0">
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)}
                className="text-[11px] font-medium text-[color:var(--txt2)] hover:text-[color:var(--txt)] px-1.5 py-0.5 rounded transition-colors">
                Cc
              </button>
            )}
            {!showBcc && (
              <button type="button" onClick={() => setShowBcc(true)}
                className="text-[11px] font-medium text-[color:var(--txt2)] hover:text-[color:var(--txt)] px-1.5 py-0.5 rounded transition-colors">
                Bcc
              </button>
            )}
          </div>
        </div>

        {/* Cc */}
        {showCc && (
          <div className="px-5 py-2.5 border-b flex items-start gap-3"
            style={{ borderColor: 'var(--bdr)', minHeight: 44 }}>
            <span className="text-[12px] font-semibold text-[color:var(--txt2)] pt-2 w-8 flex-shrink-0">Cc</span>
            <div className="flex-1 flex flex-wrap gap-1.5 items-center min-h-[36px]">
              {cc.map(r => (
                <RecipientTag key={r.email} email={r.email}
                  onRemove={() => setCc(prev => prev.filter(x => x.email !== r.email))} />
              ))}
              <div className="flex-1 min-w-[160px]">
                <RecipientAutocomplete
                  value={ccInput}
                  onChange={setCcInput}
                  onSelect={s => addRecipient('cc', s.email, s.name)}
                  onCommit={email => commitRecipientInput('cc', email)}
                  placeholder="cc@example.com"
                />
              </div>
            </div>
          </div>
        )}

        {/* Bcc */}
        {showBcc && (
          <div className="px-5 py-2.5 border-b flex items-start gap-3"
            style={{ borderColor: 'var(--bdr)', minHeight: 44 }}>
            <span className="text-[12px] font-semibold text-[color:var(--txt2)] pt-2 w-8 flex-shrink-0">Bcc</span>
            <div className="flex-1 flex flex-wrap gap-1.5 items-center min-h-[36px]">
              {bcc.map(r => (
                <RecipientTag key={r.email} email={r.email}
                  onRemove={() => setBcc(prev => prev.filter(x => x.email !== r.email))} />
              ))}
              <div className="flex-1 min-w-[160px]">
                <RecipientAutocomplete
                  value={bccInput}
                  onChange={setBccInput}
                  onSelect={s => addRecipient('bcc', s.email, s.name)}
                  onCommit={email => commitRecipientInput('bcc', email)}
                  placeholder="bcc@example.com"
                />
              </div>
            </div>
          </div>
        )}

        {/* Subject */}
        <div className="px-5 py-3 border-b flex items-center gap-3"
          style={{ borderColor: 'var(--bdr)' }}>
          <span className="text-[12px] font-semibold text-[color:var(--txt2)] w-8 flex-shrink-0">Sub</span>
          <input
            type="text"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="Subject"
            className="flex-1 text-[14px] font-medium text-[color:var(--txt)] outline-none bg-transparent placeholder:text-[color:var(--txt3)]"
          />
        </div>

        {/* Signature */}
        <div className="px-5 py-2.5 border-b" style={{ borderColor: 'rgba(15,23,42,0.06)', background: 'rgba(248,250,252,0.6)' }}>
          {editingSignature ? (
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <div className="text-[11px] font-semibold text-[color:var(--txt2)] mb-1">Signature</div>
                <textarea
                  value={signatureInput}
                  onChange={e => setSignatureInput(e.target.value)}
                  rows={3}
                  className="w-full text-[12px] text-[color:var(--txt2)] border rounded-lg px-3 py-2 outline-none resize-none"
                  style={{ borderColor: 'var(--bdr)', fontFamily: 'inherit' }}
                />
              </div>
              <div className="flex flex-col gap-1 pt-5 flex-shrink-0">
                <button type="button" onClick={saveSignature}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white"
                  style={{ background: NAVY }}>
                  Save
                </button>
                <button type="button" onClick={() => { setEditingSignature(false); setSignatureInput(signature) }}
                  className="px-3 py-1.5 rounded-lg text-[12px] text-[color:var(--txt2)] hover:bg-[var(--chip-bg)] transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1 text-[12px] text-[color:var(--txt2)] italic truncate">
                <span className="text-[color:var(--txt3)] mr-1">--</span>
                <span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(signature || (sender?.name ?? 'Me')) }} />
              </div>
              <button type="button" onClick={() => setEditingSignature(true)}
                className="flex-shrink-0 text-[color:var(--txt3)] hover:text-[color:var(--txt2)] transition-colors">
                <span className="material-symbols-rounded text-[15px]">edit</span>
              </button>
            </div>
          )}
        </div>

        {/* Rich Text Body */}
        <RichTextEditor
          content={body}
          onChange={setBody}
          placeholder="Write your message…"
          minHeight={260}
        />

        {/* Attachment bar */}
        {(attachments.length > 0 || uploading) && (
          <div className="px-5 py-2.5 border-t flex flex-wrap gap-2 items-center"
            style={{ borderColor: 'rgba(15,23,42,0.06)', background: 'var(--bg)' }}>
            {attachments.map((att, i) => (
              <AttachmentChip key={`${att.filename}-${i}`} att={att}
                onRemove={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))} />
            ))}
            {uploading && (
              <span className="text-[12px] text-[color:var(--txt2)] flex items-center gap-1">
                <span className="material-symbols-rounded text-[14px] animate-spin">refresh</span>
                Uploading…
              </span>
            )}
          </div>
        )}

        {/* Bottom action bar */}
        <div className="flex items-center justify-between px-5 py-3 border-t"
          style={{ borderColor: 'var(--bdr)', background: 'var(--bg)' }}>
          <div className="flex items-center gap-2">
            {/* Send */}
            <button
              type="button"
              onClick={send}
              disabled={sending}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60 transition-opacity"
              style={{ background: NAVY }}
            >
              <span className="material-symbols-rounded text-[15px]">send</span>
              {sending ? 'Sending…' : 'Send'}
            </button>

            {/* Schedule */}
            <div className="relative" ref={scheduleRef}>
              <button
                type="button"
                onClick={() => setShowSchedule(v => !v)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${scheduledAt ? 'text-white' : 'text-[color:var(--txt2)] hover:bg-[var(--bdr)]'}`}
                style={scheduledAt ? { background: '#2563EB' } : { background: 'rgba(15,23,42,0.07)' }}
              >
                <span className="material-symbols-rounded text-[15px]">schedule_send</span>
                {scheduledAt ? new Date(scheduledAt).toLocaleString('en-NG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Schedule'}
              </button>
              {showSchedule && (
                <div className="absolute bottom-full mb-2 left-0 bg-[var(--card)] rounded-xl shadow-xl border p-4 z-30 min-w-[260px]"
                  style={{ borderColor: 'var(--bdr)' }}>
                  <p className="text-[12px] font-semibold text-[color:var(--txt2)] mb-2">Schedule send</p>
                  <input
                    type="datetime-local"
                    className="w-full border rounded-lg px-3 py-2 text-[13px] outline-none"
                    style={{ borderColor: 'var(--bdr)' }}
                    value={scheduledAt ? scheduledAt.slice(0, 16) : ''}
                    onChange={e => setScheduledAt(e.target.value ? new Date(e.target.value).toISOString() : null)}
                  />
                  {scheduledAt && (
                    <button type="button" onClick={() => setScheduledAt(null)}
                      className="mt-2 text-[11px] text-red-500 hover:text-red-700">
                      Clear schedule
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Save Draft */}
            <button
              type="button"
              onClick={handleSaveDraftManual}
              disabled={savingDraft}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[color:var(--txt2)] transition-colors hover:bg-[var(--bdr)] disabled:opacity-60"
              style={{ background: 'rgba(15,23,42,0.07)' }}
            >
              <span className="material-symbols-rounded text-[15px]">save</span>
              {savingDraft ? 'Saving…' : 'Save Draft'}
            </button>

            {/* Attach */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[color:var(--txt2)] transition-colors hover:bg-[var(--bdr)]"
              style={{ background: 'rgba(15,23,42,0.07)' }}
            >
              <span className="material-symbols-rounded text-[15px]">attach_file</span>
              Attach
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>

          <div className="flex items-center gap-4">
            <span className="text-[11px] text-[color:var(--txt2)]">{wordCount} words</span>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-[12px] text-[color:var(--txt2)] hover:text-red-500 transition-colors"
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
