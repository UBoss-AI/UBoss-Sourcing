import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const queries = vi.hoisted(() => ({ order: vi.fn(), rfq: vi.fn(), chat: vi.fn(), settings: vi.fn() }));
vi.mock('../../src/infra/prisma.js', () => ({ prisma: {
  $connect: () => Promise.resolve(), rateLimitBucket: { deleteMany: () => Promise.resolve({ count: 0 }) },
  orderMessage: { findFirst: queries.order }, rfqMessage: { findFirst: queries.rfq }, preorderChatMessage: { findFirst: queries.chat }, catalogTranslationSync: { findFirst: queries.settings },
} }));
import { env } from '../../src/config/env.js';
import { encryptSecret } from '../../src/infra/crypto.js';
import { logger } from '../../src/infra/logger.js';
import { translateMessage, type MessageViewer } from '../../src/modules/messages/message-safety.service.js';
const buyer: MessageViewer = { party: 'BUYER', userId: 'buyer', email: 'buyer@example.test', customerProfileId: 'profile', orderScope: { customerProfileId: 'profile' }, rfqScope: { customerProfileId: 'profile' } };
const seller: MessageViewer = { party: 'SELLER', userId: 'seller', email: 'seller@example.test', sellerAccountId: 'seller-account' };
const input = { threadKind: 'ORDER' as const, messageId: 'message', language: 'en' };
const original = 'Private original words that must not reach logs';
const previousFlag = env.FEATURE_MESSAGE_TRANSLATION;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); env.FEATURE_MESSAGE_TRANSLATION = true; vi.stubGlobal('fetch', fetchMock);
  queries.order.mockResolvedValue({ sellerOrderGroupId: 'group', body: original, authorParty: 'SELLER' });
  queries.rfq.mockResolvedValue({ rfqId: 'rfq', body: original, authorParty: 'BUYER' });
  queries.chat.mockResolvedValue({ conversationId: 'chat', body: original, senderType: 'STAFF', redactedAt: null });
  queries.settings.mockResolvedValue({ apiKeyEncrypted: encryptSecret('not-a-real-translation-credential:fx') });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ translations: [{ text: 'Translated words', detected_source_language: 'DE' }] }), { status: 200 }));
});
afterEach(() => { env.FEATURE_MESSAGE_TRANSLATION = previousFlag; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('private message translation provider boundary', () => {
  it('translates stored original text within buyer ownership and never writes it back', async () => {
    const row = { sellerOrderGroupId: 'group', body: original, authorParty: 'SELLER' }; queries.order.mockResolvedValue(row);
    await expect(translateMessage(buyer, input)).resolves.toEqual({ text: 'Translated words', detectedLanguage: 'de', language: 'en' });
    expect(queries.order).toHaveBeenCalledWith({ where: { id: 'message', sellerOrderGroup: { order: buyer.orderScope } }, select: { sellerOrderGroupId: true, body: true, authorParty: true } });
    const call = fetchMock.mock.calls[0]; expect(call?.[0]).toBe('https://api-free.deepl.com/v2/translate'); expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ text: [original], target_lang: 'EN-GB' }); expect(row.body).toBe(original);
  });
  it('scopes a seller RFQ translation to its own seller account', async () => {
    await translateMessage(seller, { ...input, threadKind: 'RFQ', language: 'pl' }); expect(queries.rfq.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'message', sellerAccountId: 'seller-account' } }); expect((JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as { target_lang: unknown }).target_lang).toBe('PL');
  });
  it('refuses a message outside the buyer ownership query before contacting a provider', async () => {
    queries.order.mockResolvedValue(null); await expect(translateMessage(buyer, input)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('refuses seller access to a buyer/operator preorder conversation', async () => {
    await expect(translateMessage(seller, { ...input, threadKind: 'PREORDER_CHAT' })).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(queries.chat).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not send a redacted preorder message to a provider', async () => {
    queries.chat.mockResolvedValue({ conversationId: 'chat', body: original, senderType: 'STAFF', redactedAt: new Date() }); await expect(translateMessage(buyer, { ...input, threadKind: 'PREORDER_CHAT' })).resolves.toEqual({ text: '', detectedLanguage: null, language: 'en' }); expect(fetchMock).not.toHaveBeenCalled(); expect(queries.chat.mock.calls[0]?.[0]).toMatchObject({ where: { conversation: { customerProfileId: 'profile' } } });
  });
  it('is unavailable when the feature is off', async () => {
    env.FEATURE_MESSAGE_TRANSLATION = false; await expect(translateMessage(buyer, input)).rejects.toMatchObject({ code: 'MESSAGE_TRANSLATION_UNAVAILABLE' }); expect(queries.order).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('is unavailable without a stored provider credential', async () => {
    queries.settings.mockResolvedValue({ apiKeyEncrypted: null }); await expect(translateMessage(buyer, input)).rejects.toMatchObject({ code: 'MESSAGE_TRANSLATION_UNAVAILABLE' }); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('refuses an unsupported language before accessing private words', async () => {
    await expect(translateMessage(buyer, { ...input, language: 'unsupported' })).rejects.toMatchObject({ code: 'MESSAGE_TRANSLATION_UNAVAILABLE' }); expect(queries.order).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('never logs provider error text that may contain private words', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined); fetchMock.mockRejectedValue(new Error(original)); await expect(translateMessage(buyer, input)).rejects.toMatchObject({ code: 'MESSAGE_TRANSLATION_UNAVAILABLE' }); expect(warn).toHaveBeenCalledOnce(); expect(JSON.stringify(warn.mock.calls)).not.toContain(original);
  });
  it('refuses a failed provider response without reading its private response body', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined); const json = vi.fn(); fetchMock.mockResolvedValue({ ok: false, status: 503, json }); await expect(translateMessage(buyer, input)).rejects.toMatchObject({ code: 'MESSAGE_TRANSLATION_UNAVAILABLE' }); expect(json).not.toHaveBeenCalled(); expect(JSON.stringify(warn.mock.calls)).not.toContain(original);
  });
  it('maps unreadable provider JSON to the translation-unavailable contract', async () => {
    fetchMock.mockResolvedValue(new Response('invalid json', { status: 200 })); await expect(translateMessage(buyer, input)).rejects.toMatchObject({ code: 'MESSAGE_TRANSLATION_UNAVAILABLE' });
  });
  it.each([null, {}, { translations: null }, { translations: [] }, { translations: [null] }, { translations: [{ text: 12 }] }])('refuses malformed successful provider payload %#', async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })); await expect(translateMessage(buyer, input)).rejects.toMatchObject({ code: 'MESSAGE_TRANSLATION_UNAVAILABLE' });
  });
});
