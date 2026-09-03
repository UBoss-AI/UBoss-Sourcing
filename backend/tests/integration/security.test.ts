/**
 * Security threat cases - the list from Dev Plan section 11.1, tested directly.
 *
 * These are not feature tests. Each one is an attack that must fail, written
 * from the attacker's side rather than the happy path's. A regression here is
 * a breach, not a bug.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { env } from '../../src/config/env.js';
import {
  ALL_PERMISSIONS,
  Permission,
  Role,
  canGrantRole,
  permissionsForRoles,
} from '../../src/domain/permissions.js';
import { calculateTax, parseMajorToMinor } from '../../src/domain/money.js';
import { assertTotalsConsistent, priceLines } from '../../src/domain/pricing.js';
import { canTransition } from '../../src/domain/order-state-machine.js';
import {
  decryptSecret,
  encryptSecret,
  hashRequestBody,
  hashPassword,
  safeCompare,
  verifyPassword,
} from '../../src/infra/crypto.js';
import { isCleanHtml, sanitiseProductHtml, stripHtml } from '../../src/infra/sanitize.js';
import { sniffImageType } from '../../src/infra/storage/index.js';
import { RazorpayAdapter } from '../../src/modules/payments/razorpay.adapter.js';
import { PUBLIC_PRODUCT_SELECT } from '../../src/modules/catalog/catalog.visibility.js';

describe('stored XSS in product content', () => {
  /**
   * The field the schema always claimed was "sanitised HTML only". It is now
   * actually sanitised on write, so no reader has to remember.
   */
  it('strips script tags entirely', () => {
    expect(sanitiseProductHtml('<script>alert(1)</script>')).toBeNull();
    expect(sanitiseProductHtml('<p>Safe</p><script>steal()</script>')).toBe('<p>Safe</p>');
  });

  it('strips event handlers', () => {
    const cleaned = sanitiseProductHtml('<p onclick="steal()" onmouseover="x()">Text</p>');
    expect(cleaned).toBe('<p>Text</p>');
    expect(cleaned).not.toContain('onclick');
  });

  it('refuses javascript: and data: URLs', () => {
    expect(sanitiseProductHtml('<a href="javascript:alert(1)">Click</a>')).not.toContain(
      'javascript:',
    );
    expect(
      sanitiseProductHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">Click</a>'),
    ).not.toContain('data:');
  });

  it('keeps a legitimate link but never hands over the opener window', () => {
    const cleaned = sanitiseProductHtml('<a href="https://example.com">Spec sheet</a>') ?? '';

    expect(cleaned).toContain('https://example.com');
    // Without noopener the linked page can navigate the storefront tab to a
    // phishing clone.
    expect(cleaned).toContain('noopener');
    expect(cleaned).toContain('noreferrer');
  });

  it('drops iframes, objects, forms and svg', () => {
    for (const payload of [
      '<iframe src="https://evil.test"></iframe>',
      '<object data="evil.swf"></object>',
      '<form action="https://evil.test"><input name="card"></form>',
      '<svg onload="alert(1)"></svg>',
    ]) {
      const cleaned = sanitiseProductHtml(payload) ?? '';
      expect(cleaned).not.toMatch(/<(iframe|object|form|input|svg)/i);
    }
  });

  it('drops style attributes, which can overlay a Buy button', () => {
    const cleaned = sanitiseProductHtml(
      '<p style="position:fixed;top:0;left:0;width:100vw;height:100vh">x</p>',
    );
    expect(cleaned).not.toContain('style');
  });

  it('survives nested and malformed markup without leaking a tag', () => {
    for (const payload of [
      '<scr<script>ipt>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<<SCRIPT>alert(1)//<</SCRIPT>',
      '<p><script>alert(1)</script></p>',
    ]) {
      const cleaned = sanitiseProductHtml(payload) ?? '';
      expect(cleaned.toLowerCase()).not.toContain('<script');
      expect(cleaned.toLowerCase()).not.toContain('onerror');
    }
  });

  it('strips markup completely from plain-text fields', () => {
    expect(stripHtml('<b>Bold</b> text')).toBe('Bold text');
    expect(stripHtml('<script>alert(1)</script>')).toBeNull();
  });

  it('can tell the admin UI whether formatting will be removed', () => {
    expect(isCleanHtml('<p>Fine</p>')).toBe(true);
    expect(isCleanHtml('<p onclick="x()">Not fine</p>')).toBe(false);
  });
});

