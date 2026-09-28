/**
 * Product reviews, as staff see them: every review, who wrote it, and
 * whether it is shown on the storefront.
 *
 * Buyers score a product they received for quality, delivery, experience and
 * support. A review is published the moment it is written; staff can hide one
 * that breaks the rules - with a reason the buyer is shown - and put it back.
 */
import { api } from './api';

export const RATING_CATEGORIES = ['quality', 'delivery', 'experience', 'support'] as const;
export type RatingCategory = (typeof RATING_CATEGORIES)[number];

export type ReviewStatus = 'PUBLISHED' | 'HIDDEN';

export interface AdminReview {
  id: string;
  product: { id: string; name: string; sku: string; slug: string };
  customer: { id: string; name: string; email: string };
  orderId: string | null;
  orderNumber: string | null;
  scores: Record<RatingCategory, number>;
  average: number;
  status: ReviewStatus;
  moderationReason: string | null;
  moderatedAt: string | null;
  moderatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReviewPage {
  reviews: AdminReview[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** The same ceiling as the column. */
export const MAX_MODERATION_REASON_CHARS = 500;

export function fetchReviews(params: URLSearchParams): Promise<AdminReviewPage> {
  return api.get(`/admin/product-reviews?${params.toString()}`);
}

export function moderateReview(
  id: string,
  input: { status: ReviewStatus; reason: string | null },
): Promise<{ review: AdminReview }> {
  return api.post(`/admin/product-reviews/${id}/moderation`, input);
}
