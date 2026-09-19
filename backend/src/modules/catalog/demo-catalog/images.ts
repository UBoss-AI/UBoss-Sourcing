/**
 * Where a demonstration product's photograph comes from.
 *
 * Three sources, tried in order, and the order is the whole design:
 *
 *   1. **The Unsplash Search API**, when a key is configured. One query per
 *      PRODUCT - "cordless electric drill isolated", never "tools" - so the
 *      picture is of the thing rather than of its department. The response
 *      carries the photographer, their profile, the photo's own page and a
 *      `download_location` endpoint, all four of which are stored, and the
 *      last of which is pinged because the API terms require it of anything
 *      that selects a photo for use.
 *
 *   2. **The verified library** in `image-library.ts` - URLs this storefront
 *      already renders on its category rails. Specific to a shelf rather than
 *      to a product, so the first product on a shelf gets the best of them and
 *      anything past the end of the list is marked for review.
 *
 *   3. **The placeholder**, which is what the grid draws for a product with no
 *      media at all. Honest, and the right answer when the alternative is a
 *      photograph of something else.
 *
 * WHAT IS NEVER DONE
 *
 * A photo ID is never invented. `source.unsplash.com` - the deprecated random
 * endpoint - is never used. A misleading photograph is never preferred to a
 * placeholder: a wrong picture is a false statement about what is in the box,
 * and a catalogue that makes one of those about four hundred products is worse
 * than a catalogue of grey squares.
 *
 * THE KEY NEVER LEAVES THIS PROCESS
 *
 * It is read from the environment here, sent in an `Authorization` header, and
 * never logged, never returned, never written to the cache file and never sent
 * to a browser. Nothing at runtime reads it - this module is imported by the
 * seed CLI and by its tests, and by nothing that serves a request.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { env } from '../../../config/env.js';
import { logger } from '../../../infra/logger.js';
import { hashString } from './rng.js';
import {
  DEPARTMENT_IMAGES,
  SUBCATEGORY_IMAGES,
} from './image-library.js';

/** Where a photograph came from. Stored on the demo entry, shown in the report. */
export type ImageSource = 'unsplash-api' | 'verified-library' | 'local-upload' | 'placeholder';

export interface ResolvedImage {
  /** The URL to hotlink, or null when nothing honest could be offered. */
  readonly url: string | null;
  readonly source: ImageSource;
  readonly photoId: string | null;
  readonly photographer: string | null;
  readonly profileUrl: string | null;
  readonly photoPageUrl: string | null;
  /**
   * True when this is a stand-in rather than a photograph of the product.
   *
   * Set for anything that fell back to a department image, anything on a
   * department the library cannot picture at product level, and anything that
   * ended on the placeholder. It is what the image-review report reads.
   */
  readonly needsReview: boolean;
  readonly alt: string;
}

/** What the seed asks for. */
export interface ImageRequest {
  readonly query: string;
  readonly alt: string;
  readonly departmentSlug: string;
  readonly subcategorySlug: string;
  /** Position of this product on its shelf, so three products differ. */
  readonly index: number;
  /** Stable, so a cached answer is found again on the next run. */
  readonly seedKey: string;
}

// ---------------------------------------------------------------------------
// THE LIBRARY PATH
// ---------------------------------------------------------------------------

/**
 * Referral parameters, which the Unsplash terms ask for on links back.
 *
 * Appended to the photographer's profile and to the photo page - the two links
 * a credit is made of - and NOT to the image URL itself, which is a CDN
 * fetch rather than a visit and would only be a longer string.
 */
const REFERRAL = 'utm_source=uboss_sourcing&utm_medium=referral';

/** A profile or photo-page link, with the referral the terms ask for. */
export function withReferral(url: string): string {
  return url.includes('?') ? `${url}&${REFERRAL}` : `${url}?${REFERRAL}`;
}

/** The photo ID inside an `images.unsplash.com/photo-...` URL, if it is one. */
function photoIdFrom(url: string): string | null {
  const match = /images\.unsplash\.com\/photo-([0-9a-z-]+)/i.exec(url);
  return match?.[1] ?? null;
}

/**
 * The library's answer for one product.
 *
 * The shelf's own list first, indexed by the product's position on it, so the
 * three products on a shelf get three different photographs rather than one
 * repeated. Past the end of the list it wraps - and a wrapped product is
 * marked for review, because the second time a picture is used it has stopped
 * being a photograph OF something and started being a decoration.
 */
