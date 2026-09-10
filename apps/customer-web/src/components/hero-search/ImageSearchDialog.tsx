/**
 * Search the catalogue with a photograph.
 *
 * A dialog rather than a page, and that is a considered choice. The obvious
 * alternative — navigate to `/image-search` and render results there — cannot
 * work honestly: the thing being searched with is a `File` in memory, and a
 * route is a URL. Either the file is uploaded and stored somewhere so a link
 * can point at it (which means keeping photographs taken inside a customer's
 * store room, for no benefit to them), or the page is one refresh away from
 * being empty. A dialog owns the file for exactly as long as the search takes
 * and then lets go of it.
 *
 * What the customer gets, in order: two ways to supply an image, a preview
 * they can replace or remove, the sentence describing how their picture was
 * read, and the matches as ordinary catalogue cards. The description is not
 * decoration — the match is on what the model recognises the item to be, so a
 * misreading has to be visible as a misreading rather than looking like a
 * catalogue full of the wrong stock. Under the results is the way back into
 * the ordinary catalogue, carrying the words the picture produced, because a
 * shopper who can now name the thing is better served by filters and
 * pagination than by twelve cards.
 *
 * The endpoint is behind the customer session — it spends the operator's AI
 * provider budget on every call — so a guest is offered a way in rather than a
 * file picker that leads to a 401.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { ProductCard } from '@/components/ProductCard';
import { Button, ButtonLink, Spinner } from '@/components/ui';
import { CameraIcon, CloseIcon, PlusIcon, SearchIcon } from '@/components/icons';
import { useLocale } from '@/app/locale-context';
import { ApiError, NetworkError } from '@/lib/api';
import { IMAGE_ACCEPT_ATTRIBUTE, rejectImage, searchByImage } from '@/lib/image-search';
import type { ImageSearchResult } from '@/lib/image-search';
import { useI18n } from '@/i18n/i18n-context';

/** What the dialog is doing. One state, so two of them cannot both be true. */
type Phase =
  | { kind: 'choosing' }
  | { kind: 'searching' }
  | { kind: 'results'; result: ImageSearchResult }
  | { kind: 'failed'; message: string };

