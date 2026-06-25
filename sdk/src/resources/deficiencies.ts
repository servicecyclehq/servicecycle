import type { HttpClient } from '../http.js';
import type {
  Deficiency,
  ListDeficienciesParams,
  PaginatedResponse,
  SingleResponse,
} from '../types.js';
import { paginate } from '../paginator.js';

export class DeficienciesResource {
  constructor(private readonly http: HttpClient) {}

  async list(params: ListDeficienciesParams = {}): Promise<PaginatedResponse<Deficiency>> {
    return this.http.get<PaginatedResponse<Deficiency>>('/deficiencies', params as Record<string, unknown>);
  }

  async get(id: string): Promise<Deficiency> {
    const response = await this.http.get<SingleResponse<Deficiency>>(`/deficiencies/${id}`);
    return response.data;
  }

  listAll(params: Omit<ListDeficienciesParams, 'page'> = {}): AsyncGenerator<Deficiency> {
    return paginate((p) => this.list(p), params);
  }
}
