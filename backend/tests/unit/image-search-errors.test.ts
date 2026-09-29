/**
 * What a failed photograph search is allowed to answer.
 *
 * Every provider failure used to reach the image-search route as either
 * "busy" or an unmapped error, and a timeout - the likeliest failure on a
 * vision call - was the unmapped one: a bare 500. This pins each provider
 * failure kind to the published code the storefront translates.
 */
import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '../../src/domain/errors.js';
import { imageSearchErrorFor } from '../../src/http/routes/catalog.public.js';
import {
  AssistantBusyError,
  AssistantProviderError,
  type AssistantFailure,
} from '../../src/modules/assistant/provider.js';
import { ImageSearchUnreadableError } from '../../src/modules/assistant/image-search.service.js';

describe('imageSearchErrorFor', () => {
  it.each<[AssistantFailure, string]>([
    ['timeout', ErrorCode.IMAGE_SEARCH_BUSY],
    ['network', ErrorCode.IMAGE_SEARCH_BUSY],
    ['busy', ErrorCode.IMAGE_SEARCH_BUSY],
    ['quota', ErrorCode.IMAGE_SEARCH_BUSY],
    ['credentials', ErrorCode.IMAGE_SEARCH_UNAVAILABLE],
    ['model', ErrorCode.IMAGE_SEARCH_UNAVAILABLE],
  ])('a provider %s failure is %s with 503, never a 500', (reason, code) => {
    const mapped = imageSearchErrorFor(
      new AssistantProviderError('provider detail that must not reach a customer', reason),
    );

    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped?.code).toBe(code);
    expect(mapped?.statusCode).toBe(503);
    expect(mapped?.details[0]?.code).toBe(reason.toUpperCase());
    expect(mapped?.message).not.toContain('provider detail');
  });

  it('says a timeout took too long rather than that the provider is busy', () => {
    const mapped = imageSearchErrorFor(new AssistantProviderError('Deadline', 'timeout'));
    expect(mapped?.message).toBe(
      'Image search took too long to answer. Please try again in a moment.',
    );
  });

  it('keeps the existing mapping for a busy provider', () => {
    const mapped = imageSearchErrorFor(new AssistantBusyError('429 RESOURCE_EXHAUSTED', true, 429));
    expect(mapped?.code).toBe(ErrorCode.IMAGE_SEARCH_BUSY);
    expect(mapped?.details[0]?.code).toBe('QUOTA');
  });

  it('maps an unparseable reply to IMAGE_SEARCH_UNREADABLE, 502', () => {
    const mapped = imageSearchErrorFor(new ImageSearchUnreadableError());
    expect(mapped?.code).toBe(ErrorCode.IMAGE_SEARCH_UNREADABLE);
    expect(mapped?.statusCode).toBe(502);
  });

  it('leaves anything that is not a provider failure to the caller', () => {
    expect(imageSearchErrorFor(new Error('database down'))).toBeNull();
  });
});
