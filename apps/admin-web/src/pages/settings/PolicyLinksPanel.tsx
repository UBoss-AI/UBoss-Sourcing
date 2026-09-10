/**
 * Policy links — the terms, privacy and returns pages this business publishes.
 *
 * Until this panel existed, `PATCH /admin/settings/policy-links` was reachable
 * only by calling it directly, so a fresh deployment shipped with no links at
 * all: an empty storefront footer, and a terms tick at sign-in with nothing
 * beside it to read. That is the gap this closes.
 *
 * Three things it is careful about, because each one loses data quietly:
 *
 *   - **The label is the key.** The backend stores a JSON object, so two rows
 *     sharing a label are one row by the time it is written and the second
 *     silently replaces the first. This refuses to save that rather than
 *     letting somebody discover a missing link a week later.
 *   - **Order is kept.** The rows are written in the order shown and read back
 *     in it, and both frontends render them in that order. So this is a list
 *     that can be arranged, not a set.
 *   - **A blank row is a deletion.** The server drops any entry whose address
 *     is empty, which is a real way to lose a link by tabbing through. Rows are
 *     therefore validated here before the request, and removal is an explicit
 *     button.
 *
 * Plain controlled state rather than react-hook-form: the shape is a list of a
 * length nobody knows in advance, which a field-per-name resolver is the wrong
 * tool for.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Button, Callout, Card, ErrorState, Field, Input, LoadingState } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

/**
 * The part of the business profile this panel reads.
 *
 * Narrow on purpose, against the same query key `BusinessPanel` uses, so the
 * profile is fetched once for the whole screen.
 */
interface BusinessPolicyResponse {
  business: {
    policyLinks: Record<string, string> | null;
  };
}

interface Row {
  /**
   * A key for React, not data.
   *
   * The label cannot serve: it is edited as somebody types, and a key that
   * changes on every keystroke unmounts the input being typed into and takes
   * the caret with it.
   */
  id: number;
  label: string;
  url: string;
  /** The message under this row, if it has one. */
  error: string | null;
}

let nextRowId = 0;

function makeRow(label = '', url = ''): Row {
  nextRowId += 1;
  return { id: nextRowId, label, url, error: null };
}

function toRows(links: Record<string, string> | null): Row[] {
  return Object.entries(links ?? {}).map(([label, url]) => makeRow(label, url));
}

