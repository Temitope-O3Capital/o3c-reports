import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'

interface Sender {
  id:         number
  address:    string
  name:       string
  label:      string
  purpose:    string
  is_default: boolean
}

interface Props {
  purpose:  string
  value:    { address: string; name: string } | null
  onChange: (v: { address: string; name: string }) => void
  label?:   string
}

export default function SenderPicker({ purpose, value, onChange, label = 'From' }: Props) {
  const [senders, setSenders] = useState<Sender[]>([])

  useEffect(() => {
    apiFetch('/api/admin/email-senders')
      .then((data: any) => {
        const filtered = (data as Sender[]).filter(
          s => s.purpose === purpose || s.purpose === 'general'
        )
        setSenders(filtered)
        // Auto-select the default for this purpose if no value yet
        if (!value) {
          const def = filtered.find(s => s.purpose === purpose && s.is_default)
            ?? filtered.find(s => s.is_default)
            ?? filtered[0]
          if (def) onChange({ address: def.address, name: def.name })
        }
      })
      .catch(() => {})
  }, [purpose])  // eslint-disable-line react-hooks/exhaustive-deps

  if (senders.length === 0) return null

  const selectedKey = value ? `${value.name} <${value.address}>` : ''

  return (
    <div>
      <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
        {label}
      </label>
      <select
        value={selectedKey}
        onChange={e => {
          const s = senders.find(s => `${s.name} <${s.address}>` === e.target.value)
          if (s) onChange({ address: s.address, name: s.name })
        }}
        className="w-full rounded-lg border px-3 py-2.5 text-[13px] outline-none bg-white"
        style={{ borderColor: 'rgba(15,23,42,0.15)' }}
      >
        {senders.map(s => {
          const key = `${s.name} <${s.address}>`
          return (
            <option key={s.id} value={key}>
              {s.label}{s.is_default && s.purpose === purpose ? ' (default)' : ''} — {s.name} &lt;{s.address}&gt;
            </option>
          )
        })}
      </select>
      {value && (
        <p className="text-[11px] text-slate-400 mt-1">
          Recipients will see: <strong>{value.name} &lt;{value.address}&gt;</strong>
        </p>
      )}
    </div>
  )
}
