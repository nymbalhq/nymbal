'use client'

import { useState, useEffect, useCallback, type FormEvent } from 'react'
import { useAuth } from '@nymbal/react'
import styles from '@/styles/pages/account.module.css'

export function ProfileForm() {
  const { customer, updateProfile } = useAuth()

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (customer) {
      setFirstName(customer.firstName ?? '')
      setLastName(customer.lastName ?? '')
      setPhone(customer.phone ?? '')
    }
  }, [customer])

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setSaving(true)
      setError(null)
      setSuccess(false)

      try {
        await updateProfile({ firstName, lastName, phone })
        setSuccess(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update profile.')
      } finally {
        setSaving(false)
      }
    },
    [firstName, lastName, phone, updateProfile],
  )

  return (
    <div>
      <h2 className={styles.pageTitle}>Profile</h2>

      {success && (
        <div className={`${styles.alert} ${styles.alertSuccess}`}>
          Profile updated successfully.
        </div>
      )}
      {error && (
        <div className={`${styles.alert} ${styles.alertError}`}>{error}</div>
      )}

      <div className={styles.formCard}>
        <h3 className={styles.formCardTitle}>Personal Information</h3>
        <form onSubmit={handleSubmit}>
          <div className={styles.formGrid}>
            <div>
              <label htmlFor="profile-first-name">First Name</label>
              <input
                id="profile-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="given-name"
              />
            </div>
            <div>
              <label htmlFor="profile-last-name">Last Name</label>
              <input
                id="profile-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
            <div className={styles.formGridFull}>
              <label htmlFor="profile-email">Email</label>
              <input
                id="profile-email"
                type="email"
                value={customer?.email ?? ''}
                disabled
                autoComplete="email"
              />
            </div>
            <div className={styles.formGridFull}>
              <label htmlFor="profile-phone">Phone</label>
              <input
                id="profile-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Your phone number"
                autoComplete="tel"
              />
            </div>
          </div>
          <div className={styles.formActions}>
            <button
              type="submit"
              className={styles.saveButton}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
