/**
 * The permission keys, as the portal knows them.
 *
 * Mirrors `domain/logistics-permissions.ts` in the backend. This copy is a
 * COURTESY, not a control: the server checks every one of these on every
 * request, and what this file buys is a screen that says "you do not have
 * access to this" instead of rendering a page of failed panels.
 *
 * Hiding a button is not security. Every one of them is behind a server-side
 * check as well, and that check is the one that matters.
 */
export const Permission = {
  ORGANISATION_READ: 'logistics.organisation.read',
  ORGANISATION_WRITE: 'logistics.organisation.write',

  MEMBER_READ: 'logistics.member.read',
  MEMBER_WRITE: 'logistics.member.write',

  SHIPMENT_READ: 'logistics.shipment.read',
  SHIPMENT_ACCEPT: 'logistics.shipment.accept',
  SHIPMENT_STATUS_WRITE: 'logistics.shipment.status.write',
  SHIPMENT_EXCEPTION_WRITE: 'logistics.shipment.exception.write',
  SHIPMENT_EXPORT: 'logistics.shipment.export',

  DOCUMENT_READ: 'logistics.document.read',
  DOCUMENT_WRITE: 'logistics.document.write',
  POD_WRITE: 'logistics.pod.write',

  PICKUP_READ: 'logistics.pickup.read',
  PICKUP_WRITE: 'logistics.pickup.write',
  DISPATCH_READ: 'logistics.dispatch.read',
  DISPATCH_WRITE: 'logistics.dispatch.write',

  DRIVER_READ: 'logistics.driver.read',
  DRIVER_WRITE: 'logistics.driver.write',
  DRIVER_ASSIGN: 'logistics.driver.assign',
  VEHICLE_READ: 'logistics.vehicle.read',
  VEHICLE_WRITE: 'logistics.vehicle.write',

  DRIVER_TASK_READ: 'logistics.driver.task.read',
  TRIP_WRITE: 'logistics.trip.write',
  TRIP_LOCATION_READ: 'logistics.trip.location.read',

  COMPANY_READ: 'logistics.company.read',

  ANALYTICS_READ: 'logistics.analytics.read',
  AUDIT_READ: 'logistics.audit.read',
  INTEGRATION_READ: 'logistics.integration.read',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

/** Does this person hold every key in the list? */
export function holdsAll(held: readonly string[], required: readonly PermissionKey[]): boolean {
  return required.every((key) => held.includes(key));
}

/**
 * Does this person hold at least one of them?
 *
 * An empty list means "no permission required", which is how a screen every
 * member of the company may open - the boot response, the notification feed -
 * is expressed without a special case.
 */
export function holdsAny(held: readonly string[], required: readonly PermissionKey[]): boolean {
  return required.length === 0 || required.some((key) => held.includes(key));
}
