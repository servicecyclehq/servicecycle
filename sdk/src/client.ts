import { HttpClient } from './http.js';
import { IdentityResource } from './resources/identity.js';
import { AssetsResource } from './resources/assets.js';
import { ContractorsResource } from './resources/contractors.js';
import { WorkOrdersResource } from './resources/workorders.js';
import { DeficienciesResource } from './resources/deficiencies.js';
import { ArcFlashResource } from './resources/arcflash.js';
import { TelemetryResource } from './resources/telemetry.js';

export interface ServiceCycleClientOptions {
  /** API key starting with sc_. Issued in Settings → API Keys. */
  apiKey: string;
  /**
   * Base URL of the ServiceCycle API.
   * @default "https://servicecycle.app/api/v1"
   */
  baseUrl?: string;
  /**
   * Maximum number of automatic retries on 429 responses.
   * @default 3
   */
  maxRetries?: number;
}

export class ServiceCycleClient {
  readonly identity: IdentityResource;
  readonly assets: AssetsResource;
  readonly contractors: ContractorsResource;
  readonly workOrders: WorkOrdersResource;
  readonly deficiencies: DeficienciesResource;
  readonly arcFlash: ArcFlashResource;
  readonly telemetry: TelemetryResource;

  constructor(options: ServiceCycleClientOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');

    const http = new HttpClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? 'https://servicecycle.app/api/v1',
      maxRetries: options.maxRetries,
    });

    this.identity = new IdentityResource(http);
    this.assets = new AssetsResource(http);
    this.contractors = new ContractorsResource(http);
    this.workOrders = new WorkOrdersResource(http);
    this.deficiencies = new DeficienciesResource(http);
    this.arcFlash = new ArcFlashResource(http);
    this.telemetry = new TelemetryResource(http);
  }
}
