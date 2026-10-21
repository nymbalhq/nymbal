import type { Metadata } from 'next'
import ProfileForm from './ProfileView'
import styles from '@/styles/pages/account.module.css'

export const metadata: Metadata = {
  title: 'Profile',
}

export default function ProfilePage() {
  return (
    <div>
      <h2 className={styles.pageTitle}>Profile</h2>
      <div className={styles.formCard}>
        <h3 className={styles.formCardTitle}>Personal Information</h3>
        <ProfileForm />
      </div>
    </div>
  )
}
