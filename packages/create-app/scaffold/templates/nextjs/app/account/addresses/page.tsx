import type { Metadata } from 'next'
import AddressBook from './AddressesView'
import styles from '@/styles/pages/account.module.css'

export const metadata: Metadata = {
  title: 'Addresses',
}

export default function AddressesPage() {
  return (
    <div>
      <h2 className={styles.pageTitle}>Addresses</h2>
      <AddressBook />
    </div>
  )
}
