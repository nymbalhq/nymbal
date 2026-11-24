import { useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, FolderTree, Plus } from 'lucide-react'
import type { Category } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/common/EmptyState'
import {
  reorderIntent,
  useCategories,
  useCreateCategory,
  useDeleteCategory,
  useReorderCategories,
  useUpdateCategory,
  type DeletedCategory,
  type NewCategory,
} from '@/hooks/useCategories'
import { refusalOf } from '@/lib/api'
import { categoryTree, type TreeRow } from '@/lib/category-tree'
import { firstClick } from '@/lib/first-click'
import { slugify } from '@/lib/slug'
import { tid } from '@/lib/testid'

/** The server's slug limit; a cut that ends on a hyphen loses it, as the server refuses one there. */
const SLUG_MAX = 80

function slugOf(name: string): string {
  return slugify(name).slice(0, SLUG_MAX).replace(/-$/, '')
}

/** The rows a category may sit under: every row but `editing` and its descendants. */
function parentChoices(rows: readonly TreeRow[], editing: Category | null): TreeRow[] {
  if (editing === null) return [...rows]
  const at = rows.findIndex((r) => r.category.id === editing.id)
  if (at === -1) return [...rows]
  let end = at + 1
  while (end < rows.length && rows[end]!.depth > rows[at]!.depth) end += 1
  return [...rows.slice(0, at), ...rows.slice(end)]
}

interface CategoryDialogProps {
  editing: Category | null
  rows: readonly TreeRow[]
  saving: boolean
  /** Sends the fields; null when a save of this category is already open. */
  onSave: (fields: NewCategory) => Promise<unknown> | null
  onSaved: (name: string) => void
  onClose: () => void
}

