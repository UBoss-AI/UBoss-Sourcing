/**
 * A counter that moves whenever a legal document is published.
 *
 * The agreement gate keeps a short in-memory copy of which versions are in
 * force, because it is asked on every signed-in request. Publishing moves this
 * counter and the copy is thrown away on the next request, so in this process
 * a new version is asked for at once rather than when the copy expires.
 * Another API process learns of it when its own copy expires (seconds).
 *
 * A module of its own so the publishing service can move it without importing
 * the gate, which imports the publishing service.
 */
let generation = 0;

export function legalPublicationGeneration(): number {
  return generation;
}

export function bumpLegalPublicationGeneration(): void {
  generation += 1;
}
