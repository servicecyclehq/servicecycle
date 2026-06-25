export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ApiError {
  success: false;
  error: string;
}

export type ConditionRating = 'C1' | 'C2' | 'C3';
export type NetaDecal = 'GREEN' | 'YELLOW' | 'RED';
export type WorkOrderStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETE' | 'CANCELLED';
export type DeficiencySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type DeficiencyStatus = 'OPEN' | 'RESOLVED';
export type TelemetryStatus = 'OK' | 'WARN' | 'CRIT';
export type ArcFlashSeverity = 'danger' | 'warning';

export interface AssetSite {
  id: string;
  name: string;
}

export interface AssetPosition {
  id: string;
  name: string;
  code: string;
}

export interface Asset {
  id: string;
  equipmentType: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  installDate: string | null;
  lastCommissionedDate: string | null;
  conditionPhysical: ConditionRating | null;
  conditionCriticality: ConditionRating | null;
  conditionEnvironment: ConditionRating | null;
  governingCondition: ConditionRating | null;
  inService: boolean;
  isEnergized: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  site: AssetSite | null;
  position: AssetPosition | null;
}

export interface AssetSchedule {
  id: string;
  taskName: string;
  taskCode: string;
  standardRef: string;
  nextDueDate: string | null;
  lastCompletedDate: string | null;
  intervalDays: number | null;
}

export interface AssetDetail extends Asset {
  nameplateData: Record<string, unknown> | null;
  building: { id: string; name: string } | null;
  area: { id: string; name: string } | null;
  schedules: AssetSchedule[];
}

export interface WorkOrderAsset {
  id: string;
  equipmentType: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  site: AssetSite | null;
}

export interface WorkOrder {
  id: string;
  assetId: string;
  scheduleId: string | null;
  quoteRequestId: string | null;
  status: WorkOrderStatus;
  scheduledDate: string | null;
  startedAt: string | null;
  completedDate: string | null;
  asFoundCondition: ConditionRating | null;
  asLeftCondition: ConditionRating | null;
  netaDecal: NetaDecal | null;
  isAcceptanceTest: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  asset: WorkOrderAsset;
}

export interface Deficiency {
  id: string;
  assetId: string;
  workOrderId: string | null;
  severity: DeficiencySeverity;
  code: string | null;
  description: string;
  status: DeficiencyStatus;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  asset: {
    id: string;
    equipmentType: string;
    site: AssetSite | null;
  };
}

export interface Contractor {
  id: string;
  name: string;
  nataLevel: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  neta70eQualified: boolean;
  createdAt: string;
}

export interface ArcFlashLabel {
  assetId: string;
  busName: string | null;
  equipmentType: string | null;
  siteId: string | null;
  site: string | null;
  nominalVoltage: string | null;
  incidentEnergyCalCm2: number | null;
  arcFlashBoundaryIn: number | null;
  workingDistanceIn: number | null;
  ppeCategory: number | null;
  minArcRatingCalCm2: number | null;
  labelSeverity: ArcFlashSeverity | null;
  studyPerformedDate: string | null;
  studyExpiresAt: string | null;
  studyExpired: boolean;
  disclaimer: string;
}

export interface TelemetryChannel {
  id: string;
  assetId: string;
  key: string;
  label: string | null;
  unit: string | null;
  warnHigh: number | null;
  critHigh: number | null;
  warnLow: number | null;
  critLow: number | null;
  enabled: boolean;
  lastValue: number | null;
  lastStatus: TelemetryStatus | null;
  lastReadingAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelemetryReading {
  id: string;
  assetId: string;
  channelId: string;
  value: number;
  unit: string | null;
  status: TelemetryStatus;
  recordedAt: string;
  source: string | null;
  externalId: string | null;
  createdAt: string;
}

export interface TelemetryNotification {
  id: string;
  assetId: string;
  channelId: string;
  status: 'WARN' | 'CRIT';
  value: number;
  threshold: number;
  thresholdKind: 'critHigh' | 'critLow' | 'warnHigh' | 'warnLow';
  message: string;
  acknowledgedAt: string | null;
  autoResolved: boolean;
  createdAt: string;
}

export interface ApiKeyIdentity {
  keyId: string;
  keyName: string;
  scopes: Array<'read' | 'write'>;
  accountId: string;
  companyName: string | null;
}

export interface ListAssetsParams {
  page?: number;
  limit?: number;
  equipmentType?: string;
  siteId?: string;
  governingCondition?: ConditionRating;
  inService?: boolean;
  dueBefore?: string;
}

export interface ListWorkOrdersParams {
  page?: number;
  limit?: number;
  status?: WorkOrderStatus;
  assetId?: string;
  completedAfter?: string;
}

export interface CreateWorkOrderParams {
  assetId: string;
  scheduleId?: string;
  status?: 'SCHEDULED' | 'COMPLETE';
  completedDate?: string;
  scheduledDate?: string;
  asLeftCondition?: ConditionRating;
  netaDecal?: NetaDecal;
  notes?: string;
}

export interface ListDeficienciesParams {
  page?: number;
  limit?: number;
  status?: DeficiencyStatus;
  severity?: DeficiencySeverity;
  assetId?: string;
}

export interface ListArcFlashLabelsParams {
  page?: number;
  limit?: number;
  siteId?: string;
  severity?: ArcFlashSeverity;
}

export interface CreateArcFlashDeviceParams {
  assetId: string;
  deviceType: string;
  manufacturer?: string;
  model?: string;
  tripSetting?: string;
  notes?: string;
}

export interface UpsertTelemetryChannelParams {
  assetId: string;
  key: string;
  label?: string;
  unit?: string;
  warnHigh?: number | null;
  critHigh?: number | null;
  warnLow?: number | null;
  critLow?: number | null;
  enabled?: boolean;
}

export interface ListTelemetryReadingsParams {
  assetId?: string;
  channel?: string;
  since?: string;
  page?: number;
  limit?: number;
}

export interface TelemetryReadingInput {
  assetId: string;
  channel: string;
  value: number;
  unit?: string;
  recordedAt?: string;
  source?: string;
  externalId?: string;
}

export interface IngestTelemetryReadingsResult {
  accepted: number;
  breaches: number;
  duplicates: number;
  total: number;
  results: Array<{
    assetId: string;
    channel: string;
    accepted: boolean;
    status: TelemetryStatus;
    duplicate: boolean;
    notificationOpened: boolean;
    governingCondition: ConditionRating | null;
    error?: string;
  }>;
}

export interface ListTelemetryNotificationsParams {
  status?: 'open' | 'all';
  assetId?: string;
}

export interface PaginatedResponse<T> {
  success: true;
  data: T[];
  pagination: Pagination;
}

export interface SingleResponse<T> {
  success: true;
  data: T;
}
