/**
 * Economic operators and the product-safety checklist — admin only.
 *
 * GPSR Art. 19 is a listing requirement, so most of it lives on the product
 * screen. What needs its own surface is the companies: a manufacturer supplies
 * dozens of lines and its registered address changes as a company detail, not
 * as a catalogue edit, so it is entered once and pointed at.
 *
 * `GET /products/:id/safety` is the other half. It runs exactly the check that
 * publication runs, and returns it whether or not enforcement is on — which is
 * the point. An operator deciding whether to start selling into the Union
 * needs to see the size of the job before they flip the switch, not after it
 * blocks their catalogue.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import {
  assessProductGpsr,
  listEconomicOperators,
} from '../../modules/catalog/gpsr.service.js';
import { assessProductMdr } from '../../modules/catalog/mdr.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

/**
 * The postal address of a company, not of a delivery.
 *
 * Looser than the customer address schema next door on purpose: this is
 * transcribed off a company register that may be in any of two hundred
 * countries, and demanding a `state` from a Luxembourg manufacturer is how a
 * form becomes something people work around.
 */
const operatorAddressSchema = z.object({
  line1: z.string().trim().min(1).max(255),
  line2: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().min(1).max(128),
  region: z.string().trim().max(128).nullable().optional(),
  postalCode: z.string().trim().max(32).nullable().optional(),
});

