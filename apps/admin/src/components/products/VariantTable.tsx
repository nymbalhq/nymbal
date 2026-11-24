import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { parseMoney, toMoneyInput } from '@/lib/money'
import { tid } from '@/lib/testid'
import type { Variant } from '@nymbalhq/types'

interface VariantTableProps {
  productId: string
  variants: Variant[]
  onChange: (variants: Variant[]) => void
  currency: string
  /**
   * An existing product's save keeps only price, GTIN and weight: SKU, name, stock and status read as text (stock
   * links to the variant in Inventory), and rows are neither added nor removed.
   */
  existing?: boolean
}

function createEmptyVariant(productId: string): Variant {
  return {
    id: `new-${crypto.randomUUID()}`,
    productId,
    sku: '',
    name: 'New Variant',
    priceMinor: 0,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
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
  _weightDisplay: string
}

const MAX_WEIGHT_GRAMS = 1_000_000

/** Whole grams from 0 to 1,000,000, null for an empty field, undefined for anything else (the last weight stands). */
function parseWeight(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const grams = Number(trimmed)
  return grams <= MAX_WEIGHT_GRAMS ? grams : undefined
}

const toWeightInput = (grams: number | null): string => (grams === null ? '' : String(grams))

function editable(v: Variant, currency: string): EditableVariant {
  return {
    ...v,
    _priceDisplay: toMoneyInput(v.priceMinor, currency),
    _weightDisplay: toWeightInput(v.weightGrams),
  }
}

const plain = (rows: EditableVariant[]): Variant[] =>
  rows.map(({ _priceDisplay: _p, _weightDisplay: _w, ...rest }) => rest)

export function VariantTable({
  productId,
  variants,
  onChange,
  currency,
  existing = false,
}: VariantTableProps) {
  const [editing, setEditing] = useState<EditableVariant[]>(
    variants.map((v) => editable(v, currency)),
  )

  const updateVariant = (
    id: string,
    field: keyof Variant | '_priceDisplay' | '_weightDisplay',
    value: unknown,
  ) => {
    setEditing((prev) => {
      const updated = prev.map((v) => {
        if (v.id !== id) return v
        if (field === '_priceDisplay') {
          const price = parseMoney(value as string, currency)
          return { ...v, _priceDisplay: value as string, priceMinor: price ?? v.priceMinor }
        }
        if (field === '_weightDisplay') {
          const grams = parseWeight(value as string)
          return {
            ...v,
            _weightDisplay: value as string,
            weightGrams: grams === undefined ? v.weightGrams : grams,
          }
        }
        return { ...v, [field]: value }
      })
      onChange(plain(updated))
      return updated
    })
  }

  const addVariant = () => {
    const empty = createEmptyVariant(productId)
    const next = [...editing, editable(empty, currency)]
    setEditing(next)
    onChange(plain(next))
  }

  const removeVariant = (id: string) => {
    const next = editing.filter((v) => v.id !== id)
    setEditing(next)
    onChange(plain(next))
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-zinc-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 border-b border-zinc-200">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                SKU
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                Name
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">
                Price
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                GTIN
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">
                Weight (g)
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">
                Stock
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                Status
              </th>
              <th className="w-10 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {editing.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-zinc-400">
                  {existing ? 'No variants.' : 'No variants yet. Add one below.'}
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
                  {existing ? (
                    <span className="font-mono text-xs">{variant.sku}</span>
                  ) : (
                    <Input
                      value={variant.sku}
                      onChange={(e) => updateVariant(variant.id, 'sku', e.target.value)}
                      placeholder="SKU-001"
                      className="h-7 font-mono text-xs w-28"
                    />
                  )}
                </td>
                <td className="px-3 py-2">
                  {existing ? (
                    <span className="text-xs">{variant.name}</span>
                  ) : (
                    <Input
                      value={variant.name}
                      onChange={(e) => updateVariant(variant.id, 'name', e.target.value)}
                      placeholder="Variant name"
                      className="h-7 text-xs"
                    />
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <span className="text-xs text-zinc-400">{currency}</span>
                    <Input
                      value={variant._priceDisplay}
                      onChange={(e) => updateVariant(variant.id, '_priceDisplay', e.target.value)}
                      data-testid={tid('product', 'variant-price', variant.id)}
                      onBlur={() =>
                        updateVariant(
                          variant.id,
                          '_priceDisplay',
                          toMoneyInput(variant.priceMinor, currency),
                        )
                      }
                      className="h-7 w-20 text-right font-mono text-xs"
                    />
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Input
                    value={variant.gtin ?? ''}
                    onChange={(e) => updateVariant(variant.id, 'gtin', e.target.value)}
                    data-testid={tid('product', 'variant-gtin', variant.id)}
                    inputMode="numeric"
                    placeholder="UPC or EAN"
                    className="h-7 w-32 font-mono text-xs"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="text"
                    value={variant._weightDisplay}
                    onChange={(e) => updateVariant(variant.id, '_weightDisplay', e.target.value)}
                    onBlur={() =>
                      updateVariant(
                        variant.id,
                        '_weightDisplay',
                        toWeightInput(variant.weightGrams),
                      )
                    }
                    data-testid={tid('product', 'variant-weight', variant.id)}
                    aria-label={`Weight of ${variant.name} in grams`}
                    inputMode="numeric"
                    className="h-7 w-20 ml-auto text-right font-mono text-xs"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  {existing ? (
                    <Link
                      to={`/inventory?q=${encodeURIComponent(variant.sku)}`}
                      data-testid={tid('product', 'variant-stock', variant.id)}
                      title="Adjust stock in Inventory"
                      className="font-mono text-xs text-zinc-700 underline underline-offset-2 hover:text-zinc-900"
                    >
                      {variant.stock}
                    </Link>
                  ) : (
                    <Input
                      type="number"
                      value={variant.stock}
                      onChange={(e) =>
                        updateVariant(variant.id, 'stock', parseInt(e.target.value) || 0)
                      }
                      className="h-7 w-16 text-right font-mono text-xs ml-auto"
                      min={0}
                    />
                  )}
                </td>
                <td className="px-3 py-2">
                  {existing ? (
                    <span className="text-xs capitalize">{variant.status}</span>
                  ) : (
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
                  )}
                </td>
                <td className="px-3 py-2">
                  {!existing && (
                    <button
                      onClick={() => removeVariant(variant.id)}
                      className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                      title="Remove variant"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-zinc-400">
          {editing.length} variant{editing.length !== 1 ? 's' : ''}
          {editing.length > 0 && <> · Total stock: {editing.reduce((a, v) => a + v.stock, 0)}</>}
        </p>
        {!existing && (
          <Button variant="outline" size="sm" onClick={addVariant} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Add Variant
          </Button>
        )}
      </div>
    </div>
  )
}
