import type { Metadata } from 'next'
import { AddressManager } from '@/components/client/AddressManager'

export const metadata: Metadata = {
  title: 'Addresses',
}

export default function AddressesPage() {
  return <AddressManager />
}
