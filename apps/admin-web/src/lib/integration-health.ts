/**
 * The integration monitor's data (JOURNEY-065).
 *
 * One read for every outside connection the caller may see: payment gateway,
 * carriers, the warehouse ERP, buyers' ERP connections and the inspection
 * agencies' in-app portal. Shared by the Integrations page and the outage
 * banner, under one query key so the two never disagree.
 */
import { api } from './api';

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'not_configured';

export type IntegrationSourceKey = 'payments' | 'carriers' | 'warehouseErp' | 'customerErp' | 'inspection';

export interface IntegrationSource {
  key: IntegrationSourceKey;
  status: HealthStatus;
  facts: Record<string, number | string | null>;
  webhooks: { lastReceivedAt: string | null; accepted24h: number; rejected24h: number } | null;
  href: string;
}

export interface IntegrationHealth {
  generatedAt: string;
  sources: IntegrationSource[];
  outage: { active: boolean; sources: IntegrationSourceKey[] };
}

export const INTEGRATION_HEALTH_KEY = ['admin-integration-health'] as const;

export function fetchIntegrationHealth(): Promise<IntegrationHealth> {
  return api.get<IntegrationHealth>('/admin/integrations/health');
}

/** The badge tone for a status. */
export function healthTone(status: HealthStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'ok') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'down') return 'danger';
  return 'neutral';
}