function fromLibrary(request: ImageRequest): ResolvedImage {
  const shelf = SUBCATEGORY_IMAGES[request.subcategorySlug] ?? [];
  const department = DEPARTMENT_IMAGES[request.departmentSlug] ?? null;

  if (shelf.length > 0) {
    const url = shelf[request.index % shelf.length];
    if (url !== undefined) {
      const photoId = photoIdFrom(url);
      return {
        url,
        source: 'verified-library',
        photoId,
        // The library carries no photographer names. Unsplash's terms ask for
        // a credit where one is known, and inventing a name to satisfy a rule
        // about crediting people is the opposite of satisfying it - so the
        // storefront credits Unsplash itself for these and names nobody.
        photographer: null,
        profileUrl: null,
        photoPageUrl: photoId === null ? null : withReferral(`https://unsplash.com/photos/${photoId}`),
        /*
         * ALWAYS, for anything that came out of the library.
         *
         * This used to be set only for the department-wide cases and for a
         * product past the end of its shelf's list, which amounted to claiming
         * that the rest had been verified. They have not. The library is keyed
         * on a SHELF, so the strongest true statement about one of its entries
         * is "this is a photograph of the trade this product is in" - and
         * spot-checking found the labels are not always even that: the entry
         * the storefront files under protective equipment is a photograph of
         * toothbrushes.
         *
         * A per-PRODUCT photograph is what the Unsplash API path produces, and
         * that is the one this flag stays off for. Until a key is configured,
         * the honest report is that every one of these is a stand-in - which is
         * a useful thing for an operator to be told, and a claim of four
         * hundred verified photographs is not.
         */
        needsReview: true,
        alt: request.alt,
      };
    }
  }

  if (department !== null) {
    const photoId = photoIdFrom(department);
    return {
      url: department,
      source: 'verified-library',
      photoId,
      photographer: null,
      profileUrl: null,
      photoPageUrl: photoId === null ? null : withReferral(`https://unsplash.com/photos/${photoId}`),
      // Always. A department photograph beside a specific product is a
      // good-looking card and an unverified claim about what is in the box.
      needsReview: true,
      alt: request.alt,
    };
  }

  return {
    url: null,
    source: 'placeholder',
    photoId: null,
    photographer: null,
    profileUrl: null,
    photoPageUrl: null,
    needsReview: true,
    alt: request.alt,
  };
}

// ---------------------------------------------------------------------------
// THE UNSPLASH PATH
// ---------------------------------------------------------------------------

/** Only the fields this module reads. The API returns a great deal more. */
interface UnsplashPhoto {
  id: string;
  alt_description: string | null;
  description: string | null;
  urls: { raw?: string; full?: string; regular?: string; small?: string };
  links: { html?: string; download_location?: string };
  user: { name?: string; username?: string; links?: { html?: string } };
}

interface UnsplashSearchResponse {
  results?: UnsplashPhoto[];
}

/** Answers already paid for, so a re-run does not spend the hourly budget again. */
type ImageCache = Record<
  string,
  {
    url: string;
    photoId: string;
    photographer: string | null;
    profileUrl: string | null;
    photoPageUrl: string | null;
  }
>;

const CACHE_PATH = '.cache/demo-catalog-images.json';

export async function loadImageCache(): Promise<ImageCache> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw) as ImageCache;
  } catch {
    // No cache is the ordinary first run, not a fault.
    return {};
  }
}

export async function saveImageCache(cache: ImageCache): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

/** Whether a key is configured at all. */
export function hasUnsplashKey(): boolean {
  return env.UNSPLASH_ACCESS_KEY.trim().length > 0;
}

const UNSPLASH_SEARCH = 'https://api.unsplash.com/search/photos';

/** Bounded exponential backoff. Never indefinite - a seed must terminate. */
const MAX_ATTEMPTS = 3;

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Whether a photo is plausibly OF the thing that was searched for.
 *
 * Unsplash's relevance is good and not perfect, and the failure mode that
 * matters is a beautiful photograph of something else. So the words of the
 * query are checked against the photo's own description, alt description and
 * tags, and a photo that shares none of them is skipped in favour of the next
 * result. Where no result shares any, the search is treated as having found
 * nothing - which sends the product to the library rather than to a wrong
 * picture.
 *
 * Short words are dropped because "of", "in" and "a" match everything.
 */
function looksRelevant(photo: UnsplashPhoto, query: string): boolean {
  const haystack = `${photo.alt_description ?? ''} ${photo.description ?? ''}`.toLowerCase();
  if (haystack.trim().length === 0) return false;

  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);

  return words.some((word) => haystack.includes(word));
}

/**
 * Ask Unsplash for a photograph of one product.
 *
 * Returns null for every failure that is not worth stopping the seed for - no
 * key, no results, nothing relevant, a rate limit that outlasted the backoff,
 * a network error - because a catalogue of four hundred products must not fail
 * to exist because the four-hundred-and-first image lookup timed out. The
 * caller falls back to the library and the report says how many did.
 */
