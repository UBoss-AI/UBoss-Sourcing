/**
 * The logistics portal's own routes: who am I, the dashboard, the shipments.
 *
 * Three things every route in this file has in common, and they are the whole
 * security story:
 *
 *   1. **No route takes a partner id.** Not in a path, not in a query, not in
 *      a body. `requireLogistics` resolves the caller's company from the
 *      session and the services filter on it. Cross-tenant access is not
 *      expressible here, rather than being checked for.
 *   2. **Every route declares the narrowest permission that covers it**, so a
 *      read-only tracking viewer reading a timeline cannot reach the status
 *      update two routes below it.
 *   3. **The three routes that work before MFA use `requireLogisticsSession`**
 *      rather than `requireLogistics`. They are `/auth/me`, `/auth/mfa/*` and
 *      `/auth/logout`, and nothing else should ever use that guard - a route
 *      that does is a route reachable with one factor.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildInsight } from '../../modules/assistant/insights.service.js';
import { logisticsInsightMetrics } from '../../modules/logistics/dashboard.service.js';
import {
  INSIGHT_RATE_LIMIT,
  assertUsableWindow,
  insightBody,
  streamInsightResponse,
} from './dashboard-insights.js';
import { env } from '../../config/env.js';
import { ShipmentStatusValues } from '../../domain/logistics-shipment-state.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { prisma } from '../../infra/prisma.js';
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  mfaIssuerName,
  readMfaState,
  verifyMfaChallenge,
} from '../../modules/logistics/mfa.service.js';
import { listCompanies, readDashboard } from '../../modules/logistics/dashboard.service.js';
import {
  listLogisticsNotifications,
  markLogisticsNotificationsRead,
} from '../../modules/logistics/notification.service.js';
import {
  acceptAssignment,
  rejectAssignment,
} from '../../modules/logistics/assignment.service.js';
import {
  createDocumentLink,
  listShipmentDocuments,
  uploadShipmentDocument,
} from '../../modules/logistics/document.service.js';
import { captureProofOfDelivery, readProofOfDelivery } from '../../modules/logistics/pod.service.js';
import { raiseExceptionFromPortal } from '../../modules/logistics/exception.service.js';
import { recordShipmentEvent } from '../../modules/logistics/shipment-event.service.js';
import { readTimeline } from '../../modules/logistics/shipment-event.service.js';
import {
  assertShipmentAccess,
  collectShipmentsForExport,
  listShipments,
  readShipment,
} from '../../modules/logistics/shipment.service.js';
import {
  listLogisticsMembers,
  readLogisticsPartnerProfile,
  touchLogisticsMember,
  updateLogisticsMember,
  updateLogisticsPartnerContact,
} from '../../modules/logistics/partner.service.js';
import { listLogisticsAudit } from '../../modules/logistics/audit.service.js';
import { readLiveLocation } from '../../modules/logistics/trip.service.js';
import { currentUser } from '../plugins/auth.js';
import { readOwnIntegrationHealth } from '../../modules/logistics/partner-catalogue.service.js';
import { currentLogistics, requireLogistics, requireLogisticsSession } from '../plugins/logistics.js';

const idParam = z.object({ id: z.string().length(26) });

/**
 * A date that arrived as a string.
 *
 * Coerced rather than parsed by hand, and rejected rather than silently turned
 * into `Invalid Date` - a filter with an unparseable date would otherwise
 * match nothing and look like an empty result set.
 */
const isoDate = z.coerce.date();

