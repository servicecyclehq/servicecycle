import type { HttpClient } from '../http.js';
import type {
  ArcFlashLabel,
  ListArcFlashLabelsParams,
  CreateArcFlashDeviceParams,
  PaginatedResponse,
  SingleResponse, // used by createDevice
} from '../types.js';
import { paginate } from '../paginator.js';

export interface ArcFlashOneLine {
  site: { id: string; name: string };
  svg: string;
  nodes: unknown[];
  edges: unknown[];
}

export interface WorkOrderPrecheck {
  assetId: string;
  canIssue: boolean;
  reasons: string[];
  hazard: ArcFlashLabel | null;
  study: object | null;
  disclaimer?: string;
}

export class ArcFlashResource {
  constructor(private readonly http: HttpClient) {}

  async listLabels(params: ListArcFlashLabelsParams = {}): Promise<PaginatedResponse<ArcFlashLabel>> {
    return this.http.get<PaginatedResponse<ArcFlashLabel>>('/arc-flash/labels', params as Record<string, unknown>);
  }

  listAllLabels(params: Omit<ListArcFlashLabelsParams, 'page'> = {}): AsyncGenerator<ArcFlashLabel> {
    return paginate((p) => this.listLabels(p), params);
  }

  /** Returns the power-path topology for a site as SVG + node/edge graph. */
  async getOneLine(siteId: string): Promise<ArcFlashOneLine> {
    return this.http.get<ArcFlashOneLine>('/arc-flash/one-line', { siteId });
  }

  /**
   * Check whether a work order can be issued on an energized asset.
   * Block the work order when canIssue is false (study missing, expired, or superseded).
   */
  async workOrderPrecheck(assetId: string): Promise<WorkOrderPrecheck> {
    const response = await this.http.get<{ success: boolean } & WorkOrderPrecheck>(
      '/arc-flash/work-order-precheck',
      { assetId }
    );
    return { assetId: response.assetId, canIssue: response.canIssue, reasons: response.reasons, hazard: response.hazard, study: response.study, disclaimer: response.disclaimer };
  }

  /** Write verified protective-device settings back. Requires write scope. */
  async createDevice(params: CreateArcFlashDeviceParams, idempotencyKey?: string): Promise<unknown> {
    const response = await this.http.post<SingleResponse<unknown>>('/arc-flash/devices', params, idempotencyKey);
    return response.data;
  }
}
