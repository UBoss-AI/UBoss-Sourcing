/**
 * Product reviews: what buyers thought of a product, scored four ways.
 *
 * A buyer who has received a product scores it 1 to 5 for quality, delivery,
 * experience and support - scores only, no comment. The server decides who may
 * review (an order of theirs containing the product has been delivered) and
 * computes every average; this file only carries the shapes and the calls.
 *
 * Kept apart from the components that draw them, for the Fast Refresh reason
 * `product-instructions.ts` gives: a component file that also exports plain
 * values remounts the tree on every save.
 */
import { api } from './api';
import { formatNumber } from './format';
import type { TranslationKey } from '@/i18n/i18n-context';

/** The four things a buyer scores, in the order every screen shows them. */
export const RATING_CATEGORIES = ['quality', 'delivery', 'experience', 'support'] as const;
export type RatingCategory = (typeof RATING_CATEGORIES)[number];
export type RatingScores = Record<RatingCategory, number>;

/** The label and the one-line question under it, per category. */
export const RATING_CATEGORY_KEYS: Record<RatingCategory, { label: TranslationKey; hint: TranslationKey }> = {
  quality: { label: 'reviews.category.quality', hint: 'reviews.categoryHint.quality' },
  delivery: { label: 'reviews.category.delivery', hint: 'reviews.categoryHint.delivery' },
  experience: { label: 'reviews.category.experience', hint: 'reviews.categoryHint.experience' },
  support: { label: 'reviews.category.support', hint: 'reviews.categoryHint.support' },
};

/** The short form on a card: one average and how many reviews it is over. */
export interface RatingBadge {
  average: number;
  count: number;
}

export interface RatingSummary extends RatingBadge {
  categories: RatingScores;
  /** Reviews per whole star. Index 0 is one star, index 4 is five. */
  distribution: [number, number, number, number, number];
}

export interface PublicReview {
  id: string;
  reviewerName: string;
  scores: RatingScores;
  average: number;
  createdAt: string;
  editedAt: string | null;
  /** The seller's public answer, when one was written and staff have not hidden it. Absent from an older API. */
  response?: { sellerName: string; body: string; at: string } | null;
}

/** Signed inspections on a seller's orders. Shown beside ratings, never averaged in. */
export interface InspectionSummary {
  months: number;
  reports: number;
  passed: number;
  failed: number;
}

/** Buyers' rating of a seller's delivery and support across what it sold. */
export interface SellerReviewScore {
  average: number;
  count: number;
}

/** The longest answer a seller may publish under a review. */
export const SELLER_RESPONSE_MAX_LENGTH = 1000;

export interface SellerReviewResponse {
  body: string;
  status: 'PUBLISHED' | 'HIDDEN';
  at: string | null;
  hiddenReason: string | null;
}

export interface SellerReview {
  id: string;
  product: { name: string; slug: string };
  reviewerName: string;
  scores: RatingScores;
  average: number;
  status: 'PUBLISHED' | 'HIDDEN';
  createdAt: string;
  response: SellerReviewResponse | null;
}

export interface SellerReviewsResponse {
  reviews: SellerReview[];
  score: (SellerReviewScore & { delivery: number; support: number }) | null;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export function fetchSellerReviews(page: number): Promise<SellerReviewsResponse> {
  return api.get<SellerReviewsResponse>('/seller/product-reviews', { query: { page, limit: 20 } });
}

export async function saveSellerResponse(reviewId: string, body: string): Promise<SellerReviewResponse> {
  const response = await api.put<{ response: SellerReviewResponse }>(
    `/seller/product-reviews/${reviewId}/response`,
    { body },
  );
  return response.response;
}

export interface PublicReviewsResponse {
  productId: string;
  summary: RatingSummary | null;
  reviews: PublicReview[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export type ReviewSort = 'recent' | 'highest' | 'lowest';

export interface OwnReview {
  id: string;
  productId: string;
  scores: RatingScores;
  status: 'PUBLISHED' | 'HIDDEN';
  /** Why staff hid it. Null while published. */
  moderationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OwnReviewState {
  /** False only for somebody with no delivered order of this product. */
  canReview: boolean;
  review: OwnReview | null;
}

export interface OwnReviewListItem extends OwnReview {
  productName: string;
  productSlug: string;
  imageUrl: string | null;
}

export interface AwaitingReview {
  productId: string;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  orderedAt: string;
  orderNumber: string;
}

/** Whole numbers as they are, anything else to one decimal. */
export function formatRating(value: number): string {
  return formatNumber(Number.isInteger(value) ? value : Math.round(value * 10) / 10);
}

// --- Cache keys -------------------------------------------------------------
// Shared so a save from the order page's dialog refreshes the product page,
// the account list and every card showing the same product.

export const reviewKeys = {
  all: ['product-reviews'] as const,
  publicList: (slug: string, page: number, sort: ReviewSort) =>
    ['product-reviews', 'public', slug, page, sort] as const,
  own: (productId: string) => ['product-reviews', 'own', productId] as const,
  mine: (language: string) => ['product-reviews', 'mine', language] as const,
  reviewed: (productIds: readonly string[]) =>
    ['product-reviews', 'reviewed', [...productIds].sort().join(',')] as const,
};

// --- Calls ------------------------------------------------------------------

export function fetchPublicReviews(
  slug: string,
  options: { page: number; sort: ReviewSort; limit?: number },
): Promise<PublicReviewsResponse> {
  return api.get<PublicReviewsResponse>(`/catalog/products/${encodeURIComponent(slug)}/reviews`, {
    query: { page: options.page, sort: options.sort, limit: options.limit ?? 10 },
  });
}

export function fetchOwnReview(productId: string): Promise<OwnReviewState> {
  return api.get<OwnReviewState>(`/account/products/${productId}/review`);
}

export async function saveOwnReview(
  productId: string,
  input: { scores: RatingScores },
): Promise<OwnReview> {
  const response = await api.put<{ review: OwnReview }>(
    `/account/products/${productId}/review`,
    input,
  );
  return response.review;
}

export async function deleteOwnReview(reviewId: string): Promise<void> {
  await api.delete(`/account/product-reviews/${reviewId}`);
}

export function fetchMyReviews(
  language: string,
): Promise<{ reviews: OwnReviewListItem[]; awaiting: AwaitingReview[] }> {
  return api.get(`/account/product-reviews`, { query: { language } });
}

export async function fetchReviewedProductIds(productIds: readonly string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const response = await api.get<{ productIds: string[] }>(`/account/product-reviews/reviewed`, {
    query: { productIds: productIds.join(',') },
  });
  return new Set(response.productIds);
}
