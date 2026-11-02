import { searchHandler } from '../handlers/side-effects/search-handler.js'
import { buildSearchDoc, listedSnapshot } from './builders.js'
import { snapshotsOf } from './catalogue.js'
import { SEARCH_INDEX, searchOf, type ReadModel } from './model.js'

export const search: ReadModel = {
  name: 'search',
  target: 'search',
  collections: [],

  async *rebuild(ctx) {
    for await (const page of ctx.pages('products', snapshotsOf(ctx.deps))) {
      for (const snapshot of page) {
        const listed = listedSnapshot(snapshot)
        if (!listed) continue
        const doc = buildSearchDoc(listed)
        yield { collection: SEARCH_INDEX, key: doc.id, doc }
      }
    }
  },

  handlers(deps) {
    return searchHandler({ search: searchOf(deps), repos: deps.repos, logger: deps.logger })
  },
}
