/**
 * "Do my system and this one hold the same products?"
 *
 * The question a buyer has on the first day and, until this tab existed, could
 * only answer by reading a sync log that said "read 736 records and recorded 1"
 * — accurate, and silent about which one, and about why the other 735 went
 * nowhere.
 *
 * So the screen is three numbers and three lists, and the SHAPE of the numbers
 * is the answer: a healthy connection is mostly green, and a connection whose
 * two sides use different product codes is almost entirely amber. Nobody should
 * have to read a definition to tell those two apart.
 *
 * It runs on a button rather than on tab click. Answering the question means
 * walking the buyer's whole ERP feed, which costs what a sync pass costs — fine
 * when somebody asks for it, rude every time they glance at the page.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AccountPanel } from '../AccountPanel';
import { Button } from '@/components/ui';
import { AlertIcon, CheckIcon, RefreshIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { customerErpApi, type ReconciliationRow } from '@/lib/customer-erp';

export function ErpMatchingTab({
  connectionId,
  systemLabel,
}: {
  connectionId: string;
  systemLabel: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();

  const check = useMutation({
    mutationFn: () => customerErpApi.reconcile(connectionId),
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const data = check.data;

  return (
    <div className="space-y-6">
      <AccountPanel
        title={t('erp.matching.title')}
        description={t('erp.matching.description', { system: systemLabel })}
      >
        <Button variant="primary" onClick={() => { check.mutate(); }} isLoading={check.isPending}>
          <RefreshIcon aria-hidden="true" className="h-4 w-4" />
          {data === undefined ? t('erp.matching.check') : t('erp.matching.checkAgain')}
        </Button>

        {check.isPending && (
          <p className="mt-3 text-xs leading-relaxed text-ink-muted">
            {t('erp.matching.checking', { system: systemLabel })}
          </p>
        )}

        {data === undefined && !check.isPending && (
          <p className="mt-3 max-w-prose text-xs leading-relaxed text-ink-muted">
            {t('erp.matching.idle', { system: systemLabel })}
          </p>
        )}
      </AccountPanel>

      {data !== undefined && (
        <>
          <AccountPanel title={t('erp.matching.resultTitle')}>
            {/*
             * Three counts, in the order somebody reads them: what works, what
             * their system has that we do not, and what we have that it does
             * not. The last is the one that costs money — a product whose stock
             * figure will never be updated and nobody would notice — so it is
             * deliberately the one the eye ends on.
             */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <CountCard
                tone="success"
                value={data.inBoth.count}
                label={t('erp.matching.inBoth')}
                hint={t('erp.matching.inBothHint')}
              />
              <CountCard
                tone="neutral"
                value={data.onlyInErp.count}
                label={t('erp.matching.onlyInErp', { system: systemLabel })}
                hint={t('erp.matching.onlyInErpHint')}
              />
              <CountCard
                tone={data.onlyHere.count > 0 ? 'warning' : 'success'}
                value={data.onlyHere.count}
                label={t('erp.matching.onlyHere')}
                hint={t('erp.matching.onlyHereHint')}
              />
            </div>

            {/*
             * The sentence that saves somebody working it out. Nothing matching
             * at all almost always means one thing — the two sides use
             * different product codes — and saying so is worth more than three
             * correct numbers a person has to interpret.
             */}
            <p
              className={cx(
                'mt-4 flex items-start gap-2 rounded-md p-3 text-sm leading-relaxed',
                data.inBoth.count === 0 ? 'bg-warning-soft text-ink' : 'bg-surface-sunken text-ink-muted',
              )}
            >
              {data.inBoth.count === 0 ? (
                <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              ) : (
                <CheckIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              )}
              {data.inBoth.count === 0
                ? t('erp.matching.verdictNone', { system: systemLabel })
                : t('erp.matching.verdictSome', {
                    matched: data.inBoth.count,
                    total: data.catalogueCount,
                    system: systemLabel,
                  })}
            </p>

            {data.truncated && (
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                {t('erp.matching.truncated', { count: data.erpCodeCount })}
              </p>
            )}

            <p className="mt-2 text-xs text-ink-subtle">
              {t('erp.matching.checkedAt', { when: formatDateTime(data.checkedAt) })}
            </p>
          </AccountPanel>

          <MatchList
            title={t('erp.matching.inBoth')}
            description={t('erp.matching.inBothHint')}
            emptyBody={t('erp.matching.inBothEmpty', { system: systemLabel })}
            group={data.inBoth}
            systemLabel={systemLabel}
            showQuantity
          />

          <MatchList
            title={t('erp.matching.onlyHere')}
            description={t('erp.matching.onlyHereHint')}
            emptyBody={t('erp.matching.onlyHereEmpty', { system: systemLabel })}
            group={data.onlyHere}
            systemLabel={systemLabel}
          />

          <MatchList
            title={t('erp.matching.onlyInErp', { system: systemLabel })}
            description={t('erp.matching.onlyInErpHint')}
            emptyBody={t('erp.matching.onlyInErpEmpty')}
            group={data.onlyInErp}
            systemLabel={systemLabel}
          />
        </>
      )}

      {/*
       * Always present, not only after a check has run.
       *
       * This is where somebody FIXES what the lists above report, and a buyer
       * who already knows their two systems use different codes should not
       * have to walk a seven-hundred-row comparison first in order to reach the
       * tool that closes it.
       */}
      <ProductCodePanel connectionId={connectionId} systemLabel={systemLabel} />
    </div>
  );
}

