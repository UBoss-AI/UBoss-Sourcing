/**
 * The categorised FAQ on its own: tabs, accordion, keyboard and ARIA.
 *
 * What it proves:
 *   - every tab controls a panel that exists, and only the selected one is
 *     in the tab order;
 *   - Left, Right, Home and End move between tabs, wrapping at the ends, and
 *     focus follows;
 *   - a question opens and closes, points at an answer that is always in the
 *     document, and a closed answer is inert;
 *   - changing topic closes whatever was open;
 *   - long text is not clipped to one line;
 *   - asking for reduced motion changes nothing about what it does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { FaqCategorized, type FaqCategory } from './FaqCategorized';

const LONG =
  'A deliberately long question that a translation might produce, with many words in it, so that it has to wrap onto several lines on a phone';

const CATEGORIES: FaqCategory[] = [
  {
    id: 'one',
    name: 'First topic',
    faqs: [
      { id: 'a', question: 'Question A?', answer: 'Answer A.' },
      { id: 'b', question: LONG, answer: 'Answer B.', action: <a href="/x">Next step</a> },
    ],
  },
  { id: 'two', name: 'Second topic', faqs: [{ id: 'c', question: 'Question C?', answer: 'Answer C.' }] },
  { id: 'three', name: 'Third topic', faqs: [{ id: 'd', question: 'Question D?', answer: 'Answer D.' }] },
];

function renderFaq(): void {
  render(
    <FaqCategorized
      id="support-faq"
      title="Frequently asked questions"
      description="Quick answers"
      tabListLabel="Question topics"
      categories={CATEGORIES}
    />,
  );
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the FAQ tabs', () => {
  it('is a named tab list whose tabs each control a real panel', () => {
    renderFaq();
    expect(screen.getByRole('region', { name: 'Frequently asked questions' })).toHaveAttribute(
      'id',
      'support-faq',
    );
    const list = screen.getByRole('tablist', { name: 'Question topics' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['First topic', 'Second topic', 'Third topic']);

    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');

    const panel = screen.getByRole('tabpanel');
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tabs[0]?.id);
  });

  it('moves with Right, Left, Home and End, wrapping at the ends', async () => {
    renderFaq();
    const tab = (name: string): HTMLElement => screen.getByRole('tab', { name });

    tab('First topic').focus();
    fireEvent.keyDown(tab('First topic'), { key: 'ArrowRight' });
    expect(tab('Second topic')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Second topic')).toHaveFocus();
    expect(await screen.findByText('Question C?')).toBeInTheDocument();

    fireEvent.keyDown(tab('Second topic'), { key: 'End' });
    expect(tab('Third topic')).toHaveFocus();
    fireEvent.keyDown(tab('Third topic'), { key: 'ArrowRight' });
    expect(tab('First topic')).toHaveFocus();
    fireEvent.keyDown(tab('First topic'), { key: 'ArrowLeft' });
    expect(tab('Third topic')).toHaveFocus();
    fireEvent.keyDown(tab('Third topic'), { key: 'Home' });
    expect(tab('First topic')).toHaveFocus();
    expect(tab('First topic')).toHaveAttribute('tabindex', '0');
    expect(tab('Third topic')).toHaveAttribute('tabindex', '-1');
  });
});

describe('the FAQ answers', () => {
  it('opens and closes a question, with its answer always in the document', () => {
    renderFaq();
    const question = screen.getByRole('button', { name: 'Question A?' });
    const answer = document.getElementById(question.getAttribute('aria-controls') ?? '');

    expect(answer).not.toBeNull();
    expect(question).toHaveAttribute('aria-expanded', 'false');
    expect(answer).toHaveAttribute('inert');
    // A heading wraps the trigger, one level under the section's.
    expect(screen.getByRole('heading', { level: 3, name: 'Question A?' })).toBeInTheDocument();

    fireEvent.click(question);
    expect(question).toHaveAttribute('aria-expanded', 'true');
    expect(answer).not.toHaveAttribute('inert');
    expect(answer).toHaveAttribute('role', 'region');
    expect(answer).toHaveAttribute('aria-labelledby', question.id);
    expect(answer).toHaveTextContent('Answer A.');

    fireEvent.click(question);
    expect(question).toHaveAttribute('aria-expanded', 'false');
    expect(answer).toHaveAttribute('inert');
  });

  it('opens one question at a time and shows its next step', () => {
    renderFaq();
    fireEvent.click(screen.getByRole('button', { name: 'Question A?' }));
    fireEvent.click(screen.getByRole('button', { name: LONG }));
    expect(screen.getByRole('button', { name: 'Question A?' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: LONG })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Next step' })).toHaveAttribute('href', '/x');
  });

  it('closes the open question when the topic changes', async () => {
    renderFaq();
    fireEvent.click(screen.getByRole('button', { name: 'Question A?' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Second topic' }));
    await screen.findByText('Question C?');
    fireEvent.click(screen.getByRole('tab', { name: 'First topic' }));
    expect(await screen.findByRole('button', { name: 'Question A?' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('lets a long question wrap rather than clipping it', () => {
    renderFaq();
    const text = screen.getByText(LONG);
    expect(text.className).toContain('break-words');
    expect(text.className).not.toMatch(/truncate|line-clamp|whitespace-nowrap/);
  });

  it('works the same with reduced motion asked for', () => {
    stubReducedMotion(true);
    renderFaq();
    const question = screen.getByRole('button', { name: 'Question A?' });
    fireEvent.click(question);
    expect(question).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'First topic' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Second topic' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders nothing without categories', () => {
    const { container } = render(
      <FaqCategorized title="t" description="d" tabListLabel="l" categories={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
