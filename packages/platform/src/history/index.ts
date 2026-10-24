export { subjectOf, type EventSubject } from './subject.js'
export {
  foldHistory,
  isBaseEvent,
  isDeleted,
  startFold,
  type DeletedView,
  type Fold,
  type Folded,
  type HistoryView,
} from './fold.js'
export { diffViews } from './diff.js'
export {
  toCustomerAsOf,
  toCustomerSnapshot,
  toOrderAsOf,
  toProductAsOf,
  type AdminCustomerRead,
  type AdminOrderRead,
  type CustomerAsOf,
  type OrderAsOf,
  type ProductAsOf,
} from './views.js'
export {
  createHistoryReader,
  type AsOfOutcome,
  type HistoryReader,
  type HistoryReaderDeps,
  type HistorySubject,
} from './read.js'