const shipmentFilterSchema = z.object({
  search: z.string().trim().max(120).optional(),
  shipmentReference: z.string().trim().max(64).optional(),
  trackingNumber: z.string().trim().max(128).optional(),
  orderReference: z.string().trim().max(64).optional(),
  sellerCompany: z.string().trim().max(160).optional(),
  receivingCompany: z.string().trim().max(160).optional(),
  originLocationId: z.string().length(26).optional(),
  originCountry: z.string().length(2).optional(),
  destinationCountry: z.string().length(2).optional(),
  destinationCity: z.string().trim().max(120).optional(),
  status: z
    .union([z.enum(ShipmentStatusValues), z.array(z.enum(ShipmentStatusValues))])
    .optional(),
  serviceType: z
    .enum(['STANDARD', 'EXPRESS', 'SAME_DAY', 'ECONOMY', 'FREIGHT', 'WHITE_GLOVE'])
    .optional(),
  slaState: z
    .union([
      z.enum(['NOT_APPLICABLE', 'ON_TRACK', 'AT_RISK', 'BREACHED']),
      z.array(z.enum(['NOT_APPLICABLE', 'ON_TRACK', 'AT_RISK', 'BREACHED'])),
    ])
    .optional(),
  driverProfileId: z.string().length(26).optional(),
  hasException: z.coerce.boolean().optional(),
  podState: z.enum(['PRESENT', 'MISSING']).optional(),
  createdFrom: isoDate.optional(),
  createdTo: isoDate.optional(),
  deliveryFrom: isoDate.optional(),
  deliveryTo: isoDate.optional(),
  pickupFrom: isoDate.optional(),
  pickupTo: isoDate.optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  sortBy: z
    .enum(['createdAt', 'estimatedDeliveryAt', 'expectedPickupAt', 'lastEventAt', 'status'])
    .optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

/** A single value or an array, always as an array. Query strings do both. */
function toArray<T>(value: T | T[] | undefined): T[] | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value : [value];
}

export function registerLogisticsPortalRoutes(app: FastifyInstance): Promise<void> {
  // --- Session and second factor ------------------------------------------
  //
  // These four use `requireLogisticsSession`, which does NOT apply the MFA
  // gate. They have to work for somebody who has not yet enrolled or has not
  // yet answered a challenge, and they are the only routes in the portal that
  // do.

  /**
   * Everything the portal needs to boot.
   *
   * No cache header, ever: it carries the MFA state, and a proxy holding
   * "challenge required" for sixty seconds is sixty seconds of a dispatcher
   * unable to work after they have answered it.
   */
  app.get('/auth/me', { preHandler: requireLogisticsSession }, async (request, reply) => {
    const membership = currentLogistics(request);
    const auth = currentUser(request);

    const mfa = await readMfaState(membership, auth.sessionMfaVerifiedAt);

    return reply.header('cache-control', 'no-store').status(200).send({
      user: {
        id: auth.id,
        email: auth.email,
        fullName: membership.fullName,
        role: membership.role,
        permissions: [...membership.permissions],
        isDriver: membership.driverProfileId !== null,
      },
      partner: {
        id: membership.logisticsPartnerId,
        code: membership.partnerCode,
        displayName: membership.displayName,
        status: membership.partnerStatus,
        canAcceptNewWork: membership.canAcceptNewWork,
      },
      mfa,
    });
  });

  app.post('/auth/mfa/setup', { preHandler: requireLogisticsSession }, async (request, reply) => {
    const membership = currentLogistics(request);

    const business = await prisma.businessProfile.findFirst({ select: { legalName: true } });

    const enrolment = await beginMfaEnrolment(
      membership,
      mfaIssuerName(business?.legalName ?? null),
      request.correlationId,
    );

    /*
     * The secret and the recovery codes are in THIS response and in no other,
     * ever. There is no endpoint that reads them back: a product that can show
     * you your recovery codes twice is a product where reading somebody's
     * screen defeats their second factor.
     */
    return reply.header('cache-control', 'no-store').status(200).send(enrolment);
  });

  app.post('/auth/mfa/verify', { preHandler: requireLogisticsSession }, async (request, reply) => {
    const body = z
      .object({
        code: z.string().trim().min(6).max(16),
        mode: z.enum(['ENROL', 'CHALLENGE']).default('CHALLENGE'),
      })
      .parse(request.body);

    const membership = currentLogistics(request);
    const auth = currentUser(request);

    if (body.mode === 'ENROL') {
      await confirmMfaEnrolment(membership, auth.sessionId, body.code, request.correlationId);
      return reply.status(200).send({ verified: true, usedRecoveryCode: false });
    }

    const result = await verifyMfaChallenge(membership, auth.sessionId, body.code, {
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });

    return reply.status(200).send({ verified: true, ...result });
  });

  // --- Everything below here is behind the MFA gate ----------------------

  /**
   * This carrier's own integration, coverage and fleet, in one place.
   *
   * THE SCOPED HALF OF A SPLIT. The operator's delivery catalogue lists every
   * provider and every partner across the installation; that is operator
   * information and lives in the admin panel. What a CARRIER may see is
   * itself, and this is it.
   *
   * There is no parameter here. The partner id comes from
   * `currentLogistics`, which resolves it from the session - so there is
   * nothing a request could carry that would point this at somebody else,
   * which is what makes the screen safe rather than merely filtered.
   */
  app.get(
    '/integration',
    { preHandler: requireLogistics(LogisticsPermission.INTEGRATION_READ) },
    async (request, reply) => {
      const membership = currentLogistics(request);
      const health = await readOwnIntegrationHealth(membership.logisticsPartnerId);

      if (health === null) return reply.status(404).send();

      return reply.header('cache-control', 'no-store').status(200).send({ integration: health });
    },
  );

  app.get(
    '/dashboard',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          from: isoDate.optional(),
          to: isoDate.optional(),
          originLocationId: z.string().length(26).optional(),
          sellerCompany: z.string().trim().max(160).optional(),
          destinationCountry: z.string().length(2).optional(),
          /*
           * One of this carrier's own drivers.
           *
           * Validated as a ULID here and narrowed the rest of the way inside
           * `readDashboard`, where the clause is ANDed with the partner on the
           * session — so another carrier's driver id matches nothing rather
           * than being refused with a message that confirms it exists.
           */
          driverProfileId: z.string().length(26).optional(),
        })
        .parse(request.query);

      const membership = currentLogistics(request);
      const dashboard = await readDashboard(membership, {
        from: query.from ?? null,
        to: query.to ?? null,
        originLocationId: query.originLocationId ?? null,
        sellerCompany: query.sellerCompany ?? null,
        destinationCountry: query.destinationCountry ?? null,
        driverProfileId: query.driverProfileId ?? null,
      });

      // Fire and forget: the "last active" column is worth having and is not
      // worth making a dispatcher wait for.
      void touchLogisticsMember(membership);

      /*
       * No cache header, ever - the same reasoning as the seller dashboard.
       * Every number here is the reason somebody opened the page, and a proxy
       * holding "3 exceptions" for sixty seconds is sixty seconds of nobody
       * chasing a cold-chain excursion.
       */
      return reply.header('cache-control', 'no-store').status(200).send(dashboard);
    },
  );

  /**
   * The carrier's own figures, explained.
   *
   * Behind the same permission and the same MFA gate as the dashboard it
   * explains, and the metric bundle is built from `readDashboard` for the
   * membership on the session — so the insight cannot describe a consignment
   * this carrier could not open. There is no partner id in the body, the query
   * or the path, which is the same absence that makes every other route in
   * this file tenant-safe.
   */
  /** The carrier's own figures, delivered as they are written. See the buyer route. */
  app.post(
    '/dashboard/insights/stream',
    {
      preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ),
      config: { rateLimit: INSIGHT_RATE_LIMIT },
    },
    async (request, reply) => {
      await streamInsightResponse(request, reply, async () => {
        const body = insightBody.parse(request.body ?? {});

        const membership = currentLogistics(request);

        const from = body.from === undefined ? null : new Date(body.from);
        const to = body.to === undefined ? null : new Date(body.to);
        if (from !== null && to !== null) assertUsableWindow({ from, to });

        const dashboard = await readDashboard(membership, {
          from,
          to,
          originLocationId: null,
          sellerCompany: null,
          destinationCountry: null,
        });

        const metrics = logisticsInsightMetrics(dashboard);

        return {
          audience: 'LOGISTICS' as const,
          window: {
            from: (from ?? new Date(Date.now() - 30 * 86_400_000)).toISOString(),
            to: (to ?? new Date()).toISOString(),
          },
          filters: {
            segment: metrics.some((metric) => metric.key === body.segment)
              ? (body.segment ?? '')
              : '',
          },
          metrics,
          ...(body.question === undefined ? {} : { question: body.question }),
          ...(body.language === undefined ? {} : { language: body.language }),
        };
      });
    },
  );

  app.post(
    '/dashboard/insights',
    {
      preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ),
      config: { rateLimit: INSIGHT_RATE_LIMIT },
    },
    async (request, reply) => {
      const body = insightBody.parse(request.body ?? {});

      const membership = currentLogistics(request);

      const from = body.from === undefined ? null : new Date(body.from);
      const to = body.to === undefined ? null : new Date(body.to);

      // The dashboard's own filters default the window when either end is
      // absent; this only has to refuse a pair that is present and nonsense.
      if (from !== null && to !== null) assertUsableWindow({ from, to });

      const dashboard = await readDashboard(membership, {
        from,
        to,
        originLocationId: null,
        sellerCompany: null,
        destinationCountry: null,
      });

      const metrics = logisticsInsightMetrics(dashboard);

      const insight = await buildInsight({
        audience: 'LOGISTICS',
        window: {
          from: (from ?? new Date(Date.now() - 30 * 86_400_000)).toISOString(),
          to: (to ?? new Date()).toISOString(),
        },
        filters: {
          segment: metrics.some((metric) => metric.key === body.segment)
            ? (body.segment ?? '')
            : '',
        },
        metrics,
        ...(body.question === undefined ? {} : { question: body.question }),
        ...(body.language === undefined ? {} : { language: body.language }),
      });

      return reply.header('cache-control', 'no-store').status(200).send(insight);
    },
  );

  // --- Shipments ----------------------------------------------------------

  app.get(
    '/shipments',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) },
    async (request, reply) => {
      const query = shipmentFilterSchema.parse(request.query);

      const page = await listShipments(
        currentLogistics(request),
        {
          search: query.search ?? null,
          shipmentReference: query.shipmentReference ?? null,
          trackingNumber: query.trackingNumber ?? null,
          orderReference: query.orderReference ?? null,
          sellerCompany: query.sellerCompany ?? null,
          receivingCompany: query.receivingCompany ?? null,
          originLocationId: query.originLocationId ?? null,
          originCountry: query.originCountry ?? null,
          destinationCountry: query.destinationCountry ?? null,
          destinationCity: query.destinationCity ?? null,
          status: toArray(query.status),
          serviceType: query.serviceType ?? null,
          slaState: toArray(query.slaState),
          driverProfileId: query.driverProfileId ?? null,
          hasException: query.hasException ?? null,
          podState: query.podState ?? null,
          createdFrom: query.createdFrom ?? null,
          createdTo: query.createdTo ?? null,
          deliveryFrom: query.deliveryFrom ?? null,
          deliveryTo: query.deliveryTo ?? null,
          pickupFrom: query.pickupFrom ?? null,
          pickupTo: query.pickupTo ?? null,
        },
        {
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 25,
          sortBy: query.sortBy ?? 'createdAt',
          sortDir: query.sortDir ?? 'desc',
        },
      );

      return reply.status(200).send(page);
    },
  );

  /**
   * The same rows, as CSV.
   *
   * Built on `listShipments` with the SAME filters, so an export cannot
   * contain a row the list would not show. That is the property that makes
   * "exports respect tenant boundaries" true by construction rather than by
   * the export remembering to re-apply a clause.
   */
  app.get(
    '/shipments/export',
    {
      preHandler: requireLogistics(LogisticsPermission.SHIPMENT_EXPORT),
      // Tighter than the global limit. One export is a table scan; ten a
      // minute is somebody taking a copy of the book.
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const query = shipmentFilterSchema.parse(request.query);
      const membership = currentLogistics(request);

      const result = await collectShipmentsForExport(membership, {
        search: query.search ?? null,
        status: toArray(query.status),
        slaState: toArray(query.slaState),
        destinationCountry: query.destinationCountry ?? null,
        sellerCompany: query.sellerCompany ?? null,
        receivingCompany: query.receivingCompany ?? null,
        createdFrom: query.createdFrom ?? null,
        createdTo: query.createdTo ?? null,
        deliveryFrom: query.deliveryFrom ?? null,
        deliveryTo: query.deliveryTo ?? null,
      });

      const header = [
        'Shipment',
        'Tracking',
        'Order',
        'Seller',
        'Receiver',
        'Origin warehouse',
        'Destination city',
        'Destination country',
        'Packages',
        'Driver',
        'Status',
        'Pickup due',
        'Estimated delivery',
        'Last event',
        'SLA',
        'Open exceptions',
        'Proof of delivery',
      ];

      const lines = [header.join(',')];

      for (const row of result.rows) {
        lines.push(
          [
            row.shipmentReference,
            row.trackingNumber,
            row.orderReference ?? '',
            row.sellerCompanyName,
            row.receivingCompanyName,
            row.originWarehouse ?? '',
            row.destinationCity ?? '',
            row.destinationCountry,
            String(row.packageCount),
            row.assignedDriverName ?? '',
            row.status,
            row.expectedPickupAt?.toISOString() ?? '',
            row.estimatedDeliveryAt?.toISOString() ?? '',
            row.lastEventAt?.toISOString() ?? '',
            row.sla.state,
            String(row.openExceptionCount),
            row.hasProofOfDelivery ? 'yes' : 'no',
          ]
            .map(csvCell)
            .join(','),
        );
      }

      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="shipments-${new Date().toISOString().slice(0, 10)}.csv"`,
        )
        // Told rather than implied. A truncated file that looks complete is
        // how somebody reconciles against the wrong total.
        .header('x-uboss-truncated', result.truncated ? 'true' : 'false')
        .header('x-uboss-total', String(result.total))
        .status(200)
        .send(lines.join('\r\n'));
    },
  );

  app.get(
    '/shipments/:id',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const shipment = await readShipment(currentLogistics(request), params.id);
      return reply.status(200).send(shipment);
    },
  );

  app.get(
    '/shipments/:id/timeline',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const membership = currentLogistics(request);

      await assertShipmentAccess(membership, params.id, 'READ');

      /*
       * Who sees the operations notes.
       *
       * Decided HERE, from the caller's permissions, rather than inside the
       * service. A read-only tracking viewer gets the public timeline; anybody
       * who can change a status gets the notes that explain why somebody else
       * did. A service that guessed would eventually guess generously.
       */
      const includeInternal = membership.permissions.has(
        LogisticsPermission.SHIPMENT_STATUS_WRITE,
      );

      const events = await readTimeline(params.id, { includeInternal });
      return reply.status(200).send({ events });
    },
  );

  app.post(
    '/shipments/:id/accept',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_ACCEPT) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const result = await acceptAssignment(
        currentLogistics(request),
        params.id,
        request.correlationId,
      );
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/shipments/:id/reject',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_ACCEPT) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z.object({ reason: z.string().trim().min(4).max(512) }).parse(request.body);

      const result = await rejectAssignment(
        currentLogistics(request),
        params.id,
        body.reason,
        request.correlationId,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * Record a status event.
   *
   * The `Idempotency-Key` header is honoured and is the recommended way to
   * call this: a dispatcher on a flaky connection who presses the button twice
   * writes one event. Without a key every call is a distinct event, which is
   * also correct - two genuinely separate scans of the same parcel are two
   * events.
   */
  app.post(
    '/shipments/:id/status-events',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_STATUS_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          status: z.enum(ShipmentStatusValues),
          reason: z.string().trim().max(512).optional(),
          publicDescription: z.string().trim().max(512).optional(),
          internalNote: z.string().trim().max(2000).optional(),
          occurredAt: isoDate.optional(),
          locationLabel: z.string().trim().max(255).optional(),
          locationCountry: z.string().length(2).optional(),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          revisedEtaAt: isoDate.optional(),
        })
        .parse(request.body);

      const membership = currentLogistics(request);

      // Write authority, before anything is validated further. A settled
      // assignment gets SHIPMENT_NOT_ASSIGNED rather than a transition error.
      await assertShipmentAccess(membership, params.id, 'WRITE');

      const suppliedKey = request.headers['idempotency-key'];

      const event = await recordShipmentEvent({
        shipmentId: params.id,
        status: body.status,
        actor: membership.driverProfileId !== null ? 'DRIVER' : 'PARTNER',
        source: membership.driverProfileId !== null ? 'DRIVER_APP' : 'LOGISTICS_PORTAL',
        actorUserId: membership.userId,
        actorLogisticsPartnerId: membership.logisticsPartnerId,
        actorLabel: membership.fullName,
        permissions: [...membership.permissions],
        reason: body.reason ?? null,
        publicDescription: body.publicDescription ?? null,
        internalNote: body.internalNote ?? null,
        occurredAt: body.occurredAt ?? new Date(),
        locationLabel: body.locationLabel ?? null,
        locationCountry: body.locationCountry ?? null,
        locationLatitude: body.latitude ?? null,
        locationLongitude: body.longitude ?? null,
        revisedEtaAt: body.revisedEtaAt ?? null,
        idempotencyKey: typeof suppliedKey === 'string' ? suppliedKey : null,
        correlationId: request.correlationId,
      });

      return reply.status(event.duplicate ? 200 : 201).send(event);
    },
  );

  app.post(
    '/shipments/:id/exceptions',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_EXCEPTION_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          type: z.enum([
            'PICKUP_MISSED',
            'PACKAGE_NOT_READY',
            'ADDRESS_INCORRECT',
            'RECIPIENT_UNAVAILABLE',
            'CUSTOMS_DELAY',
            'WEATHER_DELAY',
            'VEHICLE_BREAKDOWN',
            'PRODUCT_DAMAGED',
            'PACKAGE_LOST',
            'TEMPERATURE_EXCURSION',
            'DELIVERY_ATTEMPT_FAILED',
            'DOCUMENTATION_MISSING',
          ]),
          severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
          reason: z.string().trim().min(4).max(512),
          detail: z.string().trim().max(2000).optional(),
          resolutionDueAt: isoDate.optional(),
          revisedEtaAt: isoDate.optional(),
        })
        .parse(request.body);

      const raised = await raiseExceptionFromPortal(
        currentLogistics(request),
        params.id,
        {
          type: body.type,
          severity: body.severity,
          reason: body.reason,
          detail: body.detail ?? null,
          resolutionDueAt: body.resolutionDueAt ?? null,
          revisedEtaAt: body.revisedEtaAt ?? null,
        },
        request.correlationId,
      );

      return reply.status(201).send(raised);
    },
  );

  // --- Documents and proof ------------------------------------------------

  app.get(
    '/shipments/:id/documents',
    { preHandler: requireLogistics(LogisticsPermission.DOCUMENT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const documents = await listShipmentDocuments(currentLogistics(request), params.id);
      return reply.status(200).send({ documents });
    },
  );

  app.post(
    '/shipments/:id/documents',
    { preHandler: requireLogistics(LogisticsPermission.DOCUMENT_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const file = await request.file();

      if (file === undefined) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Attach a file.',
            details: [{ field: 'file', code: 'REQUIRED' }],
            correlationId: request.correlationId,
          },
        });
      }

      const kind = z
        .enum([
          'PROOF_OF_DELIVERY',
          'DELIVERY_SIGNATURE',
          'DELIVERY_PHOTO',
          'DAMAGE_EVIDENCE',
          'RETURN_DOCUMENT',
          'MANIFEST',
          'OTHER',
        ])
        .parse(
          typeof file.fields['kind'] === 'object' &&
            file.fields['kind'] !== null &&
            'value' in file.fields['kind']
            ? (file.fields['kind'] as { value: unknown }).value
            : 'OTHER',
        );

      const stored = await uploadShipmentDocument(
        currentLogistics(request),
        {
          shipmentId: params.id,
          kind,
          fileName: file.filename,
          contentType: file.mimetype,
          bytes: await file.toBuffer(),
        },
        request.correlationId,
      );

      return reply.status(201).send(stored);
    },
  );

  /**
   * A short-lived link to one file.
   *
   * A POST rather than a GET, because it MINTS a credential and writes an
   * audit row. A GET that has a side effect is a GET a browser prefetches.
   */
  app.post(
    '/documents/:id/link',
    { preHandler: requireLogistics(LogisticsPermission.DOCUMENT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const link = await createDocumentLink(
        currentLogistics(request),
        params.id,
        request.correlationId,
      );
      return reply.header('cache-control', 'no-store').status(200).send(link);
    },
  );

  app.get(
    '/shipments/:id/proof-of-delivery',
    { preHandler: requireLogistics(LogisticsPermission.SHIPMENT_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const pod = await readProofOfDelivery(currentLogistics(request), params.id);
      return reply.status(200).send({ proofOfDelivery: pod });
    },
  );

  app.post(
    '/shipments/:id/proof-of-delivery',
    { preHandler: requireLogistics(LogisticsPermission.POD_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          recipientName: z.string().trim().max(160).optional(),
          recipientDesignation: z.string().trim().max(120).optional(),
          deliveredAt: isoDate.optional(),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          locationLabel: z.string().trim().max(255).optional(),
          signatureDocumentId: z.string().length(26).optional(),
          photoDocumentId: z.string().length(26).optional(),
          businessStamped: z.boolean().optional(),
          otp: z.string().trim().max(16).optional(),
          exceptionNote: z.string().trim().max(512).optional(),
        })
        .parse(request.body);

      const suppliedKey = request.headers['idempotency-key'];

      const result = await captureProofOfDelivery(
        currentLogistics(request),
        {
          shipmentId: params.id,
          recipientName: body.recipientName ?? null,
          recipientDesignation: body.recipientDesignation ?? null,
          deliveredAt: body.deliveredAt ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          locationLabel: body.locationLabel ?? null,
          signatureDocumentId: body.signatureDocumentId ?? null,
          photoDocumentId: body.photoDocumentId ?? null,
          businessStamped: body.businessStamped ?? false,
          otp: body.otp ?? null,
          exceptionNote: body.exceptionNote ?? null,
          idempotencyKey: typeof suppliedKey === 'string' ? suppliedKey : null,
        },
        request.correlationId,
      );

      return reply.status(result.duplicate ? 200 : 201).send(result);
    },
  );

  /**
   * Where the driver on this consignment currently is, or null.
   *
   * `null` is a real answer and the portal renders it as "Live location
   * unavailable". Nothing here interpolates, animates or invents a position.
   */
  app.get(
    '/shipments/:id/live-location',
    { preHandler: requireLogistics(LogisticsPermission.TRIP_LOCATION_READ) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const location = await readLiveLocation(currentLogistics(request), params.id);

      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send({ location, staleAfterSeconds: env.LOGISTICS_PING_INTERVAL_SECONDS * 3 });
    },
  );

  // --- Who we carry for ---------------------------------------------------

  app.get(
    '/companies',
    { preHandler: requireLogistics(LogisticsPermission.COMPANY_READ) },
    async (request, reply) => {
      const query = z
        .object({ type: z.enum(['SELLER', 'RECEIVER']).default('RECEIVER') })
        .parse(request.query);

      const companies = await listCompanies(currentLogistics(request), query.type);
      return reply.status(200).send({ companies });
    },
  );

  // --- The organisation ---------------------------------------------------

  app.get(
    '/organisation',
    { preHandler: requireLogistics(LogisticsPermission.ORGANISATION_READ) },
    async (request, reply) => {
      const profile = await readLogisticsPartnerProfile(currentLogistics(request));
      return reply.status(200).send(profile);
    },
  );

  app.patch(
    '/organisation',
    { preHandler: requireLogistics(LogisticsPermission.ORGANISATION_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          contactEmail: z.string().email().max(320).optional(),
          contactPhone: z.string().trim().max(32).nullable().optional(),
          emergencyPhone: z.string().trim().max(32).nullable().optional(),
          websiteUrl: z.string().url().max(512).nullable().optional(),
        })
        .parse(request.body);

      const profile = await updateLogisticsPartnerContact(
        currentLogistics(request),
        body,
        request.correlationId,
      );

      return reply.status(200).send(profile);
    },
  );

  app.get(
    '/members',
    { preHandler: requireLogistics(LogisticsPermission.MEMBER_READ) },
    async (request, reply) => {
      const members = await listLogisticsMembers(currentLogistics(request));
      return reply.status(200).send({ members });
    },
  );

  app.patch(
    '/members/:id',
    { preHandler: requireLogistics(LogisticsPermission.MEMBER_WRITE) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = z
        .object({
          role: z
            .enum([
              'LOGISTICS_PARTNER_OWNER',
              'LOGISTICS_PARTNER_ADMIN',
              'DISPATCHER',
              'DRIVER',
              'OPERATIONS_AGENT',
              'READ_ONLY_TRACKING_USER',
            ])
            .optional(),
          status: z.enum(['INVITED', 'ACTIVE', 'DISABLED']).optional(),
          jobTitle: z.string().trim().max(120).nullable().optional(),
          phone: z.string().trim().max(32).nullable().optional(),
          disabledReason: z.string().trim().max(255).nullable().optional(),
        })
        .parse(request.body);

      const member = await updateLogisticsMember(
        currentLogistics(request),
        params.id,
        body,
        request.correlationId,
      );

      return reply.status(200).send(member);
    },
  );

  // --- Notifications and the trail ---------------------------------------

  app.get('/notifications', { preHandler: requireLogistics() }, async (request, reply) => {
    const query = z
      .object({
        /**
         * Which half. `active` is the bell - live problems and unread news.
         * `resolved` is the record of what was dealt with, kept rather than
         * deleted so a dispatcher can answer "what happened to that one?"
         * weeks later.
         */
        view: z.enum(['active', 'resolved', 'all']).optional(),
      })
      .parse(request.query ?? {});

    const membership = currentLogistics(request);

    const feed = await listLogisticsNotifications(
      membership.logisticsPartnerId,
      membership.partnerUserId,
      query.view ?? 'active',
    );

    return reply.header('cache-control', 'no-store').status(200).send(feed);
  });

  app.post('/notifications/read', { preHandler: requireLogistics() }, async (request, reply) => {
    const body = z
      .object({ ids: z.array(z.string().length(26)).max(100).optional() })
      .parse(request.body ?? {});

    const membership = currentLogistics(request);

    const marked = await markLogisticsNotificationsRead(
      membership.logisticsPartnerId,
      membership.partnerUserId,
      body.ids ?? null,
    );

    return reply.status(200).send({ marked });
  });

  app.get(
    '/audit',
    { preHandler: requireLogistics(LogisticsPermission.AUDIT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          cursor: z.string().length(26).optional(),
          action: z.string().trim().max(64).optional(),
        })
        .parse(request.query);

      const page = await listLogisticsAudit(currentLogistics(request).logisticsPartnerId, {
        limit: query.limit ?? 50,
        cursor: query.cursor ?? null,
        action: query.action ?? null,
      });

      return reply.status(200).send(page);
    },
  );

  return Promise.resolve();
}

/**
 * One CSV cell, quoted where it has to be.
 *
 * A company name with a comma in it is ordinary, and a naive join produces a
 * file that opens with the columns shifted - which somebody then reconciles
 * against. The leading-character guard is the spreadsheet-formula injection
 * defence: a cell starting `=`, `+`, `-` or `@` is executed by Excel when the
 * file is opened, and a carrier's export is a file a person opens.
 */
function csvCell(value: string): string {
  const needsPrefix = /^[=+\-@\t\r]/.test(value);
  const escaped = (needsPrefix ? `'${value}` : value).replace(/"/g, '""');

  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}
