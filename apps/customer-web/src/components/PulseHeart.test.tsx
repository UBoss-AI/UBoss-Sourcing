import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PulseHeart } from './PulseHeart';
import { renderWithProviders } from '@/test/harness';

describe('PulseHeart', () => {
  it('toggles state and exposes the pressed state to assistive tech', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(
      <PulseHeart defaultLiked={false} count={12} showCount onChange={onChange} />,
    );

    const button = screen.getByRole('button', { name: /like product/i });

    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('12')).toBeInTheDocument();

    await user.click(button);

    expect(onChange).toHaveBeenCalledWith(true);
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });
});
