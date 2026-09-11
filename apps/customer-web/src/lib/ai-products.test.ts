/**
 * Splitting an assistant reply into words and references.
 *
 * This is the boundary that decides what generated text is allowed to become,
 * so the cases below are the cases that matter rather than a sample of them:
 * a complete reference line, one still arriving a character at a time, prose
 * that happens to contain brackets, and identifiers that are not identifiers.
 *
 * The streaming cases are the ones worth being fussy about. The transcript
 * re-renders on every delta, so a parser that only worked on finished text
 * would show `[[products: easy-jet-dispo` typing itself out under the answer —
 * which reads as a broken renderer, not as a feature arriving.
 */
import { describe, expect, it } from 'vitest';
import { MAX_AI_PRODUCTS, readAssistantReply } from './ai-products';

describe('a finished reply', () => {
  it('takes the references out of the text and keeps the answer', () => {
    const reply = readAssistantReply(
      'The 22G fits a small vein.\n[[products: safety-cannula-22g, safety-cannula-24g]]',
    );

    expect(reply.text).toBe('The 22G fits a small vein.');
    expect(reply.refs).toEqual(['safety-cannula-22g', 'safety-cannula-24g']);
  });

  it('keeps the order the reply gave, which is its recommendation', () => {
    const reply = readAssistantReply('Either.\n[[products: second-choice, first-choice]]');

    expect(reply.refs).toEqual(['second-choice', 'first-choice']);
  });

  it('accepts product codes as well as slugs', () => {
    // The catalogue snapshot puts both in front of the model, so it quotes
    // whichever the customer used.
    const reply = readAssistantReply('That is SC-22G.\n[[products: SC-22G, EJ/DHS-2.5ML]]');

    expect(reply.refs).toEqual(['SC-22G', 'EJ/DHS-2.5ML']);
  });

  it('de-duplicates, so one product is one card', () => {
    const reply = readAssistantReply('Same one.\n[[products: sc-22g, sc-22g]]');

    expect(reply.refs).toEqual(['sc-22g']);
  });

  it('drops anything that is not an identifier', () => {
    // A model that writes a sentence inside the brackets has written no
    // references, and querying the catalogue for a sentence is a request
    // nobody meant to make.
    const reply = readAssistantReply(
      'Here you go.\n[[products: the blue one, sc-22g, , "quoted"]]',
    );

    expect(reply.refs).toEqual(['sc-22g']);
  });

  it('caps the row, however many the model listed', () => {
    const many = Array.from({ length: 20 }, (_unused, index) => `item-${String(index)}`);
    const reply = readAssistantReply(`Lots.\n[[products: ${many.join(', ')}]]`);

    expect(reply.refs).toHaveLength(MAX_AI_PRODUCTS);
  });

  it('leaves an answer about nothing in particular completely alone', () => {
    const reply = readAssistantReply('Our support team can quote that for you.');

    expect(reply.text).toBe('Our support team can quote that for you.');
    expect(reply.refs).toEqual([]);
  });
});

describe('a reply that is still streaming', () => {
  it('hides the reference line while it is arriving', () => {
    // Every prefix of the line, one delta at a time. Not one of them may
    // reach the reader.
    const answer = 'The 22G fits.\n';
    const line = '[[products: safety-cannula-22g]]';

    for (let length = 1; length < line.length; length += 1) {
      const reply = readAssistantReply(answer + line.slice(0, length));

      expect(reply.text, line.slice(0, length)).toBe('The 22G fits.');
      // And nothing is looked up until the line is complete: half a slug
      // resolves to nothing, and asking per keystroke is a request per
      // keystroke.
      expect(reply.refs).toEqual([]);
    }
  });

  it('shows the references the moment the line closes', () => {
    const reply = readAssistantReply('The 22G fits.\n[[products: safety-cannula-22g]]');

    expect(reply.refs).toEqual(['safety-cannula-22g']);
  });
});

describe('prose that looks like machinery', () => {
  it('leaves a stray bracket pair in the text', () => {
    // Deliberately not `[[.*$`: that would swallow this and never give it
    // back, because nothing later completes it.
    const reply = readAssistantReply('The pack is marked [[BATCH]] on the box.');

    expect(reply.text).toBe('The pack is marked [[BATCH]] on the box.');
    expect(reply.refs).toEqual([]);
  });

  it('hides a trailing bracket only while it could still become a reference', () => {
    expect(readAssistantReply('Marked [[BATCH').text).toBe('Marked [[BATCH');
    expect(readAssistantReply('Answer.\n[[prod').text).toBe('Answer.');

    // The one thing this costs: a reply ending in a bare bracket loses it.
    // That is the trade named on `PARTIAL_REFERENCE_LINE`, and it is the right
    // way round — a trailing lone bracket means nothing, and the alternative
    // was a visible flicker on every answer about a product.
    expect(readAssistantReply('Answer. [').text).toBe('Answer.');
  });
});

describe('the fallback', () => {
  it('reads product paths when the model wrote no reference line', () => {
    // Those paths are already links in the transcript, so a card is the same
    // reference in a richer shape.
    const reply = readAssistantReply(
      'Try /product/safety-cannula-22g or /product/safety-cannula-24g.',
    );

    expect(reply.refs).toEqual(['safety-cannula-22g', 'safety-cannula-24g']);
    // And the prose keeps its links: the paths are not stripped.
    expect(reply.text).toContain('/product/safety-cannula-22g');
  });

  it('is not consulted when a reference line exists', () => {
    // The line has already stated an ordering. Mixing in wherever a link fell
    // in a sentence would silently re-order the recommendation.
    const reply = readAssistantReply(
      'Try /product/mentioned-in-passing.\n[[products: the-recommendation]]',
    );

    expect(reply.refs).toEqual(['the-recommendation']);
  });
});
