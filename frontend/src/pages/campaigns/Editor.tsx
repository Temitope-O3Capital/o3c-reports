import { useParams, Navigate } from 'react-router-dom'

export default function CampaignEditor() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={`/campaigns/${id}/report`} replace />
}