export function PolicyLinksPanel(): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Whether the rows on screen are somebody's unsaved work.
   *
   * A ref rather than state: nothing renders differently for it, and it has to
   * be readable by the effect below in the same tick it is set.
   */
  const isEdited = useRef(false);

  const query = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.get<BusinessPolicyResponse>('/admin/settings/business'),
  });

  useEffect(() => {
    if (query.data === undefined) return;

    // Never over the top of an edit in progress. This query key is shared with
    // the business profile panel above — deliberately, so the profile is
    // fetched once — and saving *that* invalidates it. Without this guard,
    // pressing Save up there silently discards links typed down here.
    if (isEdited.current) return;

    setRows(toRows(query.data.business.policyLinks));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (links: Record<string, string>) =>
      api.patch('/admin/settings/policy-links', links),
    onSuccess: async () => {
      setFormError(null);
      // Saved, so the refetch below is now the truth rather than a thing that
      // would overwrite unsaved work.
      isEdited.current = false;
      toast.success(t('policyLinks.saved'));

      // Both caches: the profile this panel reads, and the public config that
      // the storefront footer and the two sign-in ticks read. Without the
      // second, a link added here does not appear beside the tick until the
      // page is reloaded.
      await queryClient.invalidateQueries({ queryKey: ['business-profile'] });
      await queryClient.invalidateQueries({ queryKey: ['storefront-config'] });
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) {
        setFormError(t('policyLinks.saveFailed'));
        return;
      }

      // The server keys a rejected address by its label — `policyLinks.Terms
      // of business` — so the message can be put on the row it is about
      // instead of in a banner above a list of eight.
      const named = new Map(
        error.details
          .filter((detail) => detail.field?.startsWith('policyLinks.') === true)
          .map((detail) => [detail.field?.slice('policyLinks.'.length) ?? '', detail.message]),
      );

      if (named.size === 0) {
        setFormError(error.message);
        return;
      }

      setFormError(null);
      setRows((current) =>
        current === null
          ? current
          : current.map((row) =>
              named.has(row.label)
                ? { ...row, error: named.get(row.label) ?? t('policyLinks.urlNotHttp') }
                : { ...row, error: null },
            ),
      );
    },
  });

  const canWrite = can(Permission.SETTINGS_WRITE);
  const busy = save.isPending;

  const update = (id: number, patch: Partial<Pick<Row, 'label' | 'url'>>): void => {
    isEdited.current = true;
    setRows((current) =>
      current === null
        ? current
        : // Editing a row clears its message: the reader has been told, and
          // leaving a stale complaint under a field somebody is fixing is how
          // a form starts arguing with itself.
          current.map((row) => (row.id === id ? { ...row, ...patch, error: null } : row)),
    );
  };

  /**
   * Validate, and build the object the endpoint takes.
   *
   * Returns null when something is wrong, having put each message on its own
   * row. The rules mirror the server's exactly — the address must be http(s),
   * and a label may appear once — so a save that would be rejected never
   * leaves the browser, and one that leaves it is not rejected for a reason
   * this screen could have said sooner.
   */
  const collect = (current: Row[]): Record<string, string> | null => {
    const seen = new Set<string>();
    const checked = current.map((row) => {
      const label = row.label.trim();
      const url = row.url.trim();

      if (label.length === 0) return { ...row, error: t('policyLinks.labelRequired') };
      if (url.length === 0) return { ...row, error: t('policyLinks.urlRequired') };
      if (!/^https?:\/\//i.test(url)) return { ...row, error: t('policyLinks.urlNotHttp') };
      if (seen.has(label)) return { ...row, error: t('policyLinks.duplicateLabel') };

      seen.add(label);
      return { ...row, label, url, error: null };
    });

    setRows(checked);
    if (checked.some((row) => row.error !== null)) return null;

    // Insertion order, so the list reads on the storefront and at sign-in in
    // the order it is arranged here.
    const links: Record<string, string> = {};
    for (const row of checked) links[row.label] = row.url;
    return links;
  };

  return (
    <Card
      title={t('policyLinks.title')}
      description={t('policyLinks.description')}
      bodyClassName="space-y-5 px-5 py-4"
    >
      {query.isPending && <LoadingState label={t('policyLinks.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {rows !== null && (
        <>
          {formError !== null && (
            <Callout tone="danger" role="alert">
              {formError}
            </Callout>
          )}

          {!canWrite && <Callout tone="neutral">{t('settings.youCanReadTheseSettings')}</Callout>}

          <Callout tone="info">{t('policyLinks.howItWorks')}</Callout>

          {rows.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('policyLinks.none')}</p>
          ) : (
            <ul className="space-y-4">
              {rows.map((row, index) => (
                <li
                  key={row.id}
                  className="rounded-md border border-border bg-surface-sunken px-3 py-3"
                >
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-start">
                    <Field label={t('policyLinks.labelLabel')} hint={t('policyLinks.labelHint')}>
                      {({ inputId, describedBy }) => (
                        <Input
                          id={inputId}
                          aria-describedby={describedBy}
                          value={row.label}
                          maxLength={64}
                          disabled={!canWrite || busy}
                          onChange={(event) => {
                            update(row.id, { label: event.target.value });
                          }}
                        />
                      )}
                    </Field>

                    <Field label={t('policyLinks.urlLabel')} hint={t('policyLinks.urlHint')}>
                      {({ inputId, describedBy }) => (
                        <Input
                          id={inputId}
                          aria-describedby={describedBy}
                          type="url"
                          inputMode="url"
                          placeholder="https://"
                          value={row.url}
                          maxLength={1024}
                          invalid={row.error !== null}
                          disabled={!canWrite || busy}
                          onChange={(event) => {
                            update(row.id, { url: event.target.value });
                          }}
                        />
                      )}
                    </Field>

                    {canWrite && (
                      <div className="sm:pt-6">
                        <Button
                          variant="ghost"
                          disabled={busy}
                          // Named, because a column of buttons all called
                          // "Remove" tells a screen-reader user nothing about
                          // which one they are on.
                          aria-label={
                            row.label.trim().length === 0
                              ? t('policyLinks.removeUnnamed', { position: index + 1 })
                              : t('policyLinks.removeNamed', { label: row.label.trim() })
                          }
                          onClick={() => {
                            isEdited.current = true;
                            setFormError(null);
                            setRows(rows.filter((other) => other.id !== row.id));
                          }}
                        >
                          {t('policyLinks.remove')}
                        </Button>
                      </div>
                    )}
                  </div>

                  {row.error !== null && (
                    <p role="alert" className="mt-2 text-xs font-medium text-danger">
                      {row.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canWrite && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  isEdited.current = true;
                  setFormError(null);
                  setRows([...rows, makeRow()]);
                }}
              >
                {t('policyLinks.add')}
              </Button>

              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  const links = collect(rows);
                  if (links === null) return;
                  save.mutate(links);
                }}
              >
                {busy ? t('policyLinks.saving') : t('policyLinks.save')}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
