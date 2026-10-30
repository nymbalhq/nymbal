import { searchHandler } from '../handlers/side-effects/search-handler.js'
import { buildSearchDoc } from './builders.js'
import { snapshotsOf } from './catalogue.js'
import { SEARCH_INDEX, searchOf, type ReadModel } from './model.js'

export const search: ReadModel = {
  name: 'search',
  target: 'search',
  collections: [],

  async *rebuild(ctx) {
    for await (const page of ctx.pages('products', snapshotsOf(ctx.deps))) {
      for (const snapshot of page) {
        const doc = buildSearchDoc(snapshot)
        yield { collection: SEARCH_INDEX, key: doc.id, doc }
      }
    }
  },

  handlers(deps) {
    return searchHandler({ search: searchOf(deps), repos: deps.repos, logger: deps.logger })
  },
}
