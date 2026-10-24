import type { Metadata } from 'next'
import { renderNymbal } from '@/lib/render'
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
        <ProfileForm serverHtml={renderNymbal('nymbal-profile-form').__html} />
      </div>
    </div>
  )
}
