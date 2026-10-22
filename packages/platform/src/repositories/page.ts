/** One page of a walk over a table by primary key: the rows whose id is above `after`, at most `limit` of them. */
export interface KeysetPage {
  after?: string
  limit: number
}
