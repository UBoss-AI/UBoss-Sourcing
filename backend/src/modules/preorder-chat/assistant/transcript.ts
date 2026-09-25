/**
 * The assistant's answers as they travel: from this server to the browser,
 * back in a handoff, into a stored message, and out to both sides' screens.
 *
 * One schema for all four, so an answer that is stored is one that validated
 * on the way in, and one that is shown is one that validates on the way out -
 * a row written by an older version, or edited by hand, is dropped rather
 * than rendered half-understood.
 */
import { z } from 'zod';
import { ErrorCode, badRequest } from '../../../domain/errors.js';
import { FAQ_IDS } from './catalogue.js';
import type { FaqAnswer } from './answers.js';
import { verifyAnswer, type SignedScope } from './facts.service.js';

const lineKey = z
  .string()
  .max(96)
  .regex(/^preorderChat\.assistant\.a\.[a-z][A-Za-z0-9]*$/);
const valueName = z.string().regex(/^[a-z][A-Za-z0-9]{0,23}$/);

const valueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), value: z.number().finite().min(0).max(1e12) }).strict(),
  z.object({ kind: z.literal('text'), value: z.string().max(600) }).strict(),
  z.object({ kind: z.literal('date'), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z
    .object({
      kind: z.literal('money'),
      minor: z.string().regex(/^\d{1,18}$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict(),
  z.object({ kind: z.literal('unit'), value: z.string().regex(/^[A-Z0-9_]{1,32}$/) }).strict(),
  z.object({ kind: z.literal('countries'), value: z.array(z.string().regex(/^[A-Z]{2}$/)).max(60) }).strict(),
]);

export const faqAnswerSchema = z
  .object({
    faqId: z.enum(FAQ_IDS),
    version: z.number().int().min(1).max(10_000),
    outcome: z.enum(['ANSWERED', 'NEEDS_CONFIRMATION']),
    lines: z
      .array(z.object({ key: lineKey, values: z.record(valueName, valueSchema) }).strict())
      .min(1)
      .max(8),
  })
  .strict();

export const transcriptItemSchema = z
  .object({
    answer: faqAnswerSchema,
    askedAt: z.string().datetime(),
    token: z.string().min(16).max(100),
  })
  .strict();

/** A dozen questions, twice over, is more than anybody reads before asking a person. */
export const TRANSCRIPT_MAX = 24;
export const transcriptSchema = z.array(transcriptItemSchema).max(TRANSCRIPT_MAX);

export type TranscriptItem = z.infer<typeof transcriptItemSchema>;

/**
 * Every item signed by this server, for this product and option, recently -
 * or a 400 naming the first that was not. All or nothing: a transcript with
 * one forged answer in it is not partly believed.
 */
export function verifyTranscript(items: readonly TranscriptItem[], scope: SignedScope): TranscriptItem[] {
  items.forEach((item, index) => {
    if (!verifyAnswer(scope, item.answer, item.askedAt, item.token)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That answer was not given for this product, or it is too old.', [
        { field: `transcript.${index}`, code: 'NOT_SIGNED' },
      ]);
    }
  });
  return [...items];
}

/** What a stored AUTOMATED_REPLY row holds, or null when it does not validate. */
export function readStoredAnswer(value: unknown): (FaqAnswer & { askedAt: string }) | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const parsed = faqAnswerSchema.safeParse(record['answer']);
  const askedAt = typeof record['askedAt'] === 'string' ? record['askedAt'] : null;
  if (!parsed.success || askedAt === null) return null;
  return { ...(parsed.data), askedAt };
}
