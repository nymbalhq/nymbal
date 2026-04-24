import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { useProducts, useDuplicateProduct, useArchiveProduct } from '@/hooks/useProducts'
import { formatMoney } from '@/lib/money'
import { formatRelative } from '@/lib/dates'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'
import type { ProductStatus } from '@/types'

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Products</h1>
          <p className="text-sm text-zinc-500">
            {products ? `${products.length} products` : 'Loading...'}
          </p>
        </div>
        <Button onClick={() => navigate('/admin/products/new')} className="gap-1.5">
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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
      </div>

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
              <Button onClick={() => navigate('/admin/products/new')} className="gap-1.5">
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
                    data-testid={tid('products', 'row', product.id)}
                    className="cursor-pointer"
                    onClick={() => navigate(`/admin/products/${product.slug}`)}
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
                        <p className="font-medium text-zinc-800">{product.name}</p>
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
                      {primaryVariant
                        ? formatMoney(primaryVariant.priceMinor, 'GBP')
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
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 opacity-0 group-hover:opacity-100">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => navigate(`/admin/products/${product.slug}`)}>
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void duplicate.mutateAsync(product.id)}
                            className="gap-2"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => void archive.mutateAsync(product.id)}
                            className="gap-2 text-zinc-500"
                          >
                            <Archive className="h-3.5 w-3.5" />
                            Archive
                          </DropdownMenuItem>
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