function CategoryDialog({ editing, rows, saving, onSave, onSaved, onClose }: CategoryDialogProps) {
  const [name, setName] = useState(editing?.name ?? '')
  const [slug, setSlug] = useState(editing?.slug ?? '')
  const [slugEdited, setSlugEdited] = useState(false)
  const [description, setDescription] = useState(editing?.description ?? '')
  const [parentId, setParentId] = useState(editing?.parentId ?? '')
  const [error, setError] = useState<string | null>(null)
  const choices = parentChoices(rows, editing)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const fields = { slug, name: name.trim(), description, parentId: parentId || null }
    const sent = onSave(fields)
    if (sent === null) return
    try {
      await sent
      onSaved(fields.name)
    } catch (err) {
      setError(refusalOf(err, 'The category could not be saved.'))
    }
  }

  return (
    // While a save is open the dialog stays: its answer, a refusal included, is said here.
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-md" data-testid={tid('category', 'dialog')}>
        <DialogHeader>
          <DialogTitle className="break-all leading-snug">
            {editing === null ? 'New category' : `Edit ${editing.name}`}
          </DialogTitle>
        </DialogHeader>
        <form className="min-w-0 space-y-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="category-name">Name</Label>
            <Input
              id="category-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (editing === null && !slugEdited) setSlug(slugOf(e.target.value))
              }}
              autoComplete="off"
              data-testid={tid('category', 'name')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-slug">Slug</Label>
            {editing === null ? (
              <Input
                id="category-slug"
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true)
                  setSlug(e.target.value)
                }}
                autoComplete="off"
                className="font-mono text-sm"
                data-testid={tid('category', 'slug')}
              />
            ) : (
              <p
                id="category-slug"
                className="break-all font-mono text-sm text-zinc-600"
                data-testid={tid('category', 'slug')}
              >
                {slug}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-description">Description (optional)</Label>
            <Textarea
              id="category-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid={tid('category', 'description')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category-parent">Parent</Label>
            <select
              id="category-parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="h-9 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-sm"
              data-testid={tid('category', 'parent')}
            >
              <option value="">None</option>
              {choices.map(({ category, depth }) => (
                <option key={category.id} value={category.id}>
                  {'— '.repeat(depth)}
                  {category.name}
                </option>
              ))}
            </select>
          </div>
          {error !== null && (
            <p
              role="alert"
              className="break-all text-sm text-red-600"
              data-testid={tid('category', 'error')}
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" type="button" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              onClick={firstClick()}
              data-testid={tid('category', 'save')}
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The store's categories as a tree: made, renamed, moved, reordered and deleted here. */
export function CategoriesPage() {
  const { data: categories, isLoading, isError } = useCategories()
  const { create, creating } = useCreateCategory()
  const { update, updating } = useUpdateCategory()
  const { remove, deleting } = useDeleteCategory()
  const { reorder, reordering } = useReorderCategories()
  // null: closed; 'new'; or the category being edited.
  const [dialog, setDialog] = useState<Category | 'new' | null>(null)
  const [confirming, setConfirming] = useState<Category | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const report = async <T,>(
    sent: Promise<T> | null,
    done: (answer: T) => string,
    failed: string,
  ) => {
    if (sent === null) return
    // The last outcome stays until this one is known: clearing it now would move the list under a second click.
    try {
      const answer = await sent
      setError(null)
      setResult(done(answer))
    } catch (err) {
      setResult(null)
      setError(refusalOf(err, failed))
    }
  }

  const list = categories ?? []
  const rows = categoryTree(list)
  const siblingsOf = (c: Category) => list.filter((s) => s.parentId === c.parentId)

  const move = (c: Category, by: -1 | 1) => {
    const ids = siblingsOf(c).map((s) => s.id)
    const at = ids.indexOf(c.id)
    ;[ids[at], ids[at + by]] = [ids[at + by]!, ids[at]!]
    void report(
      reorder(c.parentId, ids),
      () => `Moved ${c.name}`,
      'The category could not be moved.',
    )
  }

  const confirmDelete = (c: Category) => {
    const sent = remove(c.id)
    setConfirming(null)
    void report(
      sent,
      (answer: DeletedCategory) =>
        `Deleted ${c.name}: ${answer.detachedProducts} products left it, ${answer.movedChildren} subcategories moved up`,
      'The category could not be deleted.',
    )
  }

  const editing = dialog === 'new' ? null : dialog

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Categories</h1>
          <p className="text-sm text-zinc-500">How the storefront groups its products.</p>
        </div>
        <Button
          disabled={isLoading}
          onClick={firstClick(() => setDialog('new'))}
          data-testid={tid('categories', 'new')}
        >
          <Plus className="mr-1 h-4 w-4" />
          New category
        </Button>
      </div>

      {/* One line kept whether or not there is an outcome, so the rows never move under the pointer. */}
      <div className="min-h-5">
        {result !== null && (
          <p
            role="status"
            className="break-all text-sm text-zinc-600"
            data-testid={tid('categories', 'result')}
          >
            {result}
          </p>
        )}
        {error !== null && (
          <p
            role="alert"
            className="break-all text-sm text-red-600"
            data-testid={tid('categories', 'error')}
          >
            {error}
          </p>
        )}
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            icon={<FolderTree className="h-5 w-5" />}
            title="The categories could not be loaded"
          />
        ) : rows.length === 0 ? (
          <EmptyState icon={<FolderTree className="h-5 w-5" />} title="No categories yet." />
        ) : (
          <ul className="divide-y divide-zinc-100">
            {rows.map(({ category: c, depth }) => {
              const siblings = siblingsOf(c)
              const moving = reordering.has(reorderIntent(c.parentId))
              const busy = updating.has(c.id) || deleting.has(c.id)
              return (
                <li
                  key={c.id}
                  data-testid={tid('categories', 'row', c.id)}
                  data-depth={depth}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                  style={{ paddingLeft: `${1 + depth * 1.5}rem` }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-sm font-medium text-zinc-900">{c.name}</p>
                    <p className="break-all font-mono text-xs text-zinc-500">{c.slug}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Move ${c.name} up`}
                      disabled={moving || busy || siblings[0]?.id === c.id}
                      onClick={firstClick(() => move(c, -1))}
                      data-testid={tid('categories', 'up', c.id)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Move ${c.name} down`}
                      disabled={moving || busy || siblings.at(-1)?.id === c.id}
                      onClick={firstClick(() => move(c, 1))}
                      data-testid={tid('categories', 'down', c.id)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={firstClick(() => setDialog(c))}
                      data-testid={tid('categories', 'edit', c.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={firstClick(() => setConfirming(c))}
                      data-testid={tid('categories', 'delete', c.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {dialog !== null && (
        <CategoryDialog
          editing={editing}
          rows={rows}
          saving={editing === null ? creating : updating.has(editing.id)}
          onSave={(fields) =>
            editing === null
              ? create(fields)
              : update(editing.id, {
                  name: fields.name,
                  description: fields.description,
                  parentId: fields.parentId,
                })
          }
          onSaved={(name) => {
            setDialog(null)
            setError(null)
            setResult(`${editing === null ? 'Created' : 'Saved'} ${name}`)
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {confirming !== null && (
        <Dialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <DialogContent className="max-w-sm" data-testid={tid('category', 'delete-dialog')}>
            <DialogHeader>
              <DialogTitle className="break-all leading-snug">
                Delete {confirming.name}?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-zinc-600">
              Its products stay in the store and leave this category. Its subcategories move up one
              level.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={firstClick(() => confirmDelete(confirming))}
                data-testid={tid('category', 'delete-confirm')}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export const categoriesHandle = { breadcrumb: () => 'Categories' }
