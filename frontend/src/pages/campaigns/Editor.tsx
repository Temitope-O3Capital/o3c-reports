import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtNum } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, SORA, INTER, NUM } from '../../lib/design'
import { toast } from 'sonner'
import { filterInputStyle } from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number
  name: string
  description?: string
  status: string
  type: string
  list_id?: number
  list_name?: string
  email_subject?: string
  email_body_html?: string
  email_body_text?: string
  from_name?: string
  from_email?: string
  sms_body?: string
  scheduled_at?: string
  total_contacts?: number
  created_by_name?: string
  created_at: string
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    draft:     [AMBER, '#FFF9ED'],
    scheduled: [NAVY,  '#EDF2FF'],
    active:    [GREEN, '#F0FDF4'],
    paused:    [AMBER, '#FFF9ED'],
    completed: ['#6B7280', '#F5F6F8'],
    cancelled: [RED,   '#FFF1F1'],
  }
  const [color, bg] = map[status] ?? ['#6B7280', '#F5F6F8']
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, fontFamily: SORA, letterSpacing: '.04em',
      textTransform: 'uppercase', padding: '3px 9px', borderRadius: 20,
      background: bg, color, border: `1px solid ${color}40`,
    }}>
      {status}
    </span>
  )
}

// ── Label + field wrapper ──────────────────────────────────────────────────────

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }}>
        {label}
      </label>
      {children}
      {hint && <p style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 4 }}>{hint}</p>}
    </div>
  )
}

const fld: React.CSSProperties = { ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const }
const ta: React.CSSProperties  = { ...fld, resize: 'vertical' as const, fontFamily: INTER, lineHeight: 1.6 }

// ── Main ───────────────────────────────────────────────────────────────────────

