import type { HttpClient } from '../http.js';
import type {
  TelemetryChannel,
  TelemetryReading,
  TelemetryNotification,
  UpsertTelemetryChannelParams,
  ListTelemetryReadingsParams,
  TelemetryReadingInput,
  IngestTelemetryReadingsResult,
  ListTelemetryNotificationsParams,
  PaginatedResponse,
  SingleResponse,
} from '../types.js';
import { paginate } from '../paginator.js';

export class TelemetryResource {
  constructor(private readonly http: HttpClient) {}

  async listChannels(params: { assetId?: string } = {}): Promise<TelemetryChannel[]> {
    const response = await this.http.get<{ success: boolean; data: TelemetryChannel[] }>(
      '/telemetry/channels',
      params as Record<string, unknown>
    );
    return response.data;
  }

  /** Create or update a telemetry channel by (assetId, key). Requires write scope. */
  async upsertChannel(params: UpsertTelemetryChannelParams): Promise<TelemetryChannel> {
    const response = await this.http.post<SingleResponse<TelemetryChannel>>('/telemetry/channels', params);
    return response.data;
  }

  async listReadings(params: ListTelemetryReadingsParams = {}): Promise<PaginatedResponse<TelemetryReading>> {
    return this.http.get<PaginatedResponse<TelemetryReading>>(
      '/telemetry/readings',
      params as Record<string, unknown>
    );
  }

  listAllReadings(params: Omit<ListTelemetryReadingsParams, 'page'> = {}): AsyncGenerator<TelemetryReading> {
    return paginate((p) => this.listReadings(p), params);
  }

  /**
   * Ingest up to 1000 readings in a single call.
   * CRIT breaches auto-escalate the asset to NFPA 70B Condition 2.
   * Requires write scope. Use idempotencyKey to make retries safe.
   */
  async ingestReadings(
    readings: TelemetryReadingInput[],
    idempotencyKey?: string
  ): Promise<IngestTelemetryReadingsResult> {
    const response = await this.http.post<SingleResponse<IngestTelemetryReadingsResult>>(
      '/telemetry/readings',
      { readings },
      idempotencyKey
    );
    return response.data;
  }

  async listNotifications(params: ListTelemetryNotificationsParams = {}): Promise<{
    data: TelemetryNotification[];
    count: number;
  }> {
    const response = await this.http.get<{ success: boolean; data: TelemetryNotification[]; count: number }>(
      '/telemetry/notifications',
      params as Record<string, unknown>
    );
    return { data: response.data, count: response.count };
  }

  /** Acknowledge a WARN/CRIT notification. Requires write scope. */
  async acknowledgeNotification(id: string): Promise<TelemetryNotification> {
    const response = await this.http.post<SingleResponse<TelemetryNotification>>(
      `/telemetry/notifications/${id}/acknowledge`
    );
    return response.data;
  }
}
