'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { CartDrawer } from '@nymbal/react'

export function CartDrawerToggle() {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  const handleCheckoutClick = useCallback(() => {
    setOpen(false)
    router.push('/checkout')
  }, [router])

  useEffect(() => {
    function handleOpen() {
      setOpen(true)
    }

    function handleClose() {
      setOpen(false)
    }

    window.addEventListener('nymbal:cart:open', handleOpen)
    window.addEventListener('nymbal:cart:close', handleClose)
    return () => {
      window.removeEventListener('nymbal:cart:open', handleOpen)
      window.removeEventListener('nymbal:cart:close', handleClose)
    }
  }, [])

  return (
    <CartDrawer
      open={open}
      onCheckoutClick={handleCheckoutClick}
    />
  )
}
