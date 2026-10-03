import { describe, expect, it } from 'vitest';
import { imageReferenceState, readImageReference } from './image-search-reference';
import { MAX_IMAGE_BYTES } from './image-search';

describe('local image search reference', () => {
  it('retains the original native file and its bytes for an explicit later upload', () => {
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'reference.png', { type: 'image/png' });
    expect(readImageReference(imageReferenceState(image))).toBe(image);
    expect(imageReferenceState(image)?.rfqImageReference.name).toBe('reference.png');
  });
  it.each([null, undefined, 'image', { rfqImageReference: { name: 'forged.png', type: 'image/png' } }])('refuses non-file navigation data: %j', state => {
    expect(readImageReference(state)).toBeNull();
  });
  it('refuses empty, oversized and script-capable files without requesting any upload', () => {
    for (const file of [new File([], 'empty.png', { type: 'image/png' }), new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'large.png', { type: 'image/png' }), new File(['<svg/>'], 'script.svg', { type: 'image/svg+xml' })]) {
      expect(readImageReference({ rfqImageReference: file })).toBeNull();
    }
  });
  it('does not add reference state to ordinary product navigation', () => {
    expect(imageReferenceState(null)).toBeUndefined();
  });
});
