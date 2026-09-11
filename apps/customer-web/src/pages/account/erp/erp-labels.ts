/**
 * Words for the vocabulary the ERP integration uses.
 *
 * Four screens render these — the hub, the connection dashboard, the wizard and
 * the log — and a state called "Action required" on one and "Needs attention"
 * on another is two features as far as anybody reading them is concerned. So
 * the words live here, once.
 *
 * Everything is a translation KEY rather than a string. The storefront serves
 * eight languages, and an English literal in a component is a string that can
 * never be translated because nothing knows it is there.
 */
import type { TranslationKey } from '@/i18n/i18n-context';
import type {
  ErpAuthMethod,
  ErpConnectionState,
  ErpEndpointPurpose,
  ErpEnvironment,
  ErpEventState,
  ErpMappingEntity,
  ErpNetworkMode,
  ErpSystem,
  OrgRole,
} from '@/lib/customer-erp';

export const SYSTEM_LABEL: Readonly<Record<ErpSystem, TranslationKey>> = {
  SAP: 'erp.system.sap',
  MONDAY: 'erp.system.monday',
  ODOO: 'erp.system.odoo',
  CUSTOM: 'erp.system.custom',
};

export const SYSTEM_DESCRIPTION: Readonly<Record<ErpSystem, TranslationKey>> = {
  SAP: 'erp.system.sapDescription',
  MONDAY: 'erp.system.mondayDescription',
  ODOO: 'erp.system.odooDescription',
  CUSTOM: 'erp.system.customDescription',
};

export const STATE_LABEL: Readonly<Record<ErpConnectionState, TranslationKey>> = {
  DRAFT: 'erp.state.draft',
  TESTING: 'erp.state.testing',
  ACTIVE: 'erp.state.active',
  PAUSED: 'erp.state.paused',
  ACTION_REQUIRED: 'erp.state.actionRequired',
  FAILED: 'erp.state.failed',
  DISCONNECTED: 'erp.state.disconnected',
};

export const EVENT_STATE_LABEL: Readonly<Record<ErpEventState, TranslationKey>> = {
  QUEUED: 'erp.eventState.queued',
  PROCESSING: 'erp.eventState.processing',
  SUCCEEDED: 'erp.eventState.succeeded',
  RETRYING: 'erp.eventState.retrying',
  FAILED: 'erp.eventState.failed',
  SKIPPED: 'erp.eventState.skipped',
};

export const ENVIRONMENT_LABEL: Readonly<Record<ErpEnvironment, TranslationKey>> = {
  SANDBOX: 'erp.environment.sandbox',
  PRODUCTION: 'erp.environment.production',
};

export const AUTH_LABEL: Readonly<Record<ErpAuthMethod, TranslationKey>> = {
  OAUTH2_CLIENT_CREDENTIALS: 'erp.auth.clientCredentials',
  OAUTH2_AUTHORIZATION_CODE: 'erp.auth.authorizationCode',
  API_KEY: 'erp.auth.apiKey',
  BEARER_TOKEN: 'erp.auth.bearerToken',
  BASIC: 'erp.auth.basic',
  MONDAY_PERSONAL_TOKEN: 'erp.auth.mondayPersonalToken',
};

/**
 * What each method costs, said plainly beside the choice.
 *
 * A buyer picking an authentication method is making a security decision on
 * behalf of their own company, usually without being told they are. The
 * difference between a client-credentials grant and a username and password is
 * not obvious from the names, so it is written down next to them.
 */
export const AUTH_NOTE: Readonly<Record<ErpAuthMethod, TranslationKey>> = {
  OAUTH2_CLIENT_CREDENTIALS: 'erp.auth.clientCredentialsNote',
  OAUTH2_AUTHORIZATION_CODE: 'erp.auth.authorizationCodeNote',
  API_KEY: 'erp.auth.apiKeyNote',
  BEARER_TOKEN: 'erp.auth.bearerTokenNote',
  BASIC: 'erp.auth.basicNote',
  MONDAY_PERSONAL_TOKEN: 'erp.auth.mondayPersonalTokenNote',
};

export const NETWORK_LABEL: Readonly<Record<ErpNetworkMode, TranslationKey>> = {
  PUBLIC_HTTPS: 'erp.network.publicHttps',
  IP_ALLOWLIST: 'erp.network.ipAllowlist',
  VPN_GATEWAY: 'erp.network.vpnGateway',
  SAP_CLOUD_CONNECTOR: 'erp.network.sapCloudConnector',
};

export const NETWORK_NOTE: Readonly<Record<ErpNetworkMode, TranslationKey>> = {
  PUBLIC_HTTPS: 'erp.network.publicHttpsNote',
  IP_ALLOWLIST: 'erp.network.ipAllowlistNote',
  VPN_GATEWAY: 'erp.network.vpnGatewayNote',
  SAP_CLOUD_CONNECTOR: 'erp.network.sapCloudConnectorNote',
};

