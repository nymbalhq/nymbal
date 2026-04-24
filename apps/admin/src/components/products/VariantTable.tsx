import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { tid } from '@/lib/testid'
import type { Variant } from '@/types'

interface VariantTableProps {
  productId: string
  variants: Variant[]
  onChange: (variants: Variant[]) => void
  currency: string
}

function createEmptyVariant(productId: string): Variant {
  return {
    id: `new-${crypto.randomUUID()}`,
    productId,
    sku: '',
    name: 'New Variant',
    priceMinor: 0,
    compareAtPriceMinor: null,
    stock: 0,
    lowStockThreshold: 5,
    options: [],
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

interface EditableVariant extends Variant {
  _priceDisplay: string
}

export function VariantTable({ productId, variants, onChange, currency }: VariantTableProps) {
  const [editing, setEditing] = useState<EditableVariant[]>(
    variants.map((v) => ({
      ...v,
      _priceDisplay: (v.priceMinor / 100).toFixed(2),
    }))
  )

  const updateVariant = (id: string, field: keyof Variant | '_priceDisplay', value: unknown) => {
    setEditing((prev) => {
      const updated = prev.map((v) => {
        if (v.id !== id) return v
        if (field === '_priceDisplay') {
          const price = parseFloat(value as string)
          return {
            ...v,
            _priceDisplay: value as string,
            priceMinor: isNaN(price) ? v.priceMinor : Math.round(price * 100),
          }
        }
        return { ...v, [field]: value }
      })
      onChange(updated.map(({ _priceDisplay: _, ...rest }) => rest))
      return updated
    })
  }

  const addVariant = () => {
    const empty = createEmptyVariant(productId)
    const next = [...editing, { ...empty, _priceDisplay: '0.00' }]
    setEditing(next)
    onChange(next.map(({ _priceDisplay: _, ...rest }) => rest))
  }

  const removeVariant = (id: string) => {
    const next = editing.filter((v) => v.id !== id)
    setEditing(next)
    onChange(next.map(({ _priceDisplay: _, ...rest }) => rest))
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-zinc-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 border-b border-zinc-200">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">SKU</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">Name</th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">Price</th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">Stock</th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">Status</th>
              <th className="w-10 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {editing.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-zinc-400">
                  No variants yet. Add one below.
                </td>
              </tr>
            )}
            {editing.map((variant) => (
              <tr
                key={variant.id}
                className="border-b border-zinc-100 last:border-0"
                data-testid={tid('product', 'variant-row', variant.id)}
              >
                <td className="px-3 py-2">
                  <Input
                    value={variant.sku}
                    onChange={(e) => updateVariant(variant.id, 'sku', e.target.value)}
                    placeholder="SKU-001"
                    className="h-7 font-mono text-xs w-28"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    value={variant.name}
                    onChange={(e) => updateVariant(variant.id, 'name', e.target.value)}
                    placeholder="Variant name"
                    className="h-7 text-xs"
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <span className="text-xs text-zinc-400">{currency}</span>
                    <Input
                      value={variant._priceDisplay}
                      onChange={(e) => updateVariant(variant.id, '_priceDisplay', e.target.value)}
                      onBlur={(e) => {
                        const val = parseFloat(e.target.value)
                        if (!isNaN(val)) {
                          updateVariant(variant.id, '_priceDisplay', val.toFixed(2))
                        }
                      }}
                      className="h-7 w-20 text-right font-mono text-xs"
                    />
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <Input
                    type="number"
                    value={variant.stock}
                    onChange={(e) => updateVariant(variant.id, 'stock', parseInt(e.target.value) || 0)}
                    className="h-7 w-16 text-right font-mono text-xs ml-auto"
                    min={0}
                  />
                </td>
                <td className="px-3 py-2">
                  <Select
                    value={variant.status}
                    onValueChange={(v) => updateVariant(variant.id, 'status', v)}
                  >
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => removeVariant(variant.id)}
                    className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                    title="Remove variant"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-zinc-400">
          {editing.length} variant{editing.length !== 1 ? 's' : ''}
          {editing.length > 0 && (
            <> · Total stock: {editing.reduce((a, v) => a + v.stock, 0)}</>
          )}
        </p>
        <Button variant="outline" size="sm" onClick={addVariant} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add Variant
        </Button>
      </div>
    </div>
  )
}
