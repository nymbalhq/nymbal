import { useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T, idx: number) => ReactNode
  className?: string
}

interface VirtualTableProps<T> {
  data: T[]
  columns: Column<T>[]
  rowHeight?: number
  onRowClick?: (row: T) => void
  className?: string
}

export function VirtualTable<T>({
  data,
  columns,
  rowHeight = 44,
  onRowClick,
  className,
}: VirtualTableProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  })

  const items = virtualizer.getVirtualItems()

  return (
    <div className={cn('w-full overflow-auto', className)} ref={parentRef}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-white border-b border-zinc-200">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'h-10 px-4 text-left text-xs font-medium uppercase tracking-wider text-zinc-500',
                  col.className
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {items.map((virtualItem) => {
            const row = data[virtualItem.index]
            if (!row) return null
            return (
              <tr
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                  height: `${rowHeight}px`,
                }}
                className={cn(
                  'border-b border-zinc-100 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-zinc-50'
                )}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn('px-4 align-middle', col.className)}
                    style={{ height: `${rowHeight}px` }}
                  >
                    {col.render(row, virtualItem.index)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