describe('malicious file upload', () => {
  /** The client's Content-Type is not evidence. Only the bytes are. */
  it('rejects a text file claiming to be a PNG', () => {
    expect(() => sniffImageType(Buffer.from('not-an-image-at-all', 'utf8'))).toThrow();
  });

  it('rejects an SVG, which is a script-capable document', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
    expect(() => sniffImageType(svg)).toThrow();
  });

  it('rejects an HTML file with an image extension', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    expect(() => sniffImageType(html)).toThrow();
  });

  it('rejects a polyglot whose magic bytes are wrong', () => {
    // GIF header text without the real signature bytes.
    expect(() => sniffImageType(Buffer.from('GIF8<script>alert(1)</script>', 'utf8'))).toThrow();
  });

  it('accepts a genuine PNG', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    expect(sniffImageType(png)).toEqual({ mimeType: 'image/png', extension: 'png' });
  });
});

describe('privilege escalation', () => {
  /**
   * Without this, an Order Manager holding role.assign could mint a Business
   * Owner and escalate to everything.
   */
  it('an admin cannot grant a role broader than their own', () => {
    const orderManager = permissionsForRoles([Role.ORDER_MANAGER]);
    const owner = permissionsForRoles([Role.BUSINESS_OWNER]);

    expect(canGrantRole(orderManager, Role.BUSINESS_OWNER)).toBe(false);
    expect(canGrantRole(owner, Role.BUSINESS_OWNER)).toBe(true);
  });

  it('role.assign alone is not enough to grant a broader role', () => {
    const almost = new Set([...permissionsForRoles([Role.ORDER_MANAGER]), Permission.ROLE_ASSIGN]);
    expect(canGrantRole(almost, Role.BUSINESS_OWNER)).toBe(false);
    // But it CAN grant a role it fully covers.
    expect(canGrantRole(almost, Role.CUSTOMER)).toBe(true);
  });

  it('a customer holds no admin permission at all', () => {
    expect([...permissionsForRoles([Role.CUSTOMER])]).toEqual([]);
  });

  it('separates the permissions the SOP separates', () => {
    const catalog = permissionsForRoles([Role.CATALOG_MANAGER]);
    const orders = permissionsForRoles([Role.ORDER_MANAGER]);
    const finance = permissionsForRoles([Role.FINANCE_APPROVER]);

    // SOP 3: "No payment configuration unless granted."
    expect(catalog.has(Permission.PAYMENT_GATEWAY_WRITE)).toBe(false);
    // SOP 3: "Refund action may require Finance permission."
    expect(orders.has(Permission.REFUND_CREATE)).toBe(false);
    expect(finance.has(Permission.REFUND_CREATE)).toBe(true);
    // SOP 3: "No catalog deletion by default."
    expect(finance.has(Permission.PRODUCT_ARCHIVE)).toBe(false);
  });

  it('only the Business Owner holds every permission', () => {
    for (const role of [
      Role.CATALOG_MANAGER,
      Role.INVENTORY_MANAGER,
      Role.ORDER_MANAGER,
      Role.FINANCE_APPROVER,
    ]) {
      expect(permissionsForRoles([role]).size).toBeLessThan(ALL_PERMISSIONS.length);
    }
    expect(permissionsForRoles([Role.BUSINESS_OWNER]).size).toBe(ALL_PERMISSIONS.length);
  });
});