export default function CampaignEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [saving,   setSaving]   = useState(false)

  // Editable fields
  const [name,         setName]         = useState('')
  const [description,  setDescription]  = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody,    setEmailBody]    = useState('')
  const [fromName,     setFromName]     = useState('')
  const [fromEmail,    setFromEmail]    = useState('')
  const [smsBody,      setSmsBody]      = useState('')
  const [scheduledAt,  setScheduledAt]  = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setErr(null)
    try {
      const c = await apiFetch<Campaign>(`/api/campaigns/${id}`)
      setCampaign(c)
      setName(c.name ?? '')
      setDescription(c.description ?? '')
      setEmailSubject(c.email_subject ?? '')
      setEmailBody(c.email_body_html ?? c.email_body_text ?? '')
      setFromName(c.from_name ?? '')
      setFromEmail(c.from_email ?? '')
      setSmsBody(c.sms_body ?? '')
      if (c.scheduled_at) {
        // Format for datetime-local input (strip timezone, slice to minute precision)
        setScheduledAt(c.scheduled_at.slice(0, 16))
      }
    } catch (ex: any) {
      setErr(ex.message ?? 'Failed to load campaign')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const canEdit = campaign?.status === 'draft' || campaign?.status === 'scheduled'
  const isEmail = campaign?.type === 'email' || campaign?.type === 'multi'
  const isSMS   = campaign?.type === 'sms'   || campaign?.type === 'multi'

  async function save() {
    if (!canEdit || !id) return
    setSaving(true)
    try {
      const payload: Record<string, any> = { name, description }
      if (isEmail) {
        payload.email_subject    = emailSubject
        payload.email_body_html  = `<html><body>${emailBody.replace(/\n/g, '<br/>')}</body></html>`
        payload.email_body_text  = emailBody
        payload.from_name        = fromName || undefined
        payload.from_email       = fromEmail || undefined
      }
      if (isSMS) {
        payload.sms_body = smsBody
      }
      if (scheduledAt) {
        payload.scheduled_at = scheduledAt
      }
      await apiFetch(`/api/campaigns/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      toast.success('Campaign saved')
      load()
    } catch (ex: any) {
      toast.error(ex.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
      <Spinner />
    </div>
  )

  if (!campaign) return <ErrBanner error={err ?? 'Campaign not found'} />

  return (
    <Page
      title={campaign.name}
      subtitle={`${campaign.type?.toUpperCase() ?? 'CAMPAIGN'} · ${fmtNum(campaign.total_contacts ?? 0)} contacts`}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <StatusBadge status={campaign.status} />
          <button
            onClick={() => navigate(`/campaigns`)}
            style={{ ...fld, width: 'auto', padding: '0 14px', height: 34, cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
          >
            ← Back
          </button>
          {canEdit && (
            <button
              onClick={save}
              disabled={saving}
              style={{
                height: 34, padding: '0 18px', borderRadius: 8, border: 'none',
                background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? .7 : 1,
                fontFamily: SORA,
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {!canEdit && (
        <div style={{
          background: '#FFF9ED', border: '1px solid #F59E0B40', borderRadius: 8,
          padding: '10px 14px', marginBottom: 20, fontSize: 13, color: '#92400E',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16, flexShrink: 0 }}>lock</span>
          This campaign is <strong>{campaign.status}</strong> — editing is disabled. Only draft and scheduled campaigns can be modified.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>

        {/* Left: content fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionCard title="Campaign Details" padding>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Campaign Name *">
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  disabled={!canEdit}
                  style={fld}
                />
              </Field>
              <Field label="Description">
                <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  disabled={!canEdit}
                  rows={2}
                  style={ta}
                />
              </Field>
            </div>
          </SectionCard>

          {isEmail && (
            <SectionCard title="Email Content" padding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Field label="Subject Line *">
                  <input
                    value={emailSubject}
                    onChange={e => setEmailSubject(e.target.value)}
                    disabled={!canEdit}
                    placeholder="e.g. Your card statement is ready"
                    style={fld}
                  />
                </Field>
                <Field
                  label="Body"
                  hint='Merge tags: {{firstName}}, {{lastName}}, {{phone}}, {{email}}, {{cifNumber}}'
                >
                  <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                    value={emailBody}
                    onChange={e => setEmailBody(e.target.value)}
                    disabled={!canEdit}
                    rows={14}
                    placeholder="Write your email body here. Use {{firstName}} etc. for personalisation."
                    style={{ ...ta, fontSize: 13 }}
                  />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="From Name">
                    <input
                      value={fromName}
                      onChange={e => setFromName(e.target.value)}
                      disabled={!canEdit}
                      placeholder="O3 Capital"
                      style={fld}
                    />
                  </Field>
                  <Field label="From Email">
                    <input
                      value={fromEmail}
                      onChange={e => setFromEmail(e.target.value)}
                      disabled={!canEdit}
                      placeholder="noreply@o3capital.com"
                      type="email"
                      style={fld}
                    />
                  </Field>
                </div>
              </div>
            </SectionCard>
          )}

          {isSMS && (
            <SectionCard title="SMS Content" padding>
              <Field
                label="Message Body"
                hint={`${smsBody.length}/160 chars · Merge tags: {{firstName}}, {{lastName}} · Merge tags: {{firstName}}, {{lastName}}`}
              >
                <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                  value={smsBody}
                  onChange={e => setSmsBody(e.target.value)}
                  disabled={!canEdit}
                  rows={5}
                  maxLength={480}
                  placeholder="Write your SMS message here. Under 160 characters for a single SMS."
                  style={{ ...ta, fontSize: 13 }}
                />
              </Field>
            </SectionCard>
          )}
        </div>

        {/* Right: schedule + meta */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionCard title="Schedule" padding>
            <Field
              label="Send At (WAT)"
              hint="Leave blank to send immediately when you start the campaign. All times are interpreted as West Africa Time (UTC+1)."
            >
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={e => setScheduledAt(e.target.value)}
                disabled={!canEdit}
                style={fld}
              />
            </Field>
          </SectionCard>

          <SectionCard title="Campaign Info" padding>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                ['Channel',      campaign.type?.toUpperCase()],
                ['Status',       <StatusBadge key="s" status={campaign.status} />],
                ['Contact List', campaign.list_name ?? '—'],
                ['Contacts',     <span key="c" style={NUM}>{fmtNum(campaign.total_contacts ?? 0)}</span>],
                ['Created By',   campaign.created_by_name ?? '—'],
                ['Created',      fmtDate(campaign.created_at)],
              ].map(([label, value]) => (
                <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}>
                  <span style={{ color: 'var(--txt2)', flexShrink: 0 }}>{label}</span>
                  <span style={{ color: 'var(--txt)', fontWeight: 500, textAlign: 'right' }}>{value}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          {canEdit && (
            <button
              onClick={save}
              disabled={saving}
              style={{
                width: '100%', height: 40, border: 'none', borderRadius: 8,
                background: NAVY, color: '#fff', fontSize: 14, fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? .7 : 1,
                fontFamily: SORA,
              }}
            >
              {saving ? 'Saving…' : 'Save Campaign'}
            </button>
          )}
        </div>
      </div>
    </Page>
  )
}