export function ImageSearchDialog({
  isOpen,
  onClose,
  onUse,
}: {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Hand the matches back to the opener instead of linking into the catalogue.
   *
   * Passed by AI Mode, where the same search is the paperclip button: the
   * customer photographs what they have, and what came back becomes context in
   * the composer for the question they were going to ask about it. Absent on
   * the landing page, where the destination is the catalogue itself.
   */
  onUse?: ((result: ImageSearchResult) => void) | undefined;
}): React.JSX.Element {
  const { t, language } = useI18n();
  const { currency, country } = useLocale();
  const { isCustomer, isLoading: isSessionLoading } = useSession();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'choosing' });

  const uploadRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  /*
   * The preview is an object URL, and an object URL that is not revoked is a
   * leak of the whole image for the life of the document. Revoked on every
   * change and on unmount, which is why the URL is state rather than something
   * derived during render — a render-time `createObjectURL` would mint one per
   * render with nothing to revoke them.
   */
  useEffect(() => {
    if (file === null) {
      setPreviewUrl(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Closing mid-search stops the request, which stops the generation the
  // deployment is paying for rather than letting it run into a dead socket.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setFile(null);
    setRejection(null);
    setPhase({ kind: 'choosing' });
    // Or choosing the same file twice in a row fires no `change` event and the
    // dialog appears to ignore the second attempt.
    if (uploadRef.current !== null) uploadRef.current.value = '';
    if (captureRef.current !== null) captureRef.current.value = '';
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const accept = (chosen: File | undefined): void => {
    if (chosen === undefined) return;

    const problem = rejectImage(chosen);
    if (problem !== null) {
      setFile(null);
      setRejection(
        problem.reason === 'size' ? t(problem.key, { maxMb: problem.maxMb }) : t(problem.key),
      );
      return;
    }

    setRejection(null);
    setPhase({ kind: 'choosing' });
    setFile(chosen);
  };

  const run = async (): Promise<void> => {
    if (file === null) return;

    const abort = new AbortController();
    abortRef.current = abort;
    setPhase({ kind: 'searching' });

    try {
      const result = await searchByImage(file, {
        currency,
        country,
        language,
        signal: abort.signal,
      });
      setPhase({ kind: 'results', result });
    } catch (caught) {
      if (abort.signal.aborted) return;

      /*
       * The server's own message is used where there is one, because these are
       * the two cases where it says something specific and actionable — the
       * provider is over quota, or the photograph could not be read. Falling
       * back to a generic line here would throw away the only sentence that
       * tells the customer whether to wait or to try a clearer picture.
       */
      if (caught instanceof ApiError) {
        setPhase({
          kind: 'failed',
          message: caught.isAuthError ? t('imageSearch.error.signedOut') : caught.message,
        });
        return;
      }

      setPhase({
        kind: 'failed',
        message:
          caught instanceof NetworkError ? caught.message : t('imageSearch.error.unexpected'),
      });
    } finally {
      abortRef.current = null;
    }
  };

  const results = phase.kind === 'results' ? phase.result : null;
  const refineHref =
    results === null || results.terms.length === 0
      ? '/products'
      : `/products?q=${encodeURIComponent(results.terms.join(' '))}`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={t('imageSearch.title')}
      description={t('imageSearch.description')}
      size="lg"
    >
      {/* A guest sees the way in and nothing else. The endpoint would answer
          401, and a file picker that ends in a sign-in wall wastes the upload
          as well as the customer's time. */}
      {!isSessionLoading && !isCustomer ? (
        <div className="space-y-4 py-2">
          <p className="text-sm leading-relaxed text-ink-muted">{t('imageSearch.signInBody')}</p>
          <ButtonLink
            to="/login"
            state={{ from: '/products' }}
            variant="primary"
            onClick={close}
          >
            {t('imageSearch.signInAction')}
          </ButtonLink>
        </div>
      ) : (
        <div className="space-y-5">
          {/* --- Pick an image ------------------------------------------- */}
          <div>
            {/*
             * Two inputs, not one with a toggle. `capture` is a hint to open
             * the camera directly, and a browser that does not honour it falls
             * back to its ordinary picker — which is the right degradation, but
             * only if the other button still offers the plain picker for a
             * desktop with no camera at all.
             */}
            <input
              ref={captureRef}
              type="file"
              accept={IMAGE_ACCEPT_ATTRIBUTE}
              capture="environment"
              className="sr-only"
              onChange={(event) => {
                accept(event.target.files?.[0]);
              }}
            />
            <input
              ref={uploadRef}
              type="file"
              accept={IMAGE_ACCEPT_ATTRIBUTE}
              className="sr-only"
              onChange={(event) => {
                accept(event.target.files?.[0]);
              }}
            />

            {previewUrl === null ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => captureRef.current?.click()}
                  className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-sunken px-4 py-7 text-center transition-colors hover:border-brand hover:bg-brand-soft"
                >
                  <CameraIcon className="h-6 w-6 text-brand" />
                  <span className="text-sm font-medium text-ink">
                    {t('imageSearch.takePhoto')}
                  </span>
                  <span className="text-xs text-ink-muted">{t('imageSearch.takePhotoHint')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => uploadRef.current?.click()}
                  className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-sunken px-4 py-7 text-center transition-colors hover:border-brand hover:bg-brand-soft"
                >
                  <PlusIcon className="h-6 w-6 text-brand" />
                  <span className="text-sm font-medium text-ink">
                    {t('imageSearch.uploadImage')}
                  </span>
                  <span className="text-xs text-ink-muted">{t('imageSearch.uploadHint')}</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-3 sm:flex-row sm:items-center">
                <img
                  src={previewUrl}
                  alt={t('imageSearch.previewAlt')}
                  className="h-32 w-full rounded-md object-contain sm:h-24 sm:w-32"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{file?.name}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {t('imageSearch.fileSize', {
                      kb: Math.max(1, Math.round((file?.size ?? 0) / 1024)),
                    })}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => uploadRef.current?.click()}
                      disabled={phase.kind === 'searching'}
                    >
                      {t('imageSearch.replace')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={reset}
                      disabled={phase.kind === 'searching'}
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                      {t('imageSearch.remove')}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {rejection !== null && (
              <p role="alert" className="mt-2.5 text-sm text-danger">
                {rejection}
              </p>
            )}
          </div>

          {/* --- Search -------------------------------------------------- */}
          {file !== null && phase.kind !== 'results' && (
            <Button
              onClick={() => {
                void run();
              }}
              disabled={phase.kind === 'searching'}
              fullWidth
            >
              {phase.kind === 'searching' ? (
                <>
                  <Spinner className="h-4 w-4" />
                  {t('imageSearch.searching')}
                </>
              ) : (
                <>
                  <SearchIcon className="h-4 w-4" />
                  {t('imageSearch.searchThisImage')}
                </>
              )}
            </Button>
          )}

          {phase.kind === 'searching' && (
            <p role="status" className="text-center text-xs text-ink-muted">
              {t('imageSearch.searchingHint')}
            </p>
          )}

          {phase.kind === 'failed' && (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5"
            >
              <p className="text-sm text-danger">{phase.message}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2.5"
                onClick={() => {
                  void run();
                }}
              >
                {t('imageSearch.tryAgain')}
              </Button>
            </div>
          )}

          {/* --- Results -------------------------------------------------- */}
          {results !== null && (
            <div className="space-y-4">
              {results.description.length > 0 && (
                <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5">
                  <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
                    {t('imageSearch.readAs')}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-ink">{results.description}</p>
                </div>
              )}

              {results.products.length === 0 ? (
                <div className="rounded-lg border border-border bg-surface px-5 py-8 text-center">
                  <p className="text-sm font-medium text-ink">{t('imageSearch.noMatches')}</p>
                  <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-ink-muted">
                    {t('imageSearch.noMatchesHint')}
                  </p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <Button size="sm" variant="secondary" onClick={reset}>
                      {t('imageSearch.tryAnotherImage')}
                    </Button>
                    <Link
                      to={refineHref}
                      onClick={close}
                      className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-brand hover:underline"
                    >
                      {t('imageSearch.searchByName')}
                    </Link>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm font-medium text-ink">
                    {t('imageSearch.matchCount', { count: results.products.length })}
                  </p>
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {results.products.map((product) => (
                      <li key={product.id}>
                        <ProductCard product={product} />
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                    <Button size="sm" variant="ghost" onClick={reset}>
                      {t('imageSearch.tryAnotherImage')}
                    </Button>
                    {onUse === undefined ? (
                      /* Back into the real catalogue, carrying the words the
                         picture produced. Twelve cards is a look; filters and
                         pagination are how somebody actually buys. */
                      <Link
                        to={refineHref}
                        onClick={close}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        {t('imageSearch.refineInCatalogue')}
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          onUse(results);
                          reset();
                        }}
                      >
                        {t('imageSearch.useInQuestion')}
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
