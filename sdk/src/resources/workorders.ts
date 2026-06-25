import type { HttpClient } from '../http.js';
import type {
  WorkOrder,
  ListWorkOrdersParams,
  CreateWorkOrderParams,
  PaginatedResponse,
  SingleResponse,
} from '../types.js';
import { paginate } from '../paginator.js';

export class WorkOrdersResource {
  constructor(private readonly http: HttpClient) {}

  async list(params: ListWorkOrdersParams = {}): Promise<PaginatedResponse<WorkOrder>> {
    return this.http.get<PaginatedResponse<WorkOrder>>('/work-orders', params as Record<string, unknown>);
  }

  async get(id: string): Promise<WorkOrder> {
    const response = await this.http.get<SingleResponse<WorkOrder>>(`/work-orders/${id}`);
    return response.data;
  }

  /** Create a work order. Requires write scope. */
  async create(params: CreateWorkOrderParams, idempotencyKey?: string): Promise<WorkOrder> {
    const response = await this.http.post<SingleResponse<WorkOrder>>('/work-orders', params, idempotencyKey);
    return response.data;
  }

  listAll(params: Omit<ListWorkOrdersParams, 'page'> = {}): AsyncGenerator<WorkOrder> {
    return paginate((p) => this.list(p), params);
  }
}
