import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installTabMotion } from './tab-motion';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

interface FakeAnimation {
  id: string;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel: () => void;
}

const calls: { el: Element; frames: Keyframe[]; anim: FakeAnimation }[] = [];

beforeAll(() => {
  // jsdom has no Web Animations; a recorder stands in for it.
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function animate(this: Element, frames: Keyframe[]) {
      const anim: FakeAnimation = {
        id: '',
        onfinish: null,
        oncancel: null,
        cancel() {
          this.oncancel?.();
        },
      };
      calls.push({ el: this, frames, anim });
      return anim;
    },
  });
  Element.prototype.getAnimations = () => [];
  installTabMotion();
});

afterEach(() => {
  calls.length = 0;
  document.body.innerHTML = '';
});

function row(selected: number): { list: HTMLElement; tabs: HTMLElement[]; panel: HTMLElement } {
  document.body.innerHTML = `
    <div>
      <div role="tablist">
        <button role="tab" aria-selected="false" aria-controls="p">A</button>
        <button role="tab" aria-selected="false" aria-controls="p">B</button>
      </div>
      <div id="p" role="tabpanel">content</div>
    </div>`;
  const list = must(document.querySelector<HTMLElement>('[role="tablist"]'));
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
  must(tabs[selected]).setAttribute('aria-selected', 'true');
  return { list, tabs, panel: must(document.getElementById('p')) };
}

function select(tabs: HTMLElement[], from: number, to: number): void {
  must(tabs[from]).setAttribute('aria-selected', 'false');
  must(tabs[to]).setAttribute('aria-selected', 'true');
}

/** Gives every element a box, which jsdom does not. */
function giveBoxes(tabs: HTMLElement[]): void {
  tabs.forEach((tab, i) => {
    vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: i * 100, y: 0, width: 90, height: 30 }),
    );
  });
}

describe('tab motion', () => {
  it('glides a ghost between the tabs and reveals the panel', async () => {
    const { list, tabs, panel } = row(0);
    await Promise.resolve();
    giveBoxes(tabs);
    select(tabs, 0, 1);
    await Promise.resolve();

    const ghost = list.querySelector('[data-tab-ghost]');
    expect(ghost).not.toBeNull();
    expect(calls.map((c) => c.el)).toEqual([ghost, panel]);
    // Stretches across both tabs before landing on the new one.
    expect(must(calls[0]).frames[1]).toMatchObject({ left: '0px', width: '190px' });
    expect(must(calls[0]).frames.at(-1)).toMatchObject({ left: '100px', width: '90px' });
    // The new tab hands its look to the ghost while it travels.
    expect(must(tabs[1]).style.backgroundColor).toBe('transparent');

    must(calls[0]).anim.onfinish?.();
    expect(list.querySelector('[data-tab-ghost]')).toBeNull();
    expect(must(tabs[1]).style.backgroundColor).toBe('');
    expect(list.style.isolation).toBe('');
  });

  it('a second switch mid-glide puts the first one back first', async () => {
    const { list, tabs } = row(0);
    await Promise.resolve();
    giveBoxes(tabs);
    select(tabs, 0, 1);
    await Promise.resolve();
    select(tabs, 1, 0);
    await Promise.resolve();
    expect(list.querySelectorAll('[data-tab-ghost]')).toHaveLength(1);
    must(calls.at(-2)).anim.onfinish?.();
    expect(list.style.isolation).toBe('');
    expect(must(tabs[1]).style.backgroundColor).toBe('');
  });

  it('does nothing on a first render or for anything that is not a tab', async () => {
    row(1);
    document.body.insertAdjacentHTML('beforeend', '<div aria-selected="false" id="x"></div>');
    must(document.getElementById('x')).setAttribute('aria-selected', 'true');
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });
});