const operatorSchema = z.object({
  role: z.enum(['MANUFACTURER', 'EU_RESPONSIBLE_PERSON', 'IMPORTER']),
  legalName: z.string().trim().min(1).max(255),
  tradeName: z.string().trim().max(255).nullable().optional(),
  address: operatorAddressSchema,
  countryCode: z.string().trim().length(2).toUpperCase(),
  // Art. 19(a) calls this the "electronic address" and does not make it
  // optional. A manufacturer a buyer cannot write to is not a manufacturer
  // that has been named.
  email: z.string().trim().min(1).max(320).email('Enter a valid email address.'),
  phone: z.string().trim().max(32).nullable().optional(),
  website: z.string().trim().url().max(512).nullable().optional(),
  // MDR Art. 31: the Single Registration Number Eudamed issues to an actor.
  // Distinct from a VAT number - it identifies this company specifically as a
  // medical-device economic operator.
  eudamedSrn: z.string().trim().max(64).nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * A product's medical-device record.
 *
 * There is no "is a medical device" boolean anywhere: the row existing IS the
 * flag, and DELETE is how a product stops being one. A separate boolean would
 * be a second thing that can disagree with the data.
 */
const deviceSchema = z.object({
  deviceClass: z.enum([
    'CLASS_I',
    'CLASS_I_STERILE',
    'CLASS_I_MEASURING',
    'CLASS_I_REUSABLE_SURGICAL',
    'CLASS_IIA',
    'CLASS_IIB',
    'CLASS_III',
  ]),
  basicUdiDi: z.string().trim().max(64).nullable().optional(),
  udiDi: z.string().trim().max(64).nullable().optional(),
  notifiedBodyNumber: z.string().trim().max(8).nullable().optional(),
  declarationOfConformityUrl: z.string().trim().url().max(1024).nullable().optional(),
  intendedPurpose: z.string().max(20_000).nullable().optional(),
  isSterile: z.boolean().optional(),
  isSingleUse: z.boolean().optional(),
  hasMeasuringFunction: z.boolean().optional(),
  containsBiologicalMaterial: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().length(26) });

function actorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return { userId: auth.id, email: auth.email, correlationId: request.correlationId };
}

/** The languages the storefront serves, for the warning-translation gap report. */
async function storefrontLanguages(): Promise<string[]> {
  const rows = await prisma.productTranslation.findMany({
    distinct: ['language'],
    select: { language: true },
  });

  return rows.map((row) => row.language);
}

export function registerAdminGpsrRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/economic-operators',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          role: z.enum(['MANUFACTURER', 'EU_RESPONSIBLE_PERSON', 'IMPORTER']).optional(),
          includeArchived: z.coerce.boolean().optional(),
        })
        .parse(request.query);

      const operators = await listEconomicOperators(query);
      return reply.status(200).send({ operators });
    },
  );

  app.post(
    '/economic-operators',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const body = operatorSchema.parse(request.body);
      const actor = actorFrom(request);
      const id = newId();

      await prisma.economicOperator.create({
        data: {
          id,
          role: body.role,
          legalName: body.legalName,
          tradeName: body.tradeName ?? null,
          addressJson: body.address as never,
          countryCode: body.countryCode,
          email: body.email,
          phone: body.phone ?? null,
          website: body.website ?? null,
          eudamedSrn: body.eudamedSrn ?? null,
          isActive: body.isActive ?? true,
          createdById: actor.userId,
        },
      });

      await recordAudit({
        action: AuditAction.ECONOMIC_OPERATOR_CREATED,
        resourceType: 'economic_operator',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { role: body.role, legalName: body.legalName, countryCode: body.countryCode },
        correlationId: actor.correlationId,
      });

      return reply.status(201).send({ id });
    },
  );

  app.patch(
    '/economic-operators/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = operatorSchema.partial().parse(request.body);
      const actor = actorFrom(request);

      const existing = await prisma.economicOperator.findUnique({ where: { id } });
      if (existing === null || existing.archivedAt !== null) throw notFound('Economic operator');

      await prisma.economicOperator.update({
        where: { id },
        data: {
          ...(body.role === undefined ? {} : { role: body.role }),
          ...(body.legalName === undefined ? {} : { legalName: body.legalName }),
          ...(body.tradeName === undefined ? {} : { tradeName: body.tradeName }),
          ...(body.address === undefined ? {} : { addressJson: body.address as never }),
          ...(body.countryCode === undefined ? {} : { countryCode: body.countryCode }),
          ...(body.email === undefined ? {} : { email: body.email }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.website === undefined ? {} : { website: body.website }),
          ...(body.eudamedSrn === undefined ? {} : { eudamedSrn: body.eudamedSrn }),
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        },
      });

      await recordAudit({
        action: AuditAction.ECONOMIC_OPERATOR_UPDATED,
        resourceType: 'economic_operator',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { legalName: existing.legalName, countryCode: existing.countryCode },
        after: body,
        correlationId: actor.correlationId,
      });

      return reply.status(200).send({ updated: true });
    },
  );

  /**
   * Retire an operator.
   *
   * Refused while any product still names it. The foreign key is Restrict and
   * would refuse anyway, but a raw constraint violation tells a catalogue
   * manager nothing; this says how many listings are in the way, which is the
   * question they are about to ask.
   */
  app.delete(
    '/economic-operators/:id',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const actor = actorFrom(request);

      const operator = await prisma.economicOperator.findUnique({
        where: { id },
        include: {
          _count: { select: { manufacturedProducts: true, representedProducts: true } },
        },
      });

      if (operator === null || operator.archivedAt !== null) throw notFound('Economic operator');

      const inUse = operator._count.manufacturedProducts + operator._count.representedProducts;

      if (inUse > 0) {
        throw conflict(
          ErrorCode.CONFLICT,
          `${String(inUse)} product(s) still name ${operator.legalName}. Point them at another ` +
            'operator first — a listing with no manufacturer named is exactly what GPSR ' +
            'Art. 19 forbids.',
          [{ field: 'id', code: 'IN_USE', meta: { productCount: inUse } }],
        );
      }

      await prisma.economicOperator.update({
        where: { id },
        data: { archivedAt: new Date(), isActive: false },
      });

      await recordAudit({
        action: AuditAction.ECONOMIC_OPERATOR_ARCHIVED,
        resourceType: 'economic_operator',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { legalName: operator.legalName },
        correlationId: actor.correlationId,
      });

      return reply.status(200).send({ archived: true });
    },
  );

  /**
   * The Art. 19 checklist for one product.
   *
   * The same function publication runs, so what the screen shows and what the
   * server enforces cannot drift. `enforced` says whether these gaps currently
   * block anything.
   */
  app.get(
    '/products/:id/safety',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const assessment = await assessProductGpsr(id, await storefrontLanguages());
      return reply.status(200).send(assessment);
    },
  );

  /**
   * The MDR checklist for one product, plus its device record.
   *
   * "Not a device" is the ordinary answer across most of a catalogue, and the
   * panel renders nothing rather than a green tick: a product this regulation
   * never reaches has not passed anything.
   */
  app.get(
    '/products/:id/device',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const [assessment, device] = await Promise.all([
        assessProductMdr(id, await storefrontLanguages()),
        prisma.productDeviceInfo.findUnique({ where: { productId: id } }),
      ]);

      return reply.status(200).send({ assessment, device });
    },
  );

  /**
   * Mark a product as a device, or update its record.
   *
   * An upsert rather than a create/update pair: whether a device row already
   * exists is not something a caller should have to know before it can save.
   */
  app.put(
    '/products/:id/device',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = deviceSchema.parse(request.body);
      const actor = actorFrom(request);

      const product = await prisma.product.findUnique({ where: { id }, select: { id: true } });
      if (product === null) throw notFound('Product');

      const data = {
        deviceClass: body.deviceClass,
        basicUdiDi: body.basicUdiDi ?? null,
        udiDi: body.udiDi ?? null,
        notifiedBodyNumber: body.notifiedBodyNumber ?? null,
        declarationOfConformityUrl: body.declarationOfConformityUrl ?? null,
        intendedPurpose: body.intendedPurpose ?? null,
        isSterile: body.isSterile ?? false,
        isSingleUse: body.isSingleUse ?? false,
        hasMeasuringFunction: body.hasMeasuringFunction ?? false,
        containsBiologicalMaterial: body.containsBiologicalMaterial ?? false,
      };

      await prisma.productDeviceInfo.upsert({
        where: { productId: id },
        create: { id: newId(), productId: id, ...data },
        update: data,
      });

      await recordAudit({
        action: AuditAction.DEVICE_INFO_UPDATED,
        resourceType: 'product',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { deviceClass: body.deviceClass, udiDi: body.udiDi ?? null },
        correlationId: actor.correlationId,
      });

      return reply.status(200).send({ updated: true });
    },
  );

  /** Stop treating a product as a device. Deletes the row - see deviceSchema. */
  app.delete(
    '/products/:id/device',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const actor = actorFrom(request);

      await prisma.productDeviceInfo.deleteMany({ where: { productId: id } });

      await recordAudit({
        action: AuditAction.DEVICE_INFO_UPDATED,
        resourceType: 'product',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { isMedicalDevice: false },
        correlationId: actor.correlationId,
      });

      return reply.status(200).send({ removed: true });
    },
  );

  return Promise.resolve();
}
