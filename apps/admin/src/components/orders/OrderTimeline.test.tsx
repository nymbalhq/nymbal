import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { OrderHistoryEntry, OrderStatus } from '@nymbalhq/types'
import { OrderTimeline } from './OrderTimeline'

// A history row that moved the order shows the two statuses; a row that did not (a refund, a capture not applied)
// shows the one status it stayed at, and the note says what happened.

const REFUND_ID = 'admin-order-timeline-entry-refund'
const moved = (minute: number): OrderHistoryEntry => ({
  id: `h-${minute}`,
  orderId: 'o-1',
  fromStatus: null,
  toStatus: 'pending',
  actor: 'admin:u-1',
  note: '',
  timestamp: `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`,
})
const row = (
  minute: number,
  fromStatus: OrderStatus | null,
  toStatus: OrderStatus,
  note = '',
): OrderHistoryEntry => ({ ...moved(minute), fromStatus, toStatus, note })

function entries() {
  return screen.getAllByRole('listitem').map((li) => ({
    testid: li.getAttribute('data-testid'),
    badges: ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'].filter(
      (label) => (li.textContent ?? '').includes(label),
    ),
    moved: (li.textContent ?? '').includes('→'),
    noted: (li.textContent ?? '').includes('refund of £5.00'),
  }))
}

describe('the admin order history', () => {
  // Kills: a same-status row still rendering Confirmed → Confirmed, or a move losing its from status or the refund id
  // standing in for the destination's.
  it('AC-16: a same-status row renders one badge and the note under the refund test id; a move renders from → to under its destination’s id', () => {
    const history = [
      row(0, null, 'pending', 'order draft created'),
      row(1, 'pending', 'confirmed', 'payment captured'),
      row(2, 'confirmed', 'confirmed', 'refund of £5.00'),
      row(3, 'confirmed', 'processing'),
    ]
    render(<OrderTimeline entries={history} />)

    const shown = entries()
    const [move, refund] = shown
    expect(refund!.badges.length, 'a same-status row shows fewer statuses than a move').toBeLessThan(
      move!.badges.length,
    )
    expect(shown).toEqual([
      {
        testid: 'admin-order-timeline-entry-processing',
        badges: ['Confirmed', 'Processing'],
        moved: true,
        noted: false,
      },
      { testid: REFUND_ID, badges: ['Confirmed'], moved: false, noted: true },
      {
        testid: 'admin-order-timeline-entry-confirmed',
        badges: ['Pending', 'Confirmed'],
        moved: true,
        noted: false,
      },
      { testid: 'admin-order-timeline-entry-pending', badges: ['Pending'], moved: false, noted: false },
    ])
  })
})
