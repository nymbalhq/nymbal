import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShoppingBag, Package, Users, Search } from 'lucide-react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import { useGlobalSearch } from '@/hooks/useGlobalSearch'
import { tid } from '@/lib/testid'

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

export function CommandPalette() {
  const { isOpen, close } = useCommandPalette()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query, 300)

  const { data: results } = useGlobalSearch(debouncedQuery)

  const runCommand = useCallback(
    (fn: () => void) => {
      close()
      fn()
    },
    [close]
  )

  return (
    <CommandDialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <CommandInput
        placeholder="Search orders, products, customers..."
        value={query}
        onValueChange={setQuery}
        data-testid={tid('search', 'input')}
      />
      <CommandList data-testid={tid('search')}>
        <CommandEmpty>
          {debouncedQuery.length < 2 ? (
            <span className="text-zinc-400">Type at least 2 characters to search</span>
          ) : (
            <span>No results for &quot;{debouncedQuery}&quot;</span>
          )}
        </CommandEmpty>

        {results?.orders && results.orders.length > 0 && (
          <CommandGroup heading="Orders">
            {results.orders.slice(0, 5).map((order) => (
              <CommandItem
                key={order.id}
                value={`order-${order.orderNumber}`}
                onSelect={() =>
                  runCommand(() => navigate(`/orders/${order.orderNumber}`))
                }
              >
                <ShoppingBag className="h-4 w-4 text-zinc-400 shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="font-mono text-sm font-medium">#{order.orderNumber}</span>
                  <span className="text-xs text-zinc-500 truncate">{order.email}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {results?.products && results.products.length > 0 && (
          <>
            {results.orders && results.orders.length > 0 && <CommandSeparator />}
            <CommandGroup heading="Products">
              {results.products.slice(0, 5).map((product) => (
                <CommandItem
                  key={product.id}
                  value={`product-${product.id}`}
                  onSelect={() =>
                    runCommand(() => navigate(`/products/${product.slug}`))
                  }
                >
                  <Package className="h-4 w-4 text-zinc-400 shrink-0" />
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium truncate">{product.name}</span>
                    <span className="text-xs text-zinc-500 capitalize">{product.status}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {results?.customers && results.customers.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Customers">
              {results.customers.slice(0, 5).map((customer) => (
                <CommandItem
                  key={customer.id}
                  value={`customer-${customer.id}`}
                  onSelect={() =>
                    runCommand(() => navigate(`/customers/${customer.id}`))
                  }
                >
                  <Users className="h-4 w-4 text-zinc-400 shrink-0" />
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium">
                      {customer.firstName} {customer.lastName}
                    </span>
                    <span className="text-xs text-zinc-500 truncate">{customer.email}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}

export function CommandPaletteButton() {
  const { open } = useCommandPalette()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  return (
    <button
      onClick={open}
      className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 transition-colors"
      data-testid={tid('search', 'trigger')}
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden sm:inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 text-[10px] font-medium text-zinc-400">
        <span>⌘</span>K
      </kbd>
    </button>
  )
}
