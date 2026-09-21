/**
 * The tags a crawler and a link preview read.
 *
 * Run against jsdom, so these assert what actually lands in `document.head`
 * rather than what the code intends to put there. The two that matter most are
 * the cleanup - a product's Open Graph image left attached to the cart is the
 * bug this whole file is shaped around - and the `noIndex` refusal, because
 * canonicalising a checkout URL is an invitation to index somebody's order.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  SEO_LANGUAGES,
  applyJsonLd,
  applySeoTags,
  breadcrumbJsonLd,
  canonicalUrl,
  productJsonLd,
} from './seo';

afterEach(() => {
  for (const element of document.head.querySelectorAll('[data-seo], [data-seo-jsonld]')) {
    element.remove();
  }
});

function base(overrides: Partial<Parameters<typeof applySeoTags>[0]> = {}) {
  return {
    pathname: '/product/hex-bolt-m8',
    title: 'Hex Bolt M8 · UBOSS',
    description: 'A hex bolt.',
    siteName: 'UBOSS',
    ...overrides,
  };
}

function head(selector: string): string[] {
  return [...document.head.querySelectorAll(selector)].map(
    (element) => element.getAttribute('href') ?? element.getAttribute('content') ?? '',
  );
}

describe('canonical and language alternates', () => {
  it('writes one canonical for the current path', () => {
    applySeoTags(base());

    const canonicals = head('link[rel="canonical"]');
    expect(canonicals).toHaveLength(1);
    expect(canonicals[0]).toBe(canonicalUrl('/product/hex-bolt-m8'));
  });

  it('writes an alternate for every shipped language, plus x-default', () => {
    // The storefront serves eight languages from the same URL. Without these,
    // a crawler reads one page whose content changes unpredictably and ranks
    // none of the eight for its own audience.
    applySeoTags(base());

    const alternates = [...document.head.querySelectorAll('link[rel="alternate"]')];
    const langs = alternates.map((element) => element.getAttribute('hreflang'));

    for (const language of SEO_LANGUAGES) expect(langs).toContain(language);
    expect(langs).toContain('x-default');
    expect(alternates).toHaveLength(SEO_LANGUAGES.length + 1);
  });

  it('points x-default at the unparameterised URL', () => {
    applySeoTags(base());

    const xDefault = document.head.querySelector('link[hreflang="x-default"]');
    expect(xDefault?.getAttribute('href')).toBe(canonicalUrl('/product/hex-bolt-m8'));
  });
});

describe('sharing tags', () => {
  it('writes Open Graph and Twitter tags', () => {
    applySeoTags(base({ type: 'product', imageUrl: '/media/bolt.jpg' }));

    expect(head('meta[property="og:type"]')).toEqual(['product']);
    expect(head('meta[property="og:title"]')).toEqual(['Hex Bolt M8 · UBOSS']);
    expect(head('meta[property="og:site_name"]')).toEqual(['UBOSS']);
    expect(head('meta[name="twitter:card"]')).toEqual(['summary_large_image']);
  });

  it('makes a root-relative image absolute', () => {
    // A relative og:image is ignored by every scraper that reads it.
    applySeoTags(base({ imageUrl: '/media/bolt.jpg' }));

    const image = head('meta[property="og:image"]')[0] ?? '';
    expect(image.startsWith('http')).toBe(true);
    expect(image.endsWith('/media/bolt.jpg')).toBe(true);
  });

  it('leaves an already absolute image alone', () => {
    applySeoTags(base({ imageUrl: 'https://cdn.example.test/bolt.jpg' }));
    expect(head('meta[property="og:image"]')).toEqual(['https://cdn.example.test/bolt.jpg']);
  });

  it('falls back to a plain summary card with no image', () => {
    applySeoTags(base());

    expect(head('meta[name="twitter:card"]')).toEqual(['summary']);
    expect(document.head.querySelector('meta[property="og:image"]')).toBeNull();
  });
});

describe('pages that must never be indexed', () => {
  it('writes nothing at all for a noIndex page', () => {
    // A checkout URL carries an order number. Canonicalising it asks a crawler
    // to index it, and an og:description leaks it into whatever chat client
    // the link is pasted into.
    applySeoTags(base({ pathname: '/checkout/01J8', noIndex: true }));

    expect(document.head.querySelectorAll('[data-seo]')).toHaveLength(0);
  });
});

describe('cleanup', () => {
  it('removes everything it wrote', () => {
    // The bug this is shaped around: navigating from a product to the cart
    // must not leave the product's image and description attached to it.
    const cleanup = applySeoTags(base({ imageUrl: '/media/bolt.jpg' }));
    expect(document.head.querySelectorAll('[data-seo]').length).toBeGreaterThan(0);

    cleanup();
    expect(document.head.querySelectorAll('[data-seo]')).toHaveLength(0);
  });

  it('does not touch tags it did not write', () => {
    const font = document.createElement('link');
    font.rel = 'preconnect';
    font.href = 'https://fonts.googleapis.com';
    document.head.appendChild(font);

    applySeoTags(base())();

    expect(document.head.querySelector('link[rel="preconnect"]')).not.toBeNull();
    font.remove();
  });
});

describe('product structured data', () => {
  const product = {
    name: 'Hex Bolt M8',
    description: 'Zinc plated.',
    sku: 'HEX-M8-40',
    brand: 'Northwind',
    imageUrls: ['https://cdn.example.test/bolt.jpg'],
    url: 'https://shop.example.test/product/hex-bolt-m8',
    price: '1499.50',
    currency: 'INR',
    inStock: true,
  };

  it('publishes an offer with the exact decimal string', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. schema.org permits a number and
    // Google accepts one, but putting the price through `Number` here would
    // reintroduce, in the last hundred lines of the stack, the float error the
    // whole money design exists to avoid.
    const data = productJsonLd(product);
    const offer = data['offers'] as Record<string, unknown>;

    expect(offer['price']).toBe('1499.50');
    expect(typeof offer['price']).toBe('string');
    expect(offer['priceCurrency']).toBe('INR');
    expect(offer['availability']).toBe('https://schema.org/InStock');
  });

  it('marks an out-of-stock product as such', () => {
    const data = productJsonLd({ ...product, inStock: false });
    const offer = data['offers'] as Record<string, unknown>;

    expect(offer['availability']).toBe('https://schema.org/OutOfStock');
  });

  it('omits the offer entirely when the price was converted', () => {
    // An approximate figure is honest on a page that captions it as one and
    // dishonest in a rich result that cannot. Google treats a price in
    // structured data as a commitment.
    const data = productJsonLd({ ...product, priceIsApproximate: true });
    expect(data['offers']).toBeUndefined();
  });

  it('omits the offer when there is no price at all', () => {
    expect(productJsonLd({ ...product, price: null })['offers']).toBeUndefined();
    expect(productJsonLd({ ...product, currency: null })['offers']).toBeUndefined();
  });

  it('omits a brand rather than publishing an empty one', () => {
    expect(productJsonLd({ ...product, brand: null })['brand']).toBeUndefined();
  });

  it('carries the type and the SKU', () => {
    const data = productJsonLd(product);

    expect(data['@type']).toBe('Product');
    expect(data['@context']).toBe('https://schema.org');
    expect(data['sku']).toBe('HEX-M8-40');
  });
});

describe('breadcrumbs', () => {
  it('numbers positions from one', () => {
    const data = breadcrumbJsonLd([
      { name: 'Catalogue', path: '/catalog' },
      { name: 'Fasteners', path: '/catalog/fasteners' },
    ]);

    const items = data['itemListElement'] as Record<string, unknown>[];

    expect(items).toHaveLength(2);
    expect(items[0]?.['position']).toBe(1);
    expect(items[1]?.['position']).toBe(2);
    expect(items[1]?.['name']).toBe('Fasteners');
  });
});

describe('the JSON-LD block itself', () => {
  it('writes valid JSON into a script tag', () => {
    const cleanup = applyJsonLd('product', { '@type': 'Product', name: 'Bolt' });

    const script = document.head.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    expect(JSON.parse(script?.textContent ?? '{}')).toMatchObject({ name: 'Bolt' });

    cleanup();
    expect(document.head.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  it('escapes a closing tag hidden in a product name', () => {
    // A seller-supplied name is attacker-controlled text going into a script
    // element. `</script>` cannot appear in JSON syntax but can sit inside a
    // JSON string value, and the browser would end the element there.
    applyJsonLd('product', { name: '</script><img onerror=alert(1)>' });

    const script = document.head.querySelector('script[type="application/ld+json"]');
    expect(script?.textContent).not.toContain('</script>');
    expect(script?.textContent).toContain('\\u003c');

    // And it is still parseable, which the escape must not break.
    expect(JSON.parse(script?.textContent ?? '{}')).toMatchObject({
      name: '</script><img onerror=alert(1)>',
    });
  });
});
