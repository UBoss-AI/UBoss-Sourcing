/**
 * The hero globe on a connection that cannot afford it.
 *
 * Separate from `HeroStage.test.tsx` because these cases need a browser that
 * DOES have WebGL 2 and plenty of cores — otherwise the stage stands down for
 * those reasons and the connection check is never what decided it. The scene
 * itself is replaced with a marker: what is under test is whether it is asked
 * for at all, since asking for it is the download.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefersLightMedia } from '@/lib/light-media';
import { HeroStage } from './HeroStage';

vi.mock('./EarthScene', () => ({
  default: () => <span data-testid="earth-scene" />,
}));

function setConnection(value: { saveData?: boolean; effectiveType?: string } | undefined): void {
  Object.defineProperty(navigator, 'connection', { configurable: true, value });
}

beforeEach(() => {
  vi.stubGlobal('WebGL2RenderingContext', function WebGL2RenderingContext() {});
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 16 });
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  setConnection(undefined);
  vi.unstubAllGlobals();
});

describe('the globe on a light connection', () => {
  it('is loaded on a capable machine with a normal connection', async () => {
    setConnection({ saveData: false, effectiveType: '4g' });

    render(<HeroStage />);

    // The control case: without it, "nothing rendered" below could be any of
    // the other reasons the stage stands down.
    expect(await screen.findByTestId('earth-scene')).toBeInTheDocument();
  });

  it('is never asked for when the visitor has turned data saver on', () => {
    setConnection({ saveData: true, effectiveType: '4g' });

    const { container } = render(<HeroStage />);

    expect(container).toBeEmptyDOMElement();
  });

  it.each(['slow-2g', '2g', '3g'])('is never asked for on a %s connection', (effectiveType) => {
    setConnection({ saveData: false, effectiveType });

    const { container } = render(<HeroStage />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe('prefersLightMedia', () => {
  it('rules nothing out where the browser does not report its connection', () => {
    // Firefox and Safari: absence is not evidence of a slow connection.
    setConnection(undefined);
    expect(prefersLightMedia()).toBe(false);
  });

  it('follows data saver on any connection, and a slow measured connection', () => {
    setConnection({ saveData: true, effectiveType: '4g' });
    expect(prefersLightMedia()).toBe(true);

    setConnection({ effectiveType: '3g' });
    expect(prefersLightMedia()).toBe(true);

    setConnection({ effectiveType: '4g' });
    expect(prefersLightMedia()).toBe(false);
  });
});