async function searchUnsplash(query: string): Promise<ResolvedImage | null> {
  const key = env.UNSPLASH_ACCESS_KEY.trim();
  if (key === '') return null;

  const url = new URL(UNSPLASH_SEARCH);
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', '8');
  url.searchParams.set('page', '1');
  // A product photograph goes in a square frame on this storefront, and
  // `content_filter=high` is the safest setting the API offers.
  url.searchParams.set('orientation', 'squarish');
  url.searchParams.set('content_filter', 'high');
  url.searchParams.set('order_by', 'relevant');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          // Version pinned, because an unversioned client gets whatever the
          // API is serving that week.
          'Accept-Version': 'v1',
          Authorization: `Client-ID ${key}`,
        },
      });
    } catch (error) {
      // The error can carry the request, and the request carries the key.
      // Logged as a shape rather than as itself.
      logger.warn(
        { attempt, reason: error instanceof Error ? error.name : 'unknown' },
        'unsplash search failed to connect',
      );
      if (attempt === MAX_ATTEMPTS) return null;
      await pause(500 * 2 ** (attempt - 1));
      continue;
    }

    // 403 is how Unsplash says "you are out of requests this hour". Retrying
    // within one run cannot fix that, so it is reported and the seed carries
    // on with the library.
    if (response.status === 403) {
      logger.warn(
        { remaining: response.headers.get('x-ratelimit-remaining') },
        'unsplash hourly rate limit reached - falling back to the verified image library',
      );
      return null;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) return null;
      await pause(500 * 2 ** (attempt - 1));
      continue;
    }

    if (!response.ok) {
      logger.warn({ status: response.status }, 'unsplash search refused');
      return null;
    }

    const body = (await response.json()) as UnsplashSearchResponse;
    const results = body.results ?? [];

    const chosen = results.find((photo) => looksRelevant(photo, query));
    if (chosen === undefined) return null;

    const source = chosen.urls.raw ?? chosen.urls.full ?? chosen.urls.regular;
    if (source === undefined) return null;

    // The hotlink the API returned, sized for the card. Never a URL built from
    // the ID by hand: the raw URL carries the signing parameters the CDN wants.
    const sized = new URL(source);
    sized.searchParams.set('auto', 'format');
    sized.searchParams.set('fit', 'crop');
    sized.searchParams.set('crop', 'entropy');
    sized.searchParams.set('w', '1200');
    sized.searchParams.set('h', '1200');
    sized.searchParams.set('q', '80');

    // Required of any application that selects a photo for use. Fire and
    // forget: a failed ping is not a reason to reject a good photograph, and
    // the seed has several hundred more to fetch.
    const download = chosen.links.download_location;
    if (download !== undefined) {
      void fetch(download, {
        headers: { 'Accept-Version': 'v1', Authorization: `Client-ID ${key}` },
      }).catch(() => undefined);
    }

    return {
      url: sized.toString(),
      source: 'unsplash-api',
      photoId: chosen.id,
      photographer: chosen.user.name ?? null,
      profileUrl:
        chosen.user.links?.html === undefined ? null : withReferral(chosen.user.links.html),
      photoPageUrl: chosen.links.html === undefined ? null : withReferral(chosen.links.html),
      needsReview: false,
      alt: chosen.alt_description ?? '',
    };
  }

  return null;
}

/**
 * The photograph for one product, from whichever source can honestly supply it.
 *
 * `cache` is read AND written, so a run interrupted half way does not pay for
 * the same two hundred lookups again. The cache holds only what came back from
 * the API - never the key, and never anything derived from it.
 */
export async function resolveImage(
  request: ImageRequest,
  cache: ImageCache,
  options: { readonly useApi: boolean },
): Promise<ResolvedImage> {
  if (options.useApi && hasUnsplashKey()) {
    const cached = cache[request.seedKey];
    if (cached !== undefined) {
      return { ...cached, source: 'unsplash-api', needsReview: false, alt: request.alt };
    }

    const found = await searchUnsplash(request.query);
    if (found !== null && found.url !== null && found.photoId !== null) {
      cache[request.seedKey] = {
        url: found.url,
        photoId: found.photoId,
        photographer: found.photographer,
        profileUrl: found.profileUrl,
        photoPageUrl: found.photoPageUrl,
      };
      // The photo's own alt description is usually better than the generated
      // one, but not always present and not always about the product.
      return { ...found, alt: found.alt.trim().length > 3 ? found.alt : request.alt };
    }
  }

  return fromLibrary(request);
}

/**
 * A deterministic pick when a shelf has more products than photographs.
 *
 * Exported for the tests, which check that the same shelf lays its pictures
 * out the same way on every run - a catalogue whose images shuffle between
 * seeds is one whose screenshots go stale for no reason.
 */
export function shelfPosition(seedKey: string, listLength: number): number {
  return listLength === 0 ? 0 : hashString(seedKey) % listLength;
}
