/**
 * Paginated fetch for history tables that can outgrow PostgREST's 1,000-row
 * response cap (the CollectionsPage pattern, shared).
 *
 * `makeQuery` receives the [from, to] row window for each page and must
 * return the query with `.range(from, to)` applied LAST (after select /
 * filters / order). Pages of 1,000 rows are requested until a short page
 * comes back, so the query MUST have a stable `.order(...)` — ideally a
 * unique column or a (date, created_at) pair — or rows can repeat / vanish
 * between pages.
 */

export const PAGE_SIZE = 1000

interface PageResult {
  data: unknown
  error: { message: string } | null
}

export async function fetchAll<T>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await makeQuery(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return out
}
