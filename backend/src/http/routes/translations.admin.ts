/**
 * Reading and writing per-language catalogue copy.
 *
 * One pair of routes per translatable thing, shaped as "give me every language
 * for this row" and "save one language for this row". The admin panel shows a
 * language tab strip and saves the tab somebody is on, so those are the two
 * shapes it needs; a bulk endpoint would only be a second way to do the same
 * thing.
 *
 * The base row is returned alongside the translations, because a translator
 * cannot work without the source text in front of them and making the panel
 * fetch it separately just guarantees the two go out of step.
 *
 * Permissions ride on the existing catalogue ones: somebody who may edit a
 * product may edit its copy in any language. A separate "translator" role
 * would be the right answer for an agency working in the panel, and is
 * deliberately left until somebody actually needs it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import { notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { SUPPORTED_LANGUAGES } from '../../modules/identity/language.service.js';
import { requireAdmin } from '../plugins/auth.js';

const idSchema = z.string().length(26);

/**
 * A language other than the base one.
 *
 * English is excluded on purpose: it is the base row on `products`, and
 * accepting an `en` translation would create two places holding the same copy
 * with no rule for which wins.
 */
const targetLanguageSchema = z.enum(
  SUPPORTED_LANGUAGES.filter((code) => code !== 'en') as [string, ...string[]],
);

/**
 * An empty string clears a field back to the base text rather than storing a
 * blank, which is why these are nullable and trimmed. A translator who deletes
 * a bad machine translation should get the English back, not an empty page.
 */
const optionalCopy = z.string().trim().max(4096).nullable().optional();

const productTranslationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  shortDescription: optionalCopy,
  description: optionalCopy,
  metaTitle: z.string().trim().max(255).nullable().optional(),
  metaDescription: z.string().trim().max(512).nullable().optional(),
  isReviewed: z.boolean().optional(),
});

const categoryTranslationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: optionalCopy,
  metaTitle: z.string().trim().max(255).nullable().optional(),
  metaDescription: z.string().trim().max(512).nullable().optional(),
  isReviewed: z.boolean().optional(),
});

export function registerAdminTranslationRoutes(app: FastifyInstance): Promise<void> {
  // --- products ------------------------------------------------------------

  app.get(
    '/products/:id/translations',
    { preHandler: requireAdmin(Permission.PRODUCT_READ) },
    async (request, reply) => {
      const { id: productId } = z.object({ id: idSchema }).parse(request.params);

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          shortDescription: true,
          description: true,
          metaTitle: true,
          metaDescription: true,
          translations: {
            select: {
              language: true,
              name: true,
              shortDescription: true,
              description: true,
              metaTitle: true,
              metaDescription: true,
              isReviewed: true,
              updatedAt: true,
            },
            orderBy: { language: 'asc' },
          },
        },
      });

      if (product === null) throw notFound('Product');

      return reply.status(200).send({
        // The source text, so the panel can show it beside each language
        // without a second round trip.
        base: {
          name: product.name,
          shortDescription: product.shortDescription,
          description: product.description,
          metaTitle: product.metaTitle,
          metaDescription: product.metaDescription,
        },
        translations: product.translations.map((row) => ({
          ...row,
          updatedAt: row.updatedAt.toISOString(),
        })),
      });
    },
  );

  app.put(
    '/products/:id/translations/:language',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id: productId, language } = z
        .object({ id: idSchema, language: targetLanguageSchema })
        .parse(request.params);

      const body = productTranslationSchema.parse(request.body);

      const exists = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (exists === null) throw notFound('Product');

      const data = {
        name: body.name,
        shortDescription: body.shortDescription ?? null,
        description: body.description ?? null,
        metaTitle: body.metaTitle ?? null,
        metaDescription: body.metaDescription ?? null,
        // A save from the panel is a person having read it. Machine output is
        // written by the translation script, which leaves this false.
        isReviewed: body.isReviewed ?? true,
      };

      const saved = await prisma.productTranslation.upsert({
        where: { productId_language: { productId, language } },
        create: { id: newId(), productId, language, ...data },
        update: data,
        select: { language: true, isReviewed: true, updatedAt: true },
      });

      return reply
        .status(200)
        .send({ translation: { ...saved, updatedAt: saved.updatedAt.toISOString() } });
    },
  );

  app.delete(
    '/products/:id/translations/:language',
    { preHandler: requireAdmin(Permission.PRODUCT_WRITE) },
    async (request, reply) => {
      const { id: productId, language } = z
        .object({ id: idSchema, language: targetLanguageSchema })
        .parse(request.params);

      // Deleting the row is how a language is reverted to the base copy -
      // there is no "empty translation" state to get stuck in.
      await prisma.productTranslation.deleteMany({ where: { productId, language } });

      return reply.status(200).send({ deleted: true });
    },
  );

  // --- categories ----------------------------------------------------------

  app.get(
    '/categories/:id/translations',
    { preHandler: requireAdmin(Permission.CATEGORY_READ) },
    async (request, reply) => {
      const { id: categoryId } = z.object({ id: idSchema }).parse(request.params);

      const category = await prisma.category.findUnique({
        where: { id: categoryId },
        select: {
          id: true,
          name: true,
          description: true,
          metaTitle: true,
          metaDescription: true,
          translations: {
            select: {
              language: true,
              name: true,
              description: true,
              metaTitle: true,
              metaDescription: true,
              isReviewed: true,
              updatedAt: true,
            },
            orderBy: { language: 'asc' },
          },
        },
      });

      if (category === null) throw notFound('Category');

      return reply.status(200).send({
        base: {
          name: category.name,
          description: category.description,
          metaTitle: category.metaTitle,
          metaDescription: category.metaDescription,
        },
        translations: category.translations.map((row) => ({
          ...row,
          updatedAt: row.updatedAt.toISOString(),
        })),
      });
    },
  );

  app.put(
    '/categories/:id/translations/:language',
    { preHandler: requireAdmin(Permission.CATEGORY_WRITE) },
    async (request, reply) => {
      const { id: categoryId, language } = z
        .object({ id: idSchema, language: targetLanguageSchema })
        .parse(request.params);

      const body = categoryTranslationSchema.parse(request.body);

      const exists = await prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      });
      if (exists === null) throw notFound('Category');

      const data = {
        name: body.name,
        description: body.description ?? null,
        metaTitle: body.metaTitle ?? null,
        metaDescription: body.metaDescription ?? null,
        isReviewed: body.isReviewed ?? true,
      };

      const saved = await prisma.categoryTranslation.upsert({
        where: { categoryId_language: { categoryId, language } },
        create: { id: newId(), categoryId, language, ...data },
        update: data,
        select: { language: true, isReviewed: true, updatedAt: true },
      });

      return reply
        .status(200)
        .send({ translation: { ...saved, updatedAt: saved.updatedAt.toISOString() } });
    },
  );

  app.delete(
    '/categories/:id/translations/:language',
    { preHandler: requireAdmin(Permission.CATEGORY_WRITE) },
    async (request, reply) => {
      const { id: categoryId, language } = z
        .object({ id: idSchema, language: targetLanguageSchema })
        .parse(request.params);

      await prisma.categoryTranslation.deleteMany({ where: { categoryId, language } });

      return reply.status(200).send({ deleted: true });
    },
  );

  return Promise.resolve();
}