/**
 * "Their code X is our product Y."
 *
 * The answer to the situation the lists above exist to reveal, and the only
 * part of this tab that changes anything.
 *
 * **Paste, not a row of dropdowns.** The gap this was built for was 708 codes
 * against 247 products with no identifier in common. A per-row product picker
 * is the obvious design and it is the wrong one at that size: nobody finishes
 * seven hundred dropdowns, so the feature would be built, demonstrated, and
 * never used. Two columns out of the spreadsheet the buyer already has open is
 * a job somebody actually completes.
 *
 * Bad rows are reported with their line number and the rest are imported. A
 * file that size will have a few stale codes in it, and refusing all of it
 * because of three is how somebody gives up.
 */
function ProductCodePanel({
  connectionId,
  systemLabel,
}: {
  connectionId: string;
  systemLabel: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');

  const mappings = useQuery({
    queryKey: ['erp', connectionId, 'product-codes'],
    queryFn: () => customerErpApi.listProductCodes(connectionId),
  });

  const upload = useMutation({
    mutationFn: () => customerErpApi.importProductCodes(connectionId, csv),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['erp', connectionId, 'product-codes'] });
      setCsv('');
      toast.success(
        t('erp.codes.imported', { created: result.created, updated: result.updated }),
      );
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const remove = useMutation({
    mutationFn: (mappingId: string) => customerErpApi.unlinkProductCode(connectionId, mappingId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['erp', connectionId, 'product-codes'] });
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const rows = mappings.data ?? [];
  const result = upload.data;

  return (
    <AccountPanel
      title={t('erp.codes.title')}
      description={t('erp.codes.description', { system: systemLabel })}
    >
      <label htmlFor="erp-code-csv" className="block text-sm font-medium text-ink">
        {t('erp.codes.pasteLabel', { system: systemLabel })}
      </label>

      <textarea
        id="erp-code-csv"
        value={csv}
        onChange={(event) => { setCsv(event.target.value); }}
        rows={6}
        spellCheck={false}
        placeholder={'FG/1BZ1B1-G,EV-CANNULA-WP\nFG/1BZ1B3-G,EF-SALINE'}
        className="mt-2 w-full rounded-lg border border-border bg-surface p-3 font-mono text-xs text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
      />

      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{t('erp.codes.pasteHint')}</p>

      <div className="mt-3">
        <Button
          variant="primary"
          onClick={() => { upload.mutate(); }}
          isLoading={upload.isPending}
          disabled={csv.trim().length === 0}
        >
          {t('erp.codes.import')}
        </Button>
      </div>

      {result !== undefined && result.skipped.length > 0 && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <AlertIcon aria-hidden="true" className="h-4 w-4 text-warning" />
            {t('erp.codes.skipped', { count: result.skipped.length })}
          </p>

          <ul className="mt-2 space-y-1">
            {result.skipped.slice(0, 20).map((entry) => (
              <li key={`${String(entry.line)}-${entry.erpCode}`} className="text-xs text-ink-muted">
                <span className="font-mono">
                  {t('erp.codes.line', { line: entry.line })}
                </span>{' '}
                {entry.erpCode} — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-medium text-brand">
            {t('erp.codes.showMapped', { count: rows.length })}
          </summary>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="text-xxs uppercase tracking-wider text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3 font-semibold">
                    {t('erp.matching.codeThere', { system: systemLabel })}
                  </th>
                  <th className="pb-2 pr-3 font-semibold">{t('erp.matching.product')}</th>
                  <th className="pb-2 font-semibold">
                    <span className="sr-only">{t('common.remove')}</span>
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-border-subtle">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-muted">{row.erpCode}</td>
                    <td className="py-2 pr-3 text-ink">
                      {/* A mapping can outlive the product it names: there is
                          no foreign key, so a deleted product leaves the row
                          pointing at nothing. Shown as broken rather than
                          hidden, because a buyer needs to know it stopped
                          working. */}
                      {row.productName ?? (
                        <span className="text-warning">{t('erp.codes.productGone')}</span>
                      )}
                      {row.sku !== null && (
                        <span className="ml-2 font-mono text-xs text-ink-subtle">{row.sku}</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => { remove.mutate(row.id); }}
                        className="rounded text-xs font-medium text-ink-subtle hover:text-danger"
                      >
                        {t('common.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </AccountPanel>
  );
}

/** One number, big enough to read without leaning in. */
function CountCard({
  tone,
  value,
  label,
  hint,
}: {
  tone: 'success' | 'warning' | 'neutral';
  value: number;
  label: string;
  hint: string;
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'rounded-lg border p-4',
        tone === 'success'
          ? 'border-success/30 bg-success-soft'
          : tone === 'warning'
            ? 'border-warning/30 bg-warning-soft'
            : 'border-border bg-surface-sunken',
      )}
    >
      <p
        className={cx(
          'text-3xl font-semibold tabular-nums',
          tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-ink',
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-sm font-medium text-ink">{label}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{hint}</p>
    </div>
  );
}

/**
 * One of the three lists.
 *
 * Collapsed behind a summary. The counts above are the answer; a list is for
 * somebody who has read the answer and wants to see which products it is about
 * — and a buyer with seven hundred unmatched codes should not have them
 * unrolled down their screen before they asked for them.
 */
function MatchList({
  title,
  description,
  emptyBody,
  group,
  systemLabel,
  showQuantity = false,
}: {
  title: string;
  description: string;
  emptyBody: string;
  group: { count: number; rows: ReconciliationRow[] };
  systemLabel: string;
  showQuantity?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <AccountPanel title={`${title} · ${String(group.count)}`} description={description}>
      {group.count === 0 ? (
        <p className="text-sm leading-relaxed text-ink-muted">{emptyBody}</p>
      ) : (
        <details>
          <summary className="cursor-pointer text-sm font-medium text-brand">
            {t('erp.matching.showList', { count: group.count })}
          </summary>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="text-xxs uppercase tracking-wider text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-3 font-semibold">{t('erp.matching.product')}</th>
                  <th className="pb-2 pr-3 font-semibold">{t('erp.matching.codeHere')}</th>
                  <th className="pb-2 pr-3 font-semibold">
                    {t('erp.matching.codeThere', { system: systemLabel })}
                  </th>
                  {showQuantity && (
                    <th className="pb-2 font-semibold">{t('erp.matching.quantity')}</th>
                  )}
                </tr>
              </thead>

              <tbody className="divide-y divide-border-subtle">
                {group.rows.map((row) => (
                  <tr key={row.erpCode}>
                    <td className="py-2 pr-3 text-ink">
                      {row.productName ?? (
                        <span className="text-ink-subtle">{t('erp.matching.notInCatalogue')}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-muted">{row.sku ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-muted">
                      {/*
                       * Their code, but only where they actually have it. A
                       * product that is only in our catalogue has no counterpart
                       * over there, and repeating our own SKU in that column
                       * would read as if it did.
                       */}
                      {row.productName === null || row.sku === row.erpCode ? row.erpCode : '—'}
                    </td>
                    {showQuantity && (
                      <td className="py-2 tabular-nums text-ink-muted">{row.onHandQty ?? '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {group.rows.length < group.count && (
              <p className="mt-3 text-xs text-ink-subtle">
                {t('erp.matching.sampleOnly', { shown: group.rows.length, count: group.count })}
              </p>
            )}
          </div>
        </details>
      )}
    </AccountPanel>
  );
}
