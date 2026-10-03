import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Countdown } from './Countdown';
import { countdownParts } from '@/lib/countdown';
import { renderWithProviders } from '@/test/harness';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const H = 3_600_000;

afterEach(() => { vi.useRealTimers(); });

describe('countdown (ENH-030)', () => {
  it('treats the exact deadline as overdue and a millisecond before as due', () => {
    expect(countdownParts(at(0), NOW, 'en').overdue).toBe(true);
    expect(countdownParts(at(1), NOW, 'en')).toEqual({ overdue: false, soon: true, phrase: 'in 1 minute' });
  });
  it('picks days, hours or minutes and marks the last day as soon', () => {
    expect(countdownParts(at(50 * H), NOW, 'en')).toEqual({ overdue: false, soon: false, phrase: 'in 2 days' });
    expect(countdownParts(at(24 * H), NOW, 'en')).toEqual({ overdue: false, soon: false, phrase: 'in 24 hours' });
    expect(countdownParts(at(5 * H), NOW, 'en')).toEqual({ overdue: false, soon: true, phrase: 'in 5 hours' });
    expect(countdownParts(at(-90 * 60_000), NOW, 'en')).toEqual({ overdue: true, soon: false, phrase: '90 minutes ago' });
    expect(countdownParts(at(-3 * 24 * H), NOW, 'de').phrase).toBe('vor 3 Tagen');
  });
  it('renders, ticks into overdue, and ignores a missing or invalid deadline', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    renderWithProviders(<><Countdown deadline={at(60_000).toISOString()} /><Countdown deadline={null} /><Countdown deadline="nonsense" /></>);
    expect(screen.getByText('Due in 1 minute')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Overdue: was due 1 minute ago')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-countdown]')).toHaveLength(1);
  });
});
