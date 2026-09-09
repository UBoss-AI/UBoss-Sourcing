/**
 * The sourcing hub.
 *
 * One orb, two counter-rotating orbits and six capabilities arranged around
 * them. It is the greeting page's main visual and its main navigation at the
 * same time, which is the only thing that justifies its size: a decorative
 * diagram this large would be 500px of scroll between a customer and the
 * catalogue.
 *
 * Three decisions are worth knowing before changing anything here.
 *
 * **The word in the middle does not rotate.** The orb underneath it turns, its
 * highlight orbits, and the rings turn in opposite directions — but the label
 * is a sibling layer with no transform at all. A word painted onto a spinning
 * sphere is unreadable for most of every revolution, and a transformed layer
 * can pick up a half-pixel blur on its text even when it is standing still.
 *
 * **Six nodes, one list, two arrangements.** From `lg` they lift out onto a
 * circle; below it they sit in a grid under the orb. Same DOM, same six
 * controls, same tab order — the difference is entirely in
 * `orchestration.css`. A radial layout that merely scaled down would put one
 * node's label on top of another's at phone width, and a control you cannot
 * read is a control you cannot press.
 *
 * **Hovering does not re-render.** The active node is written to a
 * `data-orch-active` attribute and the pointer parallax to two custom
 * properties, both straight onto the DOM node. Moving a mouse across the hero
 * would otherwise re-render six tiles, an SVG and everything below them, sixty
 * times a second, for a glow.
 *
 * What a node *does* is not decided here — see `orchestration-nodes.ts`, which
 * is where the rule that a node never links somewhere the person pressing it
 * cannot go actually lives.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { BoxIcon, ChevronRightIcon, CloseIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { openAssistantPanel } from '@/lib/assistant-panel';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import {
  HUB_VIEWBOX,
  HUB_CENTRE,
  LINE_END,
  LINE_START,
  ORCHESTRATION_NODES,
  RING_INNER,
  RING_OUTER,
  nodePosition,
  pointAt,
  resolveNode,
  svgRotation,
} from './orchestration-nodes';
import type { OrchestrationNode, OrchestrationNodeId } from './orchestration-nodes';
import './orchestration.css';

/** `style` with the custom properties this component feeds the stylesheet. */
type CssVars = CSSProperties & Record<`--${string}`, string>;

/** How far the deepest layer drifts with the pointer, in pixels. */
const PARALLAX_PX = 10;

// ---------------------------------------------------------------------------
// Pointer parallax
// ---------------------------------------------------------------------------

/**
 * Drift the hub's layers a few pixels towards the pointer.
 *
 * Written to `--orch-px` / `--orch-py` on the root element rather than held in
 * state, so the whole effect costs one attribute write per animation frame and
 * no React work at all. `orchestration.css` multiplies them differently per
 * layer, which is what separates the web from the nodes.
 *
 * Both media queries are re-read on every frame instead of being captured at
 * setup. Somebody who switches on "reduce motion" half way through a visit
 * gets a hub that stops moving, without this having to subscribe to a change
 * event and without a stale value surviving until the next mount.
 */
function useHubParallax(root: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const element = root.current;
    if (element === null) return;

    // jsdom has no `matchMedia`. Nothing here is worth a polyfill in a test.
    if (typeof window.matchMedia !== 'function') return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    // A touch screen has no hovering pointer, and reading `clientX` from the
    // one tap it does get would jerk the layers and leave them there.
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

    let frame = 0;

    const write = (x: number, y: number): void => {
      element.style.setProperty('--orch-px', `${x.toFixed(2)}px`);
      element.style.setProperty('--orch-py', `${y.toFixed(2)}px`);
    };

    const onMove = (event: PointerEvent): void => {
      if (frame !== 0) return;

      frame = window.requestAnimationFrame(() => {
        frame = 0;

        if (reducedMotion.matches || !finePointer.matches) {
          write(0, 0);
          return;
        }

        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return;

        // −1 … 1 from the hub's own centre, clamped so a pointer at the far
        // side of a wide screen does not push the layers any further than one
        // hovering just off the edge of the diagram.
        const clamp = (value: number): number => Math.max(-1, Math.min(1, value));
        const x = clamp((event.clientX - (box.left + box.width / 2)) / (box.width / 2));
        const y = clamp((event.clientY - (box.top + box.height / 2)) / (box.height / 2));

        write(x * PARALLAX_PX, y * PARALLAX_PX);
      });
    };

    // The pointer leaving the window would otherwise strand the layers at
    // whatever offset it last had.
    const onLeave = (): void => {
      write(0, 0);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, [root]);
}

// ---------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------

/** Dots riding a ring, at fixed angles. They are carried, not animated. */
function motes(radius: number, angles: readonly number[]): React.JSX.Element[] {
  return angles.map((angle, index) => {
    const { x, y } = pointAt(angle, radius);

    return (
      <circle
        key={angle}
        className="orch-mote"
        cx={x}
        cy={y}
        r={2.4}
        style={{ '--orch-delay': `${(index * 0.8).toFixed(1)}s` } as CssVars}
      />
    );
  });
}

