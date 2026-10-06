/**
 * The inspection line on a shipment.
 *
 * A carrier sees one of three answers - released, held with one sentence why,
 * or no inspection needed - and nothing more. A held reason the screen knows
 * is said in the reader's language; one it does not know falls back to the
 * server's own sentence rather than to nothing.
 *
 * Plain assertions throughout: this app's test setup has no jest-dom matchers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/i18n/config';
import type { InspectionReleaseState } from '@/lib/types';
import { InspectionReleaseStatus } from './InspectionReleaseStatus';

function show(release: InspectionReleaseState | undefined): void {
  render(
    <I18nextProvider i18n={i18n}>
      <InspectionReleaseStatus release={release} />
    </I18nextProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
});

describe('InspectionReleaseStatus', () => {
  it('says no inspection is needed when none is required', () => {
    show({ required: false, released: true, reason: 'NOT_REQUIRED', sentence: 'No inspection is required.' });
    expect(screen.getByRole('status').textContent).toBe('No inspection needed for this shipment.');
  });

  it('says the goods are released once the inspection lets them go', () => {
    show({ required: true, released: true, reason: 'PASSED', sentence: 'The inspection passed.' });
    expect(screen.getByRole('status').textContent).toBe('Inspection: released. These goods may leave.');
  });

  it('says why the goods are held, in the reader’s words', () => {
    show({ required: true, released: false, reason: 'FAILED', sentence: 'The inspection failed.' });
    const text = screen.getByRole('status').textContent;
    expect(text.startsWith('Held by inspection: ')).toBe(true);
    expect(text).toContain('re-inspection passes');
  });

  it('falls back to the server sentence for a reason it does not know', () => {
    show({ required: true, released: false, reason: 'SOMETHING_NEW', sentence: 'A new reason from the server.' });
    expect(screen.getByRole('status').textContent).toBe('Held by inspection: A new reason from the server.');
  });

  it('translates the held sentence', async () => {
    await i18n.changeLanguage('de');
    show({ required: true, released: false, reason: 'NOT_BOOKED', sentence: 'English.' });
    expect(screen.getByRole('status').textContent).toContain('Durch Inspektion zurückgehalten');
  });

  it('renders nothing for an older response without the field', () => {
    show(undefined);
    expect(screen.queryByRole('status')).toBe(null);
  });
});
