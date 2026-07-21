import { useNavigate } from 'react-router-dom'
import NewTicketForm from './NewTicket'

export default function NewTicketPage() {
  const nav = useNavigate()
  return (
    <NewTicketForm
      onClose={() => nav('/helpdesk')}
      onCreated={(id) => nav(`/helpdesk/${id}`)}
    />
  )
}
