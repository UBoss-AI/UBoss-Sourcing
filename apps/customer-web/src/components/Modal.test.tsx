/**
 * The Modal's placements. `center` is every dialog in the app and must not
 * change; `anchored` is a popover beside its button on a desktop and a bottom
 * sheet on a phone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { useRef } from 'react';
import { renderWithProviders } from '@/test/harness';
import { Modal } from './Modal';

function stubViewport(desktop: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktop ? 1280 : 360 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
}

function Anchored(): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={(node) => {
          anchorRef.current = node;
          if (node !== null) {
            node.getBoundingClientRect = () =>
              ({ top: 300, bottom: 348, left: 900, right: 948, width: 48, height: 48 }) as DOMRect;
          }
        }}
        type="button"
      >
        i
      </button>
      <Modal isOpen onClose={() => undefined} title="Info" placement="anchored" anchorRef={anchorRef}>
        body
      </Modal>
    </>
  );
}

describe('Modal placement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens beside its anchor on a desktop, right edges aligned, under it', () => {
    stubViewport(true);
    renderWithProviders(<Anchored />);
    const dialog = screen.getByRole('dialog', { name: 'Info' });
    // jsdom lays nothing out, so the dialog measures 0 x 0: its left edge is
    // the anchor's right edge, and its top is 8px under the anchor.
    expect(dialog.style.position).toBe('fixed');
    expect(dialog.style.top).toBe('356px');
    expect(dialog.style.left).toBe('948px');
    expect(dialog.className).toContain('sm:max-w-sm');
  });

  it('centres itself when its anchor is scrolled out of sight', () => {
    stubViewport(true);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
    renderWithProviders(<Anchored />);
    // The anchor sits at y 300-348, below a 200px viewport.
    expect(screen.getByRole('dialog', { name: 'Info' }).getAttribute('style')).toBeNull();
  });

  it('is a bottom sheet on a phone, with no desktop position', () => {
    stubViewport(false);
    renderWithProviders(<Anchored />);
    const dialog = screen.getByRole('dialog', { name: 'Info' });
    expect(dialog.style.top).toBe('');
    expect(dialog.className).toContain('max-sm:mt-auto');
    expect(dialog.className).toContain('max-sm:mb-0');
    expect(dialog.className).toContain('max-sm:rounded-b-none');
  });

  it('leaves a centred dialog exactly as it was', () => {
    stubViewport(true);
    renderWithProviders(
      <Modal isOpen onClose={() => undefined} title="Plain">
        body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Plain' });
    expect(dialog.getAttribute('style')).toBeNull();
    expect(dialog.className).toContain('max-w-lg');
    expect(dialog.className).not.toContain('max-sm:mt-auto');
  });
});
