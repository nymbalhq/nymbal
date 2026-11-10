import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** GET /api/admin/mail-health: the sign-up policy, the last 7 days' confirmations, and a warning or none. */
export interface MailHealth {
  verification: 'required' | 'off'
  funnel: { days: number; started: number; verified: number } | null
  warning: string | null
}

export function useMailHealth() {
  return useQuery({
    queryKey: ['mail-health'],
    queryFn: () => api.get<MailHealth>('/api/admin/mail-health'),
  })
}
