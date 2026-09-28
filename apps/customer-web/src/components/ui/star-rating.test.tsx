/**
 * The star rating, as an input and as a display.
 *
 * What would break a review form without anybody noticing: the group not
 * reporting the chosen score to assistive technology, the arrow keys not
 * moving it, a disabled group still accepting a click during a save, and the
 * read-only form not saying its value in words.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/config';
import { StarRating } from './star-rating';

function renderRating(props: Partial<React.ComponentProps<typeof StarRating>> = {}): void {
  render(
    <I18nextProvider i18n={i18n}>
      <StarRating label="Quality" {...props} />
    </I18nextProvider>,
  );
}

describe('StarRating', () => {
  it('is a named radio group of five stars', () => {
    renderRating();
    expect(screen.getByRole('radiogroup', { name: 'Quality' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  it('commits a click and marks that star as checked', async () => {
    const onValueChange = vi.fn();
    renderRating({ onValueChange });

    await userEvent.click(screen.getAllByRole('radio')[3] as HTMLElement);

    expect(onValueChange).toHaveBeenCalledWith(4);
    expect(screen.getAllByRole('radio')[3]).toHaveAttribute('aria-checked', 'true');
  });

  it('moves the score with the arrow keys and keeps one tab stop', async () => {
    const onValueChange = vi.fn();
    renderRating({ defaultValue: 2, onValueChange });

    const radios = screen.getAllByRole('radio');
    expect(radios.filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(1);

    (radios[1] as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onValueChange).toHaveBeenLastCalledWith(3);
    await userEvent.keyboard('{End}');
    expect(onValueChange).toHaveBeenLastCalledWith(5);
  });

  it('ignores input while disabled', async () => {
    const onValueChange = vi.fn();
    renderRating({ disabled: true, onValueChange });

    await userEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('says a fractional read-only value in words', () => {
    renderRating({ readOnly: true, value: 4.26, label: 'Average rating' });
    expect(screen.getByRole('img', { name: 'Average rating: 4.3 out of 5' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
