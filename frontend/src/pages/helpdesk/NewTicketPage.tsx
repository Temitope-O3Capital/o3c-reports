import { useNavigate, useSearchParams } from 'react-router-dom'
import ComposeTicket from './ComposeTicket'

export default function NewTicketPage() {
  const navigate    = useNavigate()
  const [params]    = useSearchParams()
  const prefillCif  = params.get('cif') ?? undefined

  return (
    <div className="min-h-screen" style={{ background: '#F4F6F8' }}>
      <ComposeTicket
        open={true}
        prefillCif={prefillCif}
        onClose={() => navigate(-1)}
        onCreated={ticket => navigate(`/helpdesk/${ticket.id}`)}
      />
    </div>
  )
}
