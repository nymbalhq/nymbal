# @nymbalhq/search-algolia

The `algolia` search provider for Nymbal. The storefront's search, the category facet and the header's search bar run
on an Algolia index, and they return what native search returns for the same catalogue and query. It needs no Algolia
SDK.

```sh
nymbal add algolia
# or
npm install @nymbalhq/search-algolia
```

```ts
// nymbal.config.ts
commerce: {
  search: { provider: 'algolia' },
}
```

- `appId` (`ALGOLIA_APP_ID`) is the application ID.
- `apiKey` (`ALGOLIA_API_KEY`) is a key that may write the index: the Write API key, or one with `addObject`,
  `deleteObject`, `deleteIndex`, `editSettings`, `settings` and `search`. It may be left out of the config and saved
  in the admin's Settings instead. Until it is set, the store boots with search reported down and no search bar.
- `indexName` (`ALGOLIA_INDEX`) is the index, `products` by default.
- Each of them may also be set in `config`.

## Filling the index

Run `nymbal replay --to search` once to fill the index from the catalogue. Product changes keep it current after
that. A store restart does not upload the catalogue again, and neither does `nymbal seed`, so replay after seeding.

A replay writes a temporary index beside the live one and moves it over the live one, so shoppers see the old
catalogue or the new one, never a mix. For that moment your Algolia app holds the catalogue twice, so keep the
catalogue under half your plan's record quota.

## Matching

On start, the adapter sets the index's settings so Algolia matches as native search does. Every query word must be a
prefix of a word in the product's name, a variant's SKU or name, or the description. Typo tolerance, plurals and
stop words are off. Changing these settings in the Algolia dashboard changes what the store finds.

- A word is a run of ASCII letters and digits after lowercasing. Words longer than 480 characters are cut to 480.
- Algolia takes queries of up to 512 bytes. A longer query searches its first words that fit.
- Algolia refuses a record over 10 KB on the free plan. A product whose words pass that keeps the words that fit, and
  the words after them are not searchable. The store logs a warning naming the product.
- A search walks at most 1000 matches.
