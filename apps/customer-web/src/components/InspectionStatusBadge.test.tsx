/** ENH-010: the inspection status badge shared by the buyer and Seller Hub order lists. */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { InspectionStatusBadge } from './InspectionStatusBadge';

describe('InspectionStatusBadge', () => {
  it.each(['NOT_REQUIRED', 'REQUIRED', 'BOOKED', 'IN_PROGRESS', 'NCR', 'REINSPECTION', 'RELEASED', 'ON_HOLD'])('labels %s', (status) => {
    renderWithProviders(<InspectionStatusBadge status={status} />);
    expect(screen.getByText(/./)).toBeInTheDocument();
  });

  it('renders nothing when inspection is undecided or the status is unknown', () => {
    const { container } = renderWithProviders(<><InspectionStatusBadge status={null} /><InspectionStatusBadge status="SOMETHING_NEW" /></>);
    expect(container.textContent).toBe('');
  });
});
