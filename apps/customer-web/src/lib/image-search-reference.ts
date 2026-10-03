/** A searched image stays local until the buyer uploads it to their own RFQ. */
import { rejectImage } from './image-search';

export function readImageReference(state: unknown): File | null {
  if (state === null || typeof state !== 'object' || !('rfqImageReference' in state)) return null;
  const image = state.rfqImageReference;
  return image instanceof File && rejectImage(image) === null ? image : null;
}

export function imageReferenceState(image: File | null): { rfqImageReference: File } | undefined {
  return image === null ? undefined : { rfqImageReference: image };
}
