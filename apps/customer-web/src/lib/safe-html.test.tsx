/**
 * The product-description scrubber.
 *
 * This is the only place in the storefront that sets `dangerouslySetInnerHTML`,
 * so it is the only place where an XSS could land. The backend sanitises on
 * write; this is the second layer, and these tests are what make it worth
 * having rather than merely reassuring.
 *
 * The payloads below are the ones that actually get used: an `onerror` on a
 * broken image, a `javascript:` href, a `<script>` after a valid paragraph.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeHtml } from './safe-html';

function renderHtml(html: string | null): HTMLElement {
  const { container } = render(<SafeHtml html={html} />);
  return container;
}

describe('SafeHtml', () => {
  it('renders nothing at all for empty content', () => {
    expect(renderHtml(null).innerHTML).toBe('');
    expect(renderHtml('').innerHTML).toBe('');
    expect(renderHtml('   ').innerHTML).toBe('');
  });

  it('keeps the formatting a product description actually uses', () => {
    const container = renderHtml(
      '<p>Grade <strong>8.8</strong> bolt.</p><ul><li>Zinc plated</li><li>DIN 933</li></ul>',
    );

    expect(container.querySelector('strong')?.textContent).toBe('8.8');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('Zinc plated')).toBeInTheDocument();
  });

  it('removes a script element entirely', () => {
    const container = renderHtml('<p>Before</p><script>window.stolen = 1;</script><p>After</p>');

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('After');
    // The script's *text* must not survive either — unwrapping it would leave
    // the source code sitting in the description.
    expect(container.textContent).not.toContain('window.stolen');
  });

  it('strips every event handler attribute', () => {
    const container = renderHtml(
      '<p onclick="steal()" onmouseover="steal()">Text</p><img src="x" onerror="steal()">',
    );

    const paragraph = container.querySelector('p');
    expect(paragraph?.getAttribute('onclick')).toBeNull();
    expect(paragraph?.getAttribute('onmouseover')).toBeNull();
    // <img> is not on the allowlist, so it is unwrapped away completely.
    expect(container.querySelector('img')).toBeNull();
  });

  it('drops a javascript: href but keeps the link text', () => {
    const container = renderHtml('<a href="javascript:steal()">Click me</a>');

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBeNull();
    expect(container.textContent).toBe('Click me');
  });

  it('keeps ordinary links and hardens them', () => {
    const container = renderHtml('<a href="https://example.com/spec.pdf">Datasheet</a>');

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/spec.pdf');
    // An outbound link must not be able to reach back through window.opener.
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('unwraps a disallowed element rather than deleting its text', () => {
    // A stray <div> around a paragraph must not cost the customer the
    // paragraph.
    const container = renderHtml('<div class="wrapper"><p>Important detail</p></div>');

    expect(container.querySelector('div.wrapper')).toBeNull();
    expect(screen.getByText('Important detail')).toBeInTheDocument();
  });

  it('removes an iframe and everything inside it', () => {
    const container = renderHtml('<iframe src="https://evil.example"><p>fallback</p></iframe>');

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).not.toContain('fallback');
  });

  it('strips style and class attributes that could reposition content', () => {
    // A description that can set position:fixed can cover the Add to Cart
    // button, which is clickjacking by another name.
    const container = renderHtml('<p style="position:fixed;inset:0" class="evil">Text</p>');

    const paragraph = container.querySelector('p');
    expect(paragraph?.getAttribute('style')).toBeNull();
    expect(paragraph?.getAttribute('class')).toBeNull();
  });

  it('handles a malformed tag without throwing', () => {
    // The browser's own parser decides what this means; the point is that it
    // does not crash the page and nothing executable survives.
    const container = renderHtml('<p>Unclosed <strong>bold<script>steal()</p>');

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('Unclosed');
  });

  it('keeps a specification table intact', () => {
    const container = renderHtml(
      '<table><thead><tr><th scope="col">Spec</th></tr></thead><tbody><tr><td colspan="2">M12</td></tr></tbody></table>',
    );

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(container.querySelector('td')?.getAttribute('colspan')).toBe('2');
  });
});
