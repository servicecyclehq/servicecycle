import type { HttpClient } from '../http.js';
import type { Contractor, PaginatedResponse, SingleResponse } from '../types.js';
import { paginate } from '../paginator.js';

export interface ListContractorsParams {
  page?: number;
  limit?: number;
}

export class ContractorsResource {
  constructor(private readonly http: HttpClient) {}

  async list(params: ListContractorsParams = {}): Promise<PaginatedResponse<Contractor>> {
    return this.http.get<PaginatedResponse<Contractor>>('/contractors', params as Record<string, unknown>);
  }

  async get(id: string): Promise<Contractor> {
    const response = await this.http.get<SingleResponse<Contractor>>(`/contractors/${id}`);
    return response.data;
  }

  listAll(params: Omit<ListContractorsParams, 'page'> = {}): AsyncGenerator<Contractor> {
    return paginate((p) => this.list(p), params);
  }
}