describe('price manipulation between cart and payment', () => {
  /**
   * The client never supplies a price. This asserts the arithmetic a tampered
   * total would have to defeat.
   */
  it('detects totals that do not match their lines', () => {
    const priced = priceLines([
      {
        product: {
          productId: '01A',
          variantId: null,
          name: 'Bolt',
          sku: 'B1',
          variantName: null,
          unitPriceMinor: 4550n,
          taxClassCode: 'GST18',
          taxRatePercent: '18.000000',
          taxInclusive: false,
          isRecurringEligible: false,
          imageUrl: null,
        },
        quantity: 20,
      },
    ]);

    expect(() => assertTotalsConsistent(priced.lines, priced.totals)).not.toThrow();

    // A tampered grand total is caught before anything is written or charged.
    expect(() =>
      assertTotalsConsistent(priced.lines, { ...priced.totals, grandTotalMinor: 1n }),
    ).toThrow();
  });

  it('refuses a negative order total', () => {
    expect(() =>
      assertTotalsConsistent([], {
        subtotalMinor: 0n,
        discountMinor: 0n,
        taxMinor: 0n,
        shippingMinor: 0n,
        grandTotalMinor: -1n,
      }),
    ).toThrow();
  });

  it('refuses a discount larger than the line', () => {
    expect(() =>
      priceLines(
        [
          {
            product: {
              productId: '01A',
              variantId: null,
              name: 'Bolt',
              sku: 'B1',
              variantName: null,
              unitPriceMinor: 100n,
              taxClassCode: 'GST18',
              taxRatePercent: '18.000000',
              taxInclusive: false,
              isRecurringEligible: false,
              imageUrl: null,
            },
            quantity: 1,
          },
        ],
        { orderDiscountMinor: 999_999n },
      ),
    ).toThrow();
  });

  it('keeps tax exact at awkward amounts, so no rounding can be farmed', () => {
    for (const gross of [1n, 7n, 999n, 33_333n, 100_001n]) {
      const inclusive = calculateTax(gross, '18.000000', true);
      expect(inclusive.netMinor + inclusive.taxMinor).toBe(gross);
    }
  });

  it('never lets a decimal money string through', () => {
    expect(() => parseMajorToMinor('1e10', 'INR')).toThrow();
    expect(() => parseMajorToMinor('-0.01', 'INR')).not.toThrow();
  });
});

describe('forged and replayed payment webhooks', () => {
  const adapter = new RazorpayAdapter({
    keyId: 'rzp_test_x',
    keySecret: 'secret',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  });

  const body = Buffer.from(
    JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: 'pay_1', order_id: 'order_1', amount: 100, currency: 'INR', status: 'captured' },
        },
      },
    }),
    'utf8',
  );

  function sign(buffer: Buffer, secret: string): string {
    return createHmac('sha256', secret).update(buffer).digest('hex');
  }

  it('rejects a signature from the wrong secret', () => {
    const forged = sign(body, 'attacker-secret');
    expect(adapter.verifyWebhook(body, { 'x-razorpay-signature': forged }).verified).toBe(false);
  });

  it('rejects a body altered after signing', () => {
    const signature = sign(body, env.RAZORPAY_WEBHOOK_SECRET);
    const tampered = Buffer.from(body.toString('utf8').replace('"amount":100', '"amount":1'), 'utf8');

    expect(adapter.verifyWebhook(tampered, { 'x-razorpay-signature': signature }).verified).toBe(
      false,
    );
  });

  it('rejects an empty or truncated signature', () => {
    for (const signature of ['', 'abc', 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(adapter.verifyWebhook(body, { 'x-razorpay-signature': signature }).verified).toBe(
        false,
      );
    }
  });

  it('accepts only the genuine signature', () => {
    const signature = sign(body, env.RAZORPAY_WEBHOOK_SECRET);
    expect(adapter.verifyWebhook(body, { 'x-razorpay-signature': signature }).verified).toBe(true);
  });

  /** A signature over a re-serialised object would never match the raw bytes. */
  it('is sensitive to whitespace, proving it signs the raw bytes', () => {
    const signature = sign(body, env.RAZORPAY_WEBHOOK_SECRET);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))) + ' ', 'utf8');

    expect(adapter.verifyWebhook(reserialised, { 'x-razorpay-signature': signature }).verified).toBe(
      false,
    );
  });
});

