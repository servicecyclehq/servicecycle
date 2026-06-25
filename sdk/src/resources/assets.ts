import type { HttpClient } from '../http.js';
import type {
  Asset,
  AssetDetail,
  ListAssetsParams,
  PaginatedResponse,
  SingleResponse,
} from '../types.js';
import { paginate } from '../paginator.js';

export class AssetsResource {
  constructor(private readonly http: HttpClient) {}

  async list(params: ListAssetsParams = {}): Promise<PaginatedResponse<Asset>> {
    return this.http.get<PaginatedResponse<Asset>>('/assets', params as Record<string, unknown>);
  }

  async get(id: string): Promise<AssetDetail> {
    const response = await this.http.get<SingleResponse<AssetDetail>>(`/assets/${id}`);
    return response.data;
  }

  /** Auto-paginating async iterator over all assets. */
  listAll(params: Omit<ListAssetsParams, 'page'> = {}): AsyncGenerator<Asset> {
    return paginate((p) => this.list(p), params);
  }
}
