import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { tid } from '@/lib/testid'

/** While `when` is true: holds an in-app navigation to another path (except /login) behind a "Leave without saving?"
 *  dialog, and asks the browser to confirm a reload or tab close. */
export function UnsavedChangesGuard({ when }: { when: boolean }): JSX.Element | null {
  // The router reads its blocker function from an effect after render, so a save that clears `when` and navigates in
  // the same tick would be judged by the stale value. A stable function over a ref set at commit sees the cleared
  // value as soon as the caller has flushed its render.
  const whenRef = useRef(when)
  useLayoutEffect(() => {
    whenRef.current = when
  }, [when])

  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      whenRef.current &&
      nextLocation.pathname !== currentLocation.pathname &&
      // A navigation to /login follows a session that has already ended; holding it would keep a page whose Save
      // the server refuses.
      nextLocation.pathname !== '/login',
    [],
  )
  const blocker = useBlocker(shouldBlock)

  useEffect(() => {
    if (!when) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [when])

  const stayRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const blocked = blocker.state === 'blocked'
  // The dialog's focus trap returns focus on a timer after it unmounts; the merchant's next key must already reach
  // what they left (Save, say), so the opener is taken before the dialog mounts and focused once its trap is gone.
  useLayoutEffect(() => {
    if (blocked && document.activeElement instanceof HTMLElement) {
      openerRef.current = document.activeElement
    }
  }, [blocked])
  useEffect(() => {
    if (blocked) return
    const opener = openerRef.current
    openerRef.current = null
    if (opener?.isConnected) opener.focus()
  }, [blocked])

  if (!blocked) return null

  return (
    <Dialog open onOpenChange={(open) => !open && blocker.reset?.()}>
      <DialogContent
        data-testid={tid('unsaved', 'dialog')}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          stayRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Leave without saving?</DialogTitle>
          <DialogDescription>Your changes to this product are not saved.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => blocker.proceed?.()}
            data-testid={tid('unsaved', 'leave')}
          >
            Leave
          </Button>
          <Button
            ref={stayRef}
            onClick={() => blocker.reset?.()}
            data-testid={tid('unsaved', 'stay')}
          >
            Stay
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
