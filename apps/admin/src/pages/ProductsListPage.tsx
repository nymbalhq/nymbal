import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutationState, type MutationKey } from '@tanstack/react-query'
import { Plus, Search, Copy, Archive, MoreHorizontal, Package } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/common/EmptyState'
import {
  useProducts,
  useDuplicateProduct,
  useArchiveProduct,
  DUPLICATE_PRODUCT_KEY,
  ARCHIVE_PRODUCT_KEY,
} from '@/hooks/useProducts'
import { useStoreCurrency } from '@/hooks/useMe'
import { ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/money'
import { formatRelative } from '@/lib/dates'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'
import type { ProductSnapshot, ProductStatus } from '@nymbalhq/types'

const STATUS_FILTERS: { label: string; value: ProductStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Draft', value: 'draft' },
  { label: 'Archived', value: 'archived' },
]

const STATUS_BADGE: Record<ProductStatus, 'success' | 'default' | 'secondary'> = {
  active: 'success',
  draft: 'default',
  archived: 'secondary',
}

type RowOutcome =
  | { kind: 'duplicated'; copy: ProductSnapshot }
  | { kind: 'archived'; name: string }
  | { kind: 'error'; message: string }

/** The products with this action in flight: one mutation serves every row, so its variables say which. */
function useInFlight(mutationKey: MutationKey): Set<string> {
  const ids = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  })
  return new Set(ids)
}

const failureMessage = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback

export function ProductsListPage() {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<ProductStatus | 'all'>('all')
  const [search, setSearch] = useState('')

  const { data: products, isLoading } = useProducts({
    status: statusFilter === 'all' ? undefined : statusFilter,
    q: search || undefined,
    limit: 100,
  })

  const duplicate = useDuplicateProduct()
  const archive = useArchiveProduct()
  const duplicating = useInFlight(DUPLICATE_PRODUCT_KEY)
  const archiving = useInFlight(ARCHIVE_PRODUCT_KEY)
  const [outcome, setOutcome] = useState<RowOutcome | null>(null)
  const currency = useStoreCurrency()

  async function duplicateProduct(product: ProductSnapshot) {
    setOutcome(null)
    try {
      const copy = await duplicate.mutateAsync(product.id)
      setOutcome({ kind: 'duplicated', copy })
    } catch (err) {
      setOutcome({
        kind: 'error',
        message: failureMessage(err, 'The product could not be duplicated.'),
      })
    }
  }

  async function archiveProduct(product: ProductSnapshot) {
    setOutcome(null)
    try {
      await archive.mutateAsync(product.id)
      setOutcome({ kind: 'archived', name: product.name })
    } catch (err) {
      setOutcome({
        kind: 'error',
        message: failureMessage(err, 'The product could not be archived.'),
      })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Products</h1>
          <p className="text-sm text-zinc-500">
            {products ? `${products.length} products` : 'Loading...'}
          </p>
        </div>
        <Button onClick={() => navigate('/products/new')} className="gap-1.5">
          <Plus className="h-4 w-4" />
          Add Product
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                statusFilter === f.value
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 sm:max-w-xs sm:ml-auto">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            placeholder="Search products..."
            aria-label="Search products"
            data-search-field
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
      </div>

      {outcome?.kind === 'error' && (
        <p role="alert" className="text-sm text-red-600" data-testid={tid('products', 'row', 'error')}>
          {outcome.message}
        </p>
      )}
      {outcome !== null && outcome.kind !== 'error' && (
        <p role="status" className="text-sm text-zinc-600" data-testid={tid('products', 'row', 'result')}>
          {outcome.kind === 'duplicated' ? (
            <>
              Duplicated as{' '}
              <Link
                to={`/products/${outcome.copy.slug}`}
                className="font-medium text-zinc-900 underline"
                data-testid={tid('products', 'row', 'result', 'link')}
              >
                {outcome.copy.name}
              </Link>
            </>
          ) : (
            `Archived ${outcome.name}`
          )}
        </p>
      )}

      <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : !products?.length ? (
          <EmptyState
            icon={<Package className="h-5 w-5" />}
            title="No products found"
            description={search ? 'Try a different search.' : 'Create your first product.'}
            action={
              <Button onClick={() => navigate('/products/new')} className="gap-1.5">
                <Plus className="h-4 w-4" />
                Add Product
              </Button>
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Image</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => {
                const primaryMedia = product.media[0]
                const primaryVariant = product.variants[0]
                const totalStock = product.variants.reduce((a, v) => a + v.stock, 0)
                const hasLowStock = product.variants.some((v) => v.stock <= v.lowStockThreshold)
                const hasOutOfStock = product.variants.some((v) => v.stock === 0)

                return (
                  <TableRow
                    key={product.id}
                    data-row-id={product.id}
                    data-testid={tid('products', 'row', product.id)}
                    className="cursor-pointer"
                    onClick={(e) => {
                      if ((e.target as Element).closest('a')) return
                      navigate(`/products/${product.slug}`)
                    }}
                  >
                    <TableCell>
                      {primaryMedia ? (
                        <img
                          src={primaryMedia.url}
                          alt={primaryMedia.altText}
                          className="h-8 w-8 rounded border border-zinc-100 object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center rounded border border-zinc-100 bg-zinc-50">
                          <Package className="h-3.5 w-3.5 text-zinc-300" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>
                        <Link
                          to={`/products/${product.slug}`}
                          data-row-link
                          className="block font-medium text-zinc-800 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        >
                          {product.name}
                        </Link>
                        <p className="font-mono text-[10px] text-zinc-400">{product.slug}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[product.status]} className="capitalize">
                        {product.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-zinc-500 capitalize">
                      {product.type}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {primaryVariant && currency !== undefined
                        ? formatMoney(primaryVariant.priceMinor, currency)
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <span className={cn(
                        'text-sm font-mono font-medium',
                        hasOutOfStock ? 'text-red-600' : hasLowStock ? 'text-amber-600' : 'text-zinc-700'
                      )}>
                        {totalStock}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs text-zinc-400">
                      {formatRelative(product.updatedAt)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-zinc-400"
                            aria-label={`Actions for ${product.name}`}
                            data-testid={tid('products', 'row', 'actions', product.id)}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => navigate(`/products/${product.slug}`)}
                            data-testid={tid('products', 'row', 'edit', product.id)}
                          >
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={duplicating.has(product.id)}
                            onSelect={() => void duplicateProduct(product)}
                            className="gap-2"
                            data-testid={tid('products', 'row', 'duplicate', product.id)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Duplicate
                          </DropdownMenuItem>
                          {product.status !== 'archived' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={archiving.has(product.id)}
                                onSelect={() => void archiveProduct(product)}
                                className="gap-2 text-zinc-500"
                                data-testid={tid('products', 'row', 'archive', product.id)}
                              >
                                <Archive className="h-3.5 w-3.5" />
                                Archive
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

export const productsListHandle = {
  breadcrumb: () => 'Products',
}
