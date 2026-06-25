import type { Pagination } from './types.js';

export interface PageResult<T> {
  data: T[];
  pagination: Pagination;
}

export type PageFetcher<T, P> = (params: P & { page: number; limit: number }) => Promise<PageResult<T>>;

/**
 * Async generator that automatically fetches subsequent pages.
 *
 * @example
 * for await (const asset of client.assets.listAll({ limit: 100 })) {
 *   console.log(asset.id);
 * }
 */
export async function* paginate<T, P extends { page?: number; limit?: number }>(
  fetcher: PageFetcher<T, P>,
  params: P
): AsyncGenerator<T> {
  let page = params.page ?? 1;
  const limit = params.limit ?? 50;

  while (true) {
    const result = await fetcher({ ...params, page, limit });
    for (const item of result.data) {
      yield item;
    }
    if (page >= result.pagination.pages) break;
    page++;
  }
}
