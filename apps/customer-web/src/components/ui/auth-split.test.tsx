/**
 * The sign-in frame, and the picture beside it.
 *
 * What is worth testing here is not the earth — jsdom has no WebGL, no layout
 * and no frames, so "the globe turns" is not a fact this suite can hold. What
 * it can hold is every promise the frame makes *about* the picture, and each
 * one is load bearing:
 *
 *   - **The form is untouched.** This frame was added to three sets of
 *     signed-out screens that already worked; if it changes what is in the
 *     column, it has failed at the only thing it was asked to do.
 *   - **The picture is hidden from assistive technology**, because it says
 *     nothing that is not already said in words beside it.
 *   - **It contains nothing focusable.** A tab stop inside an `aria-hidden`
 *     container is a control with no accessible name, which is worse than no
 *     control — and the globe's pins become real buttons the moment a handler
 *     is passed, so this is a guard against a plausible future edit, not a
 *     restatement of today's markup.
 *   - **No canvas is created where there is no WebGL.** jsdom is exactly that
 *     environment, and it stands in here for the blocklisted driver and the
 *     locked-down browser. The panel must still be a finished picture, which
 *     is the drawn globe underneath.
 *   - **No accessibility violations**, which is what stops the panel from
 *     being `aria-hidden` and focusable at the same time.
 *
 * `components/ui/auth-split.tsx` and `auth-globe.tsx` record why each of those
 * had to be true.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthSplit } from './auth-split';
import { expectNoA11yViolations } from '@/test/axe';

/** Enough of a form to tell whether the frame left it alone. */
function Form(): React.JSX.Element {
  return (
    <form aria-label="Sign in">
      <label htmlFor="email">Email address</label>
      <input id="email" name="email" type="email" />
      <button type="submit">Sign in</button>
    </form>
  );
}

describe('AuthSplit', () => {
  it('renders the form it was given, unchanged', () => {
    render(
      <AuthSplit>
        <Form />
      </AuthSplit>,
    );

    expect(screen.getByRole('textbox', { name: 'Email address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('hides the picture from assistive technology', () => {
    const { container } = render(
      <AuthSplit>
        <Form />
      </AuthSplit>,
    );

    const panels = container.querySelectorAll('[aria-hidden="true"]');
    expect(panels.length).toBeGreaterThan(0);

    // Nothing inside any of them is announced, so nothing inside any of them
    // may be reachable either.
    for (const panel of panels) {
      expect(
        panel.querySelectorAll('a, button, input, select, textarea, [tabindex]'),
      ).toHaveLength(0);
    }
  });

  it('creates no canvas where the browser has no WebGL', () => {
    const { container } = render(
      <AuthSplit>
        <Form />
      </AuthSplit>,
    );

    // jsdom defines no `WebGL2RenderingContext`, which is the same answer a
    // blocklisted driver gives. The drawn globe is the panel instead.
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <AuthSplit>
        <Form />
      </AuthSplit>,
    );

    await expectNoA11yViolations(container);
  });
});
