/**
 * The headline split.
 *
 * Every case here is a real deployment's name, or the shape of one. The first
 * is the one that produced the bug: a shop called "UBOSS Sourcing" under a
 * headline that cycles "Sourcing" read "UBOSS Sourcing Sourcing".
 */
import { describe, expect, it } from 'vitest';
import { HEADLINE_WORDS, splitHeadline } from './greeting-headline';

/** The cycle as the English storefront supplies it. */
const ENGLISH = HEADLINE_WORDS.map((word) => word.english);

/** The same four, as the German storefront supplies them. */
const GERMAN = ['Beschaffung', 'Intelligenz', 'Optimismus', 'Innovation'];

describe('the greeting headline', () => {
  it('hands the name’s last word over to the cycle rather than saying it twice', () => {
    const { name, words } = splitHeadline('UBOSS Sourcing', ENGLISH);

    expect(name).toBe('UBOSS');
    // Opens on exactly the name the operator configured, then moves on.
    expect(words).toEqual(['Sourcing', 'Intelligence', 'Optimism', 'Innovation']);
  });

  it('starts the cycle where the name left it, rather than at the top', () => {
    const { name, words } = splitHeadline('Northgate Innovation', ENGLISH);

    expect(name).toBe('Northgate');
    expect(words).toEqual(['Innovation', 'Sourcing', 'Intelligence', 'Optimism']);
  });

  it('keeps the operator’s own spelling of the word it took', () => {
    const { name, words } = splitHeadline('UBOSS SOURCING', ENGLISH);

    expect(name).toBe('UBOSS');
    // Not "Sourcing". The shop is shouting on purpose.
    expect(words[0]).toBe('SOURCING');
  });

  it('matches an English name against an English word on a translated storefront', () => {
    // A business name is never translated, so the German catalogue has no
    // word that looks like the tail of this name. Matching only the current
    // language would leave "UBOSS Sourcing Beschaffung".
    const { name, words } = splitHeadline('UBOSS Sourcing', GERMAN);

    expect(name).toBe('UBOSS');
    expect(words).toEqual(['Sourcing', 'Intelligenz', 'Optimismus', 'Innovation']);
  });

  it('matches a translated name too, for a shop named in its own language', () => {
    const { name, words } = splitHeadline('Hansa Beschaffung', GERMAN);

    expect(name).toBe('Hansa');
    expect(words).toEqual(['Beschaffung', 'Intelligenz', 'Optimismus', 'Innovation']);
  });

  it('leaves a name that ends in a word of its own alone', () => {
    const { name, words } = splitHeadline('Northgate Medical Supplies', ENGLISH);

    expect(name).toBe('Northgate Medical Supplies');
    expect(words).toEqual(ENGLISH);
  });

  it('gives up only the last word, however long the name is', () => {
    const { name } = splitHeadline('Northgate Medical Supplies Sourcing', ENGLISH);

    expect(name).toBe('Northgate Medical Supplies');
  });

  it('does not strip a one-word name down to nothing', () => {
    const { name, words } = splitHeadline('Sourcing', ENGLISH);

    // A headline with a changing word and no shop in it says nothing about
    // who is selling, which is the one thing it has to say.
    expect(name).toBe('Sourcing');
    expect(words).toEqual(ENGLISH);
  });

  it('tidies the whitespace a settings field lets through', () => {
    const { name } = splitHeadline('  UBOSS   Sourcing  ', ENGLISH);

    expect(name).toBe('UBOSS');
  });

  it('falls back to English if a catalogue supplies nothing', () => {
    const { words } = splitHeadline('Northgate', []);

    expect(words).toEqual(ENGLISH);
  });
});
