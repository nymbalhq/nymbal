'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNymbalClient } from '@nymbalhq/react'
import type { Address, CustomerAddress } from '@nymbalhq/types'
import styles from '@/styles/pages/account.module.css'

// The same fields and test ids as the Astro template's AddressForm (`new-address-<name>`).
const FIELDS: Array<{
  name: keyof Address
  label: string
  autoComplete: string
  required: boolean
  full?: boolean
  placeholder?: string
}> = [
  { name: 'firstName', label: 'First Name', autoComplete: 'given-name', required: true },
  { name: 'lastName', label: 'Last Name', autoComplete: 'family-name', required: true },
  {
    name: 'addressLine1',
    label: 'Address Line 1',
    autoComplete: 'address-line1',
    required: true,
    full: true,
  },
  {
    name: 'addressLine2',
    label: 'Address Line 2 (optional)',
    autoComplete: 'address-line2',
    required: false,
    full: true,
  },
  { name: 'city', label: 'City', autoComplete: 'address-level2', required: true },
  { name: 'region', label: 'State / County', autoComplete: 'address-level1', required: true },
  { name: 'postalCode', label: 'Postcode', autoComplete: 'postal-code', required: true },
  {
    name: 'country',
    label: 'Country (2-letter code)',
    autoComplete: 'country',
    required: true,
    placeholder: 'GB',
  },
]

export function AddressManager() {
  const client = useNymbalClient()
  const [addresses, setAddresses] = useState<CustomerAddress[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setAddresses(await client.customer.addresses.list())
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    const field = (name: string) => String(data.get(name) ?? '').trim()
    const address: Address = {
      firstName: field('firstName'),
      lastName: field('lastName'),
      addressLine1: field('addressLine1'),
      city: field('city'),
      region: field('region'),
      postalCode: field('postalCode'),
      country: field('country'),
      ...(field('addressLine2') && { addressLine2: field('addressLine2') }),
    }

    setSaving(true)
    setMessage(null)
    try {
      await client.customer.addresses.create(address)
      form.reset()
      setMessage({ ok: true, text: 'Address saved successfully.' })
      await load()
    } catch {
      setMessage({ ok: false, text: 'Failed to save address. Please try again.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <h2 className={styles.pageTitle}>Addresses</h2>

      <div data-testid="addresses-list">
        {addresses === null && !loadError && (
          <p className="text-sm text-muted">Loading addresses...</p>
        )}
        {loadError && <p className="text-sm text-muted">Unable to load addresses.</p>}
        {addresses !== null && addresses.length === 0 && (
          <div className={styles.emptyOrders}>
            <h3 className={styles.emptyOrdersTitle}>No saved addresses</h3>
            <p className={styles.emptyOrdersText}>Add an address below to get started.</p>
          </div>
        )}
        {addresses?.map((addr) => (
          <div
            key={addr.id}
            data-testid={`address-${addr.id}`}
            className={styles.formCard}
            style={{ marginBottom: 'var(--nymbal-spacing-md)' }}
          >
            <p style={{ fontSize: 'var(--nymbal-font-size-sm)', lineHeight: 1.6 }}>
              {addr.firstName} {addr.lastName}
              <br />
              {addr.addressLine1}
              {addr.addressLine2 && <>, {addr.addressLine2}</>}
              <br />
              {addr.city}, {addr.region} {addr.postalCode}
              <br />
              {addr.country}
            </p>
            <div
              style={{
                display: 'flex',
                gap: 'var(--nymbal-spacing-sm)',
                marginTop: 'var(--nymbal-spacing-sm)',
              }}
            >
              {addr.isDefaultShipping && <span className="badge">Default Shipping</span>}
              {addr.isDefaultBilling && <span className="badge">Default Billing</span>}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.formCard} style={{ marginTop: 'var(--nymbal-spacing-xl)' }}>
        <h3 className={styles.formCardTitle}>Add New Address</h3>
        {message && (
          <div
            className={`${styles.alert} ${message.ok ? styles.alertSuccess : styles.alertError}`}
          >
            {message.text}
          </div>
        )}
        <form onSubmit={handleSubmit} data-testid="add-address-form">
          <div className={styles.formGrid}>
            {FIELDS.map((f) => (
              <div key={f.name} className={f.full ? styles.formGridFull : undefined}>
                <label htmlFor={`new-address-${f.name}`}>{f.label}</label>
                <input
                  id={`new-address-${f.name}`}
                  name={f.name}
                  type="text"
                  required={f.required}
                  autoComplete={f.autoComplete}
                  placeholder={f.placeholder}
                  data-testid={`new-address-${f.name}`}
                />
              </div>
            ))}
          </div>
          <div className={styles.formActions}>
            <button
              type="submit"
              className={styles.saveButton}
              disabled={saving}
              data-testid="save-address"
            >
              {saving ? 'Saving...' : 'Save Address'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
