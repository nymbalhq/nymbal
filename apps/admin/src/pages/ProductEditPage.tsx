import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Save, ArrowLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { VariantTable } from '@/components/products/VariantTable'
import { MediaUploader } from '@/components/products/MediaUploader'
import { SeoPreview } from '@/components/products/SeoPreview'
import { AiEnrichButton } from '@/components/products/AiEnrichButton'
import { useProduct, useCreateProduct, useUpdateProduct } from '@/hooks/useProducts'
import { tid } from '@/lib/testid'
import type { ProductSnapshot, ProductStatus, Variant, ProductMedia } from '@/types'

const DEFAULT_PRODUCT: Partial<ProductSnapshot> = {
  name: '',
  slug: '',
  description: '',
  shortDescription: '',
  status: 'draft',
  type: 'simple',
  seoTitle: '',
  seoDescription: '',
  media: [],
  variants: [],
  categoryIds: [],
  metadata: {},
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function ProductEditPage() {
  const { slug } = useParams<{ slug?: string }>()
  const navigate = useNavigate()
  const isNew = !slug || slug === 'new'

  const { data: existingProduct, isLoading } = useProduct(isNew ? '' : (slug ?? ''))
  const createProduct = useCreateProduct()
  const updateProduct = useUpdateProduct()

  const [form, setForm] = useState<Partial<ProductSnapshot>>(DEFAULT_PRODUCT)
  const [isDirty, setIsDirty] = useState(false)
  const [slugManual, setSlugManual] = useState(false)

  useEffect(() => {
    if (existingProduct) {
      setForm(existingProduct)
    }
  }, [existingProduct])

  const update = <K extends keyof ProductSnapshot>(field: K, value: ProductSnapshot[K]) => {
    setIsDirty(true)
    setForm((prev) => {
      const next = { ...prev, [field]: value }
      // Auto-slug from name
      if (field === 'name' && !slugManual) {
        next.slug = slugify(value as string)
      }
      return next
    })
  }

  const handleSave = async () => {
    if (isNew) {
      const created = await createProduct.mutateAsync(form)
      navigate(`/admin/products/${created.slug}`)
    } else if (existingProduct) {
      await updateProduct.mutateAsync({ id: existingProduct.id, data: form })
      setIsDirty(false)
    }
  }

  const isSaving = createProduct.isPending || updateProduct.isPending

  if (!isNew && isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  const productId = existingProduct?.id ?? 'new'
  const currency = 'GBP' // From store settings in production

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/admin/products"
            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700"
          >
            <ArrowLeft className="h-4 w-4" />
            Products
          </Link>
          <span className="text-zinc-300">/</span>
          <h1 className="text-base font-semibold text-zinc-900">
            {isNew ? 'New Product' : (form.name || 'Edit Product')}
          </h1>
          {isDirty && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              Unsaved changes
            </span>
          )}
        </div>
        <Button
          onClick={() => void handleSave()}
          disabled={isSaving || !form.name}
          className="gap-1.5"
          data-testid={tid('product', 'save')}
        >
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-4 w-4" />
              {isNew ? 'Create Product' : 'Save Changes'}
            </>
          )}
        </Button>
      </div>

      {/* Form */}
      <div className="grid grid-cols-3 gap-5">
        {/* Main column */}
        <div className="col-span-2">
          <Tabs defaultValue="general">
            <TabsList className="mb-4">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="variants">Variants</TabsTrigger>
              <TabsTrigger value="media">Media</TabsTrigger>
              <TabsTrigger value="seo">SEO</TabsTrigger>
            </TabsList>

            {/* General */}
            <TabsContent value="general" className="space-y-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-5 space-y-4">
                <div className="space-y-1.5">
                  <Label>Product Name <span className="text-red-500">*</span></Label>
                  <Input
                    value={form.name ?? ''}
                    onChange={(e) => update('name', e.target.value)}
                    placeholder="e.g. Classic White T-Shirt"
                    data-testid={tid('product', 'name')}
                    className="text-base"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>Slug</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-400 shrink-0">/products/</span>
                    <Input
                      value={form.slug ?? ''}
                      onChange={(e) => {
                        setSlugManual(true)
                        update('slug', e.target.value)
                      }}
                      placeholder="classic-white-t-shirt"
                      className="font-mono text-sm"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Description</Label>
                    {!isNew && (
                      <AiEnrichButton
                        productId={productId}
                        field="description"
                        context={{ ...(form.name ? { name: form.name } : {}), ...(form.description ? { current: form.description } : {}) }}
                        onApply={(s) => update('description', s)}
                      />
                    )}
                  </div>
                  <Textarea
                    value={form.description ?? ''}
                    onChange={(e) => update('description', e.target.value)}
                    placeholder="Describe this product..."
                    rows={5}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>Short Description</Label>
                  <Textarea
                    value={form.shortDescription ?? ''}
                    onChange={(e) => update('shortDescription', e.target.value)}
                    placeholder="Brief one-line description..."
                    rows={2}
                  />
                </div>
              </div>
            </TabsContent>

            {/* Variants */}
            <TabsContent value="variants">
              <div className="rounded-lg border border-zinc-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-zinc-900 mb-3">Variants</h3>
                <VariantTable
                  productId={productId}
                  variants={form.variants ?? []}
                  onChange={(v: Variant[]) => update('variants', v)}
                  currency={currency}
                />
              </div>
            </TabsContent>

            {/* Media */}
            <TabsContent value="media">
              <div className="rounded-lg border border-zinc-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-zinc-900 mb-3">Media</h3>
                <MediaUploader
                  media={form.media ?? []}
                  onChange={(m: ProductMedia[]) => update('media', m)}
                />
              </div>
            </TabsContent>

            {/* SEO */}
            <TabsContent value="seo" className="space-y-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-5 space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>SEO Title</Label>
                    {!isNew && (
                      <AiEnrichButton
                        productId={productId}
                        field="title"
                        context={form.name ? { name: form.name } : {}}
                        onApply={(s) => update('seoTitle', s)}
                        className="scale-90 origin-right"
                      />
                    )}
                  </div>
                  <Input
                    value={form.seoTitle ?? ''}
                    onChange={(e) => update('seoTitle', e.target.value)}
                    placeholder={form.name ?? 'SEO title...'}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>SEO Description</Label>
                    {!isNew && (
                      <AiEnrichButton
                        productId={productId}
                        field="seoDescription"
                        context={{ ...(form.name ? { name: form.name } : {}), ...(form.seoDescription ? { current: form.seoDescription } : {}) }}
                        onApply={(s) => update('seoDescription', s)}
                        className="scale-90 origin-right"
                      />
                    )}
                  </div>
                  <Textarea
                    value={form.seoDescription ?? ''}
                    onChange={(e) => update('seoDescription', e.target.value)}
                    placeholder="Meta description for search engines..."
                    rows={3}
                  />
                </div>

                <div className="pt-2 border-t border-zinc-100">
                  <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-3">Preview</p>
                  <SeoPreview
                    title={form.seoTitle || form.name || ''}
                    description={form.seoDescription || form.shortDescription || ''}
                    url={`https://yourstore.com/products/${form.slug ?? ''}`}
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Status */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Status</h3>
            <Select
              value={form.status ?? 'draft'}
              onValueChange={(v) => update('status', v as ProductStatus)}
            >
              <SelectTrigger data-testid={tid('product', 'status')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-400">
              {form.status === 'draft' && 'Not visible to customers.'}
              {form.status === 'active' && 'Visible and purchasable.'}
              {form.status === 'archived' && 'Hidden, not purchasable.'}
            </p>
          </div>

          {/* Type */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Product Type</h3>
            <Select
              value={form.type ?? 'simple'}
              onValueChange={(v) => update('type', v as 'simple' | 'variable')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">Simple</SelectItem>
                <SelectItem value="variable">Variable</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Summary */}
          {!isNew && existingProduct && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-2 text-xs text-zinc-500">
              <h3 className="font-semibold uppercase tracking-wider text-zinc-400">Summary</h3>
              <div className="flex justify-between">
                <span>Variants</span>
                <span className="font-medium text-zinc-700">{existingProduct.variants.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Total stock</span>
                <span className="font-mono font-medium text-zinc-700">
                  {existingProduct.variants.reduce((a, v) => a + v.stock, 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Media</span>
                <span className="font-medium text-zinc-700">{existingProduct.media.length}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const productEditHandle = {
  breadcrumb: (_params: Record<string, string | undefined>) => 'Edit',
}
export const productNewHandle = {
  breadcrumb: () => 'New Product',
}
