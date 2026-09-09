/**
 * Opening the chat panel from somewhere that is not the chat panel.
 *
 * The assistant is a widget pinned to the corner of the shell, mounted once by
 * `StoreLayout` and lazily at that. A page cannot reach it: it is not an
 * ancestor, not a descendant, and deliberately not in a context — putting the
 * panel's open/closed state in one would make every page in the app re-render
 * each time somebody opened or closed it.
 *
 * A window event is the smallest thing that works. It is one string in one
 * place, both ends are in this repository, and a deployment with no assistant
 * simply has nobody listening — the greeting page's node resolves to an
 * explanation before it ever gets here, and if it somehow did, dispatching
 * into an empty room is a no-op rather than an error.
 *
 * What this is NOT: a general page-to-widget bus. If a second thing ever needs
 * to talk to the shell, it gets its own named event and its own reason,
 * because a generic `uboss:message` channel is how untraceable coupling
 * starts.
 */

/** The one event. Namespaced, so it cannot collide with a host page's own. */
export const ASSISTANT_OPEN_EVENT = 'uboss:assistant:open';

/** Ask the chat widget to open. Safe to call when nothing is listening. */
export function openAssistantPanel(): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT));
}
