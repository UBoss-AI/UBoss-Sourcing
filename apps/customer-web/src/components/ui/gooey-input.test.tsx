/**
 * The gooey search control.
 *
 * The blur and the pinch are not testable in jsdom and are not what would go
 * wrong. What would go wrong is the three defects the adaptation exists to fix
 * — the header of `gooey-input.tsx` lists them — plus the one behaviour that
 * silently loses somebody's typing. So that is what is held down here.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GooeyInput } from './gooey-input';

describe('opening and closing', () => {
  it('names itself while it is shut, and takes the caret when it opens', async () => {
    const user = userEvent.setup();
    render(<GooeyInput label="Search the catalogue" />);

    const trigger = screen.getByRole('button', { name: 'Search the catalogue' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    const field = screen.getByRole('textbox', { name: 'Search the catalogue' });
    expect(field).toHaveFocus();
  });

  it('lets the field be typed into once it is open', async () => {
    const user = userEvent.setup();
    render(<GooeyInput label="Search" />);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('textbox'), 'cannula');

    // The original nests the input inside the button, which is invalid HTML
    // and means the press lands on the button rather than on the field. The
    // trigger here is a sibling that is unmounted once the control is open.
    expect(screen.getByRole('textbox')).toHaveValue('cannula');
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('folds up on blur while it is empty, and stays open once it is not', async () => {
    const user = userEvent.setup();
    render(
      <>
        <GooeyInput label="Search" />
        <button type="button">Somewhere else</button>
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'Somewhere else' }));
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('textbox'), 'gauze');
    await user.click(screen.getByRole('button', { name: 'Somewhere else' }));

    expect(screen.getByRole('textbox')).toHaveValue('gauze');
  });
});

describe('what happens to the value', () => {
  it('wipes it on collapse by default', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<GooeyInput label="Search" onValueChange={onValueChange} />);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('textbox'), 'gauze');
    await user.keyboard('{Escape}');

    expect(onValueChange).toHaveBeenLastCalledWith('');
  });

  it('keeps it when the caller says to', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<GooeyInput label="Search" clearOnCollapse={false} onValueChange={onValueChange} />);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('textbox'), 'gauze');
    await user.keyboard('{Escape}');

    // The original has no way to ask for this, and a filter that empties
    // itself the moment somebody reaches for the control beside it is a bug
    // reported as "it keeps forgetting what I searched for".
    expect(onValueChange).toHaveBeenLastCalledWith('gauze');
  });

  it('does not clear a default value it has never been opened on', () => {
    const onValueChange = vi.fn();
    render(<GooeyInput label="Search" defaultValue="cannula" onValueChange={onValueChange} />);

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('submits on Enter with what is in the box', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<GooeyInput label="Search" onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('textbox'), 'suction{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('suction');
  });
});