describe('order state machine as an authorisation boundary', () => {
  it('no actor can reach CONFIRMED except SYSTEM', () => {
    const everyPermission = [...ALL_PERMISSIONS];

    expect(
      canTransition({
        from: 'PENDING_PAYMENT',
        to: 'CONFIRMED',
        actor: 'ADMIN',
        permissions: everyPermission,
      }),
    ).toBe(false);

    expect(
      canTransition({ from: 'PENDING_PAYMENT', to: 'CONFIRMED', actor: 'CUSTOMER' }),
    ).toBe(false);

    expect(canTransition({ from: 'PENDING_PAYMENT', to: 'CONFIRMED', actor: 'SYSTEM' })).toBe(true);
  });

  it('a paid order cannot be reopened for payment', () => {
    for (const actor of ['ADMIN', 'CUSTOMER', 'SYSTEM'] as const) {
      expect(
        canTransition({
          from: 'CONFIRMED',
          to: 'PENDING_PAYMENT',
          actor,
          permissions: [...ALL_PERMISSIONS],
        }),
      ).toBe(false);
    }
  });

  it('a customer cannot fulfil, approve or refund their own order', () => {
    expect(canTransition({ from: 'CONFIRMED', to: 'PROCESSING', actor: 'CUSTOMER' })).toBe(false);
    expect(canTransition({ from: 'SHIPPED', to: 'DELIVERED', actor: 'CUSTOMER' })).toBe(false);
    expect(canTransition({ from: 'CANCELLED', to: 'REFUNDED', actor: 'CUSTOMER' })).toBe(false);
  });
});

describe('credential and token handling', () => {
  it('never stores a password recoverably', async () => {
    const hash = await hashPassword('CorrectHorseBattery!2026');

    expect(hash).not.toContain('CorrectHorseBattery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'CorrectHorseBattery!2026')).toBe(true);
  });

  it('compares attacker-submittable values in constant time', () => {
    expect(safeCompare('token', 'token')).toBe(true);
    expect(safeCompare('token', 'toke0')).toBe(false);
    // A length mismatch returns false rather than throwing.
    expect(safeCompare('short', 'longer-value')).toBe(false);
  });

  /** A credential row copied to another record must not decrypt. */
  it('binds an encrypted secret to the record it belongs to', () => {
    const envelope = encryptSecret('rzp_test_secret', 'payment_connection:01AAA');

    expect(decryptSecret(envelope, 'payment_connection:01AAA')).toBe('rzp_test_secret');
    expect(() => decryptSecret(envelope, 'payment_connection:01BBB')).toThrow();
    expect(() => decryptSecret(envelope)).toThrow();
  });

  it('detects any tampering with stored ciphertext', () => {
    const envelope = encryptSecret('secret-value');
    const parts = envelope.split(':');

    for (const index of [1, 2, 3]) {
      const broken = [...parts];
      broken[index] = 'AAAAAAAAAAAAAAAAAAAA';
      expect(() => decryptSecret(broken.join(':'))).toThrow();
    }
  });

  /** A reordered replay is still the same request and must be recognised. */
  it('hashes request bodies independently of key order', () => {
    expect(hashRequestBody({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequestBody({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }));
  });
});

describe('public data exposure', () => {
  /**
   * The public select is an allowlist. Adding an internal column to the schema
   * must not silently start exposing it.
   */
  it('never names an internal column in the public product select', () => {
    const exposed = Object.keys(PUBLIC_PRODUCT_SELECT);

    for (const internal of [
      'createdById',
      'updatedById',
      'reorderThreshold',
      'archivedAt',
      'publishFrom',
      'weightGrams',
    ]) {
      expect(exposed, `${internal} must not be publicly selected`).not.toContain(internal);
    }
  });

  it('exposes only the fields a storefront needs', () => {
    const exposed = Object.keys(PUBLIC_PRODUCT_SELECT);

    for (const expected of ['id', 'name', 'slug', 'basePriceMinor', 'minOrderQty']) {
      expect(exposed).toContain(expected);
    }
  });
});
