export {
  createPlatform,
  resolvePrimitives,
  REDIS_DEFAULTS,
  type Platform,
  type CreatePlatformOptions,
  type PlatformConnectionOptions,
  type Primitives,
  type ResolvePrimitivesOptions,
} from './platform.js'
export {
  createCommandStore,
  rawClients,
  sqliteFile,
  type CommandStore,
  type CommandStoreOptions,
  type ReadTx,
  type Tx,
  type RawClients,
  type StoreRepository,
  type SqliteClient,
  type PostgresClient,
} from './db/command-store.js'
export {
  migrationState,
  runMigrations,
  type MigrateOptions,
  type MigrationState,
} from './db/migrate.js'
// Legacy thin repositories (kept for seed + existing consumers).
export {
  createProductRepository as createLegacyProductRepository,
  type ProductInsert as LegacyProductInsert,
  type ProductRow as LegacyProductRow,
} from './db/repositories/products.js'
export {
  createCategoryRepository as createLegacyCategoryRepository,
  type CategoryInsert as LegacyCategoryInsert,
  type CategoryRow as LegacyCategoryRow,
} from './db/repositories/categories.js'
// Full repositories.
export * from './repositories/index.js'
export {
  InMemoryDocumentStore,
  type InMemoryDocumentStoreOptions,
} from './document-store/in-memory.js'
export { InProcessEventBus, type InProcessEventBusOptions } from './event-bus/in-process.js'
export {
  createEventBuilder,
  type EventBuilderContext,
  type MakeEventOptions,
} from './events/builder.js'
export {
  createEventPublisher,
  type EventPublisher,
  type PublishOptions,
  type CreatePublisherOptions,
} from './events/publisher.js'
export { createRelay, type Relay, type CreateRelayOptions } from './events/relay.js'
export {
  currentCorrelationId,
  isValidCorrelationId,
  newCorrelationId,
  runWithCorrelation,
} from './events/correlation.js'
export { actorOf, currentActor, runAsActor, type Actor } from './audit/actor.js'
export { audit, auditedCommand } from './audit/audit.js'
export { withIdempotency, type IdempotencyOptions } from './handlers/idempotency.js'
export { registerHandlers, type RegisterHandlersDeps } from './handlers/register.js'
export {
  registerAlertHandler,
  type RegisterAlertHandlerDeps,
} from './handlers/side-effects/alert-handler.js'
export { registerAllRoutes, type RegisterAllRoutesDeps } from './routes/register.js'
export { registerAlertRoutes, type RegisterAlertRoutesDeps } from './routes/alerts.js'
export { routeSchemas, type RouteSchema } from './routes/schemas.js'
export {
  createApp,
  type NymbalApp,
  type CreateAppOptions,
  type AttachHttpOptions,
  type CapabilitiesReport,
  type CapabilitySlot,
  type SlotCapabilities,
} from './app.js'
export { resolveAuthSecret, type AuthSecret } from './auth-secret.js'
export { registerAdminStaticRoute } from './routes/admin-static.js'
export {
  startInventoryReservationSweeper,
  startCartAbandonmentSweeper,
  startEventRetentionSweeper,
  type SweeperHandle,
  type EventArchiveWriter,
  type EventRetentionSweeperDeps,
} from './sweepers/index.js'
export * from './services/index.js'
export * from './adapters/index.js'
export { createLogger, type CreateLoggerOptions } from './logger.js'
export {
  diagnose,
  type DiagnoseOptions,
  type DiagnosisCheck,
  type DiagnosisReport,
  type DiagnosisStatus,
} from './diagnose.js'
export { runSeed, type SeedDeps, type SeedResult } from './seed/run.js'
export {
  decrypt,
  encrypt,
  keyId,
  keyProblem,
  readSecretsKey,
  settingAad,
  SECRETS_KEY_ENV,
  SECRETS_KEY_OLD_ENV,
  type EncryptedValue,
  type SecretsKey,
  type StoredCipher,
} from './settings/crypto.js'
export { fillFromSettings, type SettingSource, type SettingValue } from './settings/resolve.js'
export { scrub } from './settings/secret-set.js'
export { isMissingSettingsTable } from './settings/load.js'
export {
  CATCH_UP_MARGIN_MS,
  diffReadModel,
  READ_MODEL_NAMES,
  READ_MODELS,
  rebuild,
  RebuildError,
  type CatchUpFailure,
  type CollectionDiff,
  type ReadModel,
  type ReadModelDiff,
  type ReadModelName,
  type RebuildDeps,
  type RebuildReport,
  type RebuildReportEntry,
} from './read-models/index.js'
export { openReadModels, type OpenReadModelsOptions } from './read-models/open.js'
export { seedCategories, seedProducts, type SeedCategory, type SeedProduct } from './seed/data.js'
export {
  createLocalFsMediaStorage,
  LOCAL_FS_MEDIA_CAPABILITIES,
  type MediaStorage,
  type LocalFsMediaStorageOptions,
} from './media/index.js'
