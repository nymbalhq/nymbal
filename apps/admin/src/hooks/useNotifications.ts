import { create } from 'zustand'
import type { Notification } from '@/types'

interface NotificationsStore {
  notifications: Notification[]
  unreadCount: number
  pushNotification: (n: Omit<Notification, 'id' | 'at' | 'read'>) => void
  markAllRead: () => void
  clearAll: () => void
}

export const useNotifications = create<NotificationsStore>((set) => ({
  notifications: [],
  unreadCount: 0,

  pushNotification: (n) => {
    const notification: Notification = {
      ...n,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      read: false,
    }
    set((state) => ({
      notifications: [notification, ...state.notifications].slice(0, 50),
      unreadCount: state.unreadCount + 1,
    }))
  },

  markAllRead: () => {
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }))
  },

  clearAll: () => {
    set({ notifications: [], unreadCount: 0 })
  },
}))
