import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="font-mono text-5xl font-bold text-zinc-200">404</p>
      <h2 className="mt-3 text-base font-semibold text-zinc-700">Page not found</h2>
      <p className="mt-1 text-sm text-zinc-400">
        The page you're looking for doesn't exist.
      </p>
      <div className="mt-6">
        <Button variant="outline" onClick={() => navigate('/')}>
          Go to Dashboard
        </Button>
      </div>
    </div>
  )
}