export const ENDPOINT_LABEL: Readonly<Record<ErpEndpointPurpose, TranslationKey>> = {
  PRODUCTS: 'erp.endpoint.products',
  WAREHOUSES: 'erp.endpoint.warehouses',
  INVENTORY: 'erp.endpoint.inventory',
  PURCHASE_ORDER_CREATE: 'erp.endpoint.purchaseOrderCreate',
  PURCHASE_ORDER_UPDATE: 'erp.endpoint.purchaseOrderUpdate',
  GOODS_RECEIPT: 'erp.endpoint.goodsReceipt',
  SHIPMENT_STATUS: 'erp.endpoint.shipmentStatus',
  INVOICE: 'erp.endpoint.invoice',
  PAYMENT_REFERENCE: 'erp.endpoint.paymentReference',
  WEBHOOK: 'erp.endpoint.webhook',
};

export const ENTITY_LABEL: Readonly<Record<ErpMappingEntity, TranslationKey>> = {
  PRODUCT: 'erp.entity.product',
  WAREHOUSE: 'erp.entity.warehouse',
  ORDER: 'erp.entity.order',
  INVENTORY: 'erp.entity.inventory',
  INVOICE: 'erp.entity.invoice',
  PAYMENT: 'erp.entity.payment',
  STATUS: 'erp.entity.status',
};

export const ROLE_LABEL: Readonly<Record<OrgRole, TranslationKey>> = {
  OWNER: 'erp.role.owner',
  INTEGRATION_MANAGER: 'erp.role.integrationManager',
  MEMBER: 'erp.role.member',
};

export const ROLE_NOTE: Readonly<Record<OrgRole, TranslationKey>> = {
  OWNER: 'erp.role.ownerNote',
  INTEGRATION_MANAGER: 'erp.role.integrationManagerNote',
  MEMBER: 'erp.role.memberNote',
};

/**
 * The event types the log shows.
 *
 * A `Partial` record and a fallback rather than an exhaustive one: the server's
 * list can grow, and a log row reading the raw `PURCHASE_ORDER_CREATE` is
 * ugly but honest, where a crash on an unrecognised type would lose the whole
 * page.
 */
export const EVENT_TYPE_LABEL: Readonly<Partial<Record<string, TranslationKey>>> = {
  CONNECTION_TEST: 'erp.eventType.connectionTest',
  DRY_RUN: 'erp.eventType.dryRun',
  PURCHASE_ORDER_CREATE: 'erp.eventType.purchaseOrderCreate',
  PURCHASE_ORDER_UPDATE: 'erp.eventType.purchaseOrderUpdate',
  SHIPMENT_STATUS: 'erp.eventType.shipmentStatus',
  GOODS_RECEIPT: 'erp.eventType.goodsReceipt',
  INVENTORY_UPDATE: 'erp.eventType.inventoryUpdate',
  INVOICE_SYNC: 'erp.eventType.invoiceSync',
  PAYMENT_REFERENCE: 'erp.eventType.paymentReference',
  INBOUND_POLL: 'erp.eventType.inboundPoll',
  INBOUND_WEBHOOK: 'erp.eventType.inboundWebhook',
};

/**
 * Which authentication methods need which secret fields.
 *
 * The wizard shows only the fields the chosen method actually uses - a form
 * offering a username, a password, a client secret, an API key and a personal
 * token at once is a form nobody can fill in correctly.
 */
export function secretFieldsFor(method: ErpAuthMethod): readonly string[] {
  switch (method) {
    case 'API_KEY':
      return ['apiKey'];
    case 'BEARER_TOKEN':
      return ['bearerToken'];
    case 'BASIC':
      return ['username', 'password'];
    case 'OAUTH2_CLIENT_CREDENTIALS':
      return ['clientId', 'clientSecret'];
    case 'OAUTH2_AUTHORIZATION_CODE':
      // A monday production connection uses the operator's registered app, so
      // the buyer types nothing at all. The wizard hides these when
      // `oauthUsesPlatformApp` comes back true.
      return ['clientId', 'clientSecret'];
    case 'MONDAY_PERSONAL_TOKEN':
      return ['personalToken'];
  }
}

/** Whether this method sends the buyer to their own ERP to authorise. */
export function isInteractiveOAuth(method: ErpAuthMethod): boolean {
  return method === 'OAUTH2_AUTHORIZATION_CODE';
}

/** Whether the SAP organisational keys are relevant. */
export function needsSapPlacement(system: ErpSystem): boolean {
  return system === 'SAP';
}

export function needsMondayPlacement(system: ErpSystem): boolean {
  return system === 'MONDAY';
}