/**
 * Rings, radial lines and the lights that travel them.
 *
 * `aria-hidden`, and it means it: every name in this picture is also rendered
 * as text in the node beside it, so a screen reader that read the diagram
 * would hear the same six words twice.
 */
function HubWeb(): React.JSX.Element {
  return (
    <svg
      className="orch-web"
      viewBox={`0 0 ${HUB_VIEWBOX} ${HUB_VIEWBOX}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="orch-halo">
          <stop offset="0%" stopColor="rgb(56 189 248)" stopOpacity="0.16" />
          <stop offset="60%" stopColor="rgb(56 189 248)" stopOpacity="0.05" />
          <stop offset="100%" stopColor="rgb(56 189 248)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={HUB_CENTRE} cy={HUB_CENTRE} r={188} fill="url(#orch-halo)" />

      {/* Drawn before the rings, so an orbit passes in front of a spoke
          rather than being cut in half by one. */}
      {ORCHESTRATION_NODES.map((node) => {
        const from = pointAt(node.angle, LINE_START);
        const to = pointAt(node.angle, LINE_END);

        return (
          <line
            key={node.id}
            className="orch-line"
            data-node={node.id}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            strokeLinecap="round"
          />
        );
      })}

      <g className="orch-ring orch-ring--inner">
        <circle
          cx={HUB_CENTRE}
          cy={HUB_CENTRE}
          r={RING_INNER}
          stroke="rgb(59 130 246 / 0.28)"
          strokeWidth={1}
        />
        {motes(RING_INNER, [20, 140, 260])}
      </g>

      <g className="orch-ring orch-ring--outer">
        <circle
          cx={HUB_CENTRE}
          cy={HUB_CENTRE}
          r={RING_OUTER}
          stroke="rgb(56 189 248 / 0.55)"
          strokeWidth={1.4}
          strokeDasharray="2 11"
          strokeLinecap="round"
        />
        {motes(RING_OUTER, [70, 190, 310])}
      </g>

      {/* One light per spoke. Each starts at the centre of a group the
          drawing has already turned to that spoke's angle, so the animation
          only has to push it along the local x-axis — a translate, not a
          dash offset, and therefore no repaint. */}
      {ORCHESTRATION_NODES.map((node, index) => (
        <g key={node.id} transform={`rotate(${svgRotation(node.angle)} ${HUB_CENTRE} ${HUB_CENTRE})`}>
          <circle
            className="orch-pulse"
            cx={HUB_CENTRE}
            cy={HUB_CENTRE}
            r={2.6}
            style={{ '--orch-delay': `${(index * 0.73).toFixed(2)}s` } as CssVars}
          />
        </g>
      ))}
    </svg>
  );
}

/** The orb, and the word that stays still on top of it. */
function HubCore({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="orch-hub">
      <span aria-hidden="true" className="orch-hub-glow" />

      <div aria-hidden="true" className="orch-orb">
        <div className="orch-orb-wire">
          <span className="orch-orb-meridian" />
          <span className="orch-orb-meridian" />
          <span className="orch-orb-meridian" />
        </div>
        <span className="orch-orb-equator" />
        <div className="orch-orb-sheen" />
      </div>

      {/* The fixed layer. Not inside `.orch-orb`, which rotates and clips. */}
      <div className="orch-hub-label">
        <BoxIcon className="h-4 w-4 text-sky-100 lg:h-6 lg:w-6" />
        <span className="text-sm font-semibold tracking-tight text-white lg:text-2xl">{label}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** What a pressed node had to say for itself, when it could not navigate. */
interface HubNote {
  id: OrchestrationNodeId;
  labelKey: TranslationKey;
  bodyKey: TranslationKey;
  // Spelled `| undefined` rather than left bare: `exactOptionalPropertyTypes`
  // is on, so an outcome that simply has no call to action cannot be copied
  // across without saying that absence is a legal value.
  to?: string | undefined;
  ctaKey?: TranslationKey | undefined;
}

const NODE_SHELL =
  'orch-node-control flex w-full items-center gap-3 rounded-lg border border-border ' +
  'bg-surface/80 p-3 text-left shadow-card backdrop-blur-sm transition-[border-color,box-shadow] ' +
  'hover:border-brand/40 hover:shadow-card-hover lg:flex-col lg:gap-2 lg:p-3.5 lg:text-center ' +
  'disabled:opacity-60';

const NODE_MARK =
  'orch-node-mark flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ' +
  'bg-brand-soft text-brand ring-1 ring-inset ring-brand/15 lg:h-11 lg:w-11';

function NodeTile({
  node,
  index,
  onActivate,
  onPress,
}: {
  node: OrchestrationNode;
  index: number;
  onActivate: (id: OrchestrationNodeId | null) => void;
  onPress: (node: OrchestrationNode) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const { isCustomer, isLoading } = useSession();

  const outcome = resolveNode(node.id, {
    isCustomer,
    isSessionLoading: isLoading,
    hasAssistant: features.assistant,
    hasRecurringOrders: features.recurringOrders,
  });

  const labelId = `orch-label-${node.id}`;
  const hintId = `orch-hint-${node.id}`;
  const Mark = node.icon;

  /*
   * The name is the capability, the description is the supporting line.
   * Composing both into one label instead would have a screen reader announce
   * "AI Assistant Ask about a product before you order it, button", which is
   * a sentence nobody can skim a list of six of.
   */
  const shared = {
    className: NODE_SHELL,
    'aria-labelledby': labelId,
    'aria-describedby': hintId,
    onMouseEnter: () => {
      onActivate(node.id);
    },
    onMouseLeave: () => {
      onActivate(null);
    },
    onFocus: () => {
      onActivate(node.id);
    },
    onBlur: () => {
      onActivate(null);
    },
  };

  const body = (
    <>
      <span aria-hidden="true" className={NODE_MARK}>
        <Mark className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span id={labelId} className="block text-sm font-semibold leading-snug text-ink">
          {t(node.labelKey)}
        </span>
        <span id={hintId} className="mt-0.5 block text-xs leading-snug text-ink-muted">
          {t(node.hintKey)}
        </span>
      </span>
    </>
  );

  const position = nodePosition(node.angle);

  return (
    <li
      className="orch-node"
      style={
        {
          '--orch-x': position.left,
          '--orch-y': position.top,
        } as CssVars
      }
    >
      {/* The float is on this wrapper and nowhere else. Putting it on the
          `<li>` would fight the centring transform; putting it on the control
          would fight the press feedback. */}
      <div
        className="orch-node-float"
        style={{ '--orch-delay': `${(index * 0.55).toFixed(2)}s` } as CssVars}
      >
        {outcome.kind === 'link' ? (
          <Link to={outcome.to} {...shared}>
            {body}
          </Link>
        ) : (
          <button
            type="button"
            // Inert only for the moment before `/auth/me` settles. Offering a
            // guest's answer and then swapping it for a customer's is the
            // flicker every session-aware tile starts with.
            disabled={outcome.kind === 'pending'}
            aria-busy={outcome.kind === 'pending'}
            onClick={() => {
              onPress(node);
            }}
            {...shared}
          >
            {body}
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------

export function SourcingHub(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const { isCustomer, isLoading } = useSession();

  const rootRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<HubNote | null>(null);

  useHubParallax(rootRef);

  /* One attribute, no render. `orchestration.css` reads it to brighten the
     spoke belonging to whichever node the pointer or the focus ring is on. */
  const setActive = useCallback((id: OrchestrationNodeId | null): void => {
    const element = rootRef.current;
    if (element === null) return;

    if (id === null) delete element.dataset.orchActive;
    else element.dataset.orchActive = id;
  }, []);

  const press = useCallback(
    (node: OrchestrationNode): void => {
      const outcome = resolveNode(node.id, {
        isCustomer,
        isSessionLoading: isLoading,
        hasAssistant: features.assistant,
        hasRecurringOrders: features.recurringOrders,
      });

      if (outcome.kind === 'assistant') {
        setNote(null);
        openAssistantPanel();
        return;
      }

      if (outcome.kind === 'note') {
        setNote({
          id: node.id,
          labelKey: node.labelKey,
          bodyKey: outcome.bodyKey,
          to: outcome.to,
          ctaKey: outcome.ctaKey,
        });
      }
    },
    [features.assistant, features.recurringOrders, isCustomer, isLoading],
  );

  return (
    <div>
      <div ref={rootRef} className="orch">
        <div className="orch-stage">
          <HubWeb />
          <HubCore label={t('greeting.hub.sourcing')} />
        </div>

        <ul className="orch-nodes">
          {ORCHESTRATION_NODES.map((node, index) => (
            <NodeTile
              key={node.id}
              node={node}
              index={index}
              onActivate={setActive}
              onPress={press}
            />
          ))}
        </ul>
      </div>

      {/*
       * Where a node that could not navigate says why.
       *
       * `role="status"` and polite, so it is announced without interrupting,
       * and after the list in the DOM so a screen reader meets it where a
       * sighted reader does. Focus deliberately stays on the node that was
       * pressed: the customer may well want to try the one next to it, and
       * moving them into a panel they then have to escape from is the more
       * expensive of the two mistakes.
       */}
      {note !== null && (
        <div
          role="status"
          className="mt-6 rounded-lg border border-border bg-surface/85 p-4 shadow-card backdrop-blur-sm lg:mt-8"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-title-xs text-ink">{t(note.labelKey)}</p>
            <button
              type="button"
              onClick={() => {
                setNote(null);
              }}
              className="-m-1 shrink-0 rounded p-1 text-ink-subtle transition-colors hover:text-ink"
              aria-label={t('common.close')}
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">
            {t(note.bodyKey)}
          </p>

          {note.to !== undefined && note.ctaKey !== undefined && (
            <Link
              to={note.to}
              className={cx(
                'mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-brand',
                'hover:underline',
              )}
            >
              {t(note.ctaKey)}
              <ChevronRightIcon className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
