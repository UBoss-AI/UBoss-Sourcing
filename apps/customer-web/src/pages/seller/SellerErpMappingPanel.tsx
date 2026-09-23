/**
 * Matching what is here to what is in a seller's TallyPrime.
 *
 * WHY THIS IS A PICKER AND NOT A TEXT BOX
 *
 * Tally keys its masters BY NAME. A ledger is "Acme Hospitals Pvt Ltd" and that
 * string is the identifier — there is no id to hold onto. So a typed name that
 * is one space or one full stop away from the real one is a mapping that looks
 * complete on screen and fails at post time, and the seller finds out when
 * their month's sales did not arrive.
 *
 * The options therefore come from what a master pull actually found in their
 * own Tally. Where the list is empty, the answer is "re-read the lists from
 * Tally", not "type it carefully".
 *
 * WHY NOTHING IS CONFIRMED AUTOMATICALLY
 *
 * A name match is a SUGGESTION. Posting a quarter of somebody's revenue against
 * a ledger nobody looked at is the failure this whole screen exists to prevent,
 * so a suggested match is offered pre-filled and unconfirmed, and the seller
 * ticks it. Nothing syncs against an unconfirmed row.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Select } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { errorMessage } from '@/lib/errors';
import { useT } from '@/i18n/i18n-context';
import {
  fetchErpMappings,
  fetchTallyMasters,
  saveErpMappings,
  type MissingMapping,
} from '@/lib/seller-erp';

/**
 * Which Tally list a mapping is chosen from.
 *
 * A voucher type is not a ledger and a godown is not a stock item, and offering
 * four hundred ledgers where a voucher type belongs is how somebody maps
 * "Sales" the ledger onto "Sales" the voucher type and produces a voucher that
 * posts to nothing.
 */
function listFor(entity: string): string {
  if (entity === 'STOCK_ITEM') return 'STOCK_ITEM';
  if (entity === 'GODOWN') return 'GODOWN';
  if (entity === 'UNIT' || entity === 'ALTERNATE_UNIT') return 'UNIT';
  if (entity.endsWith('VOUCHER_TYPE')) return 'SALES_INVOICE_VOUCHER_TYPE';
  if (entity === 'COST_CENTRE') return 'COST_CENTRE';
  // Everything else is a ledger: the party, the sales account, freight,
  // discount, commission, gateway fees, rounding and every tax account.
  return 'PARTY_LEDGER';
}

interface SellerErpMappingPanelProps {
  connectionId: string;
  /** What is still to be matched, from the connection read. */
  missing: MissingMapping[];
}

export function SellerErpMappingPanel({
  connectionId,
  missing,
}: SellerErpMappingPanelProps): React.JSX.Element | null {
  const t = useT();
  const toast = useToast();
  const client = useQueryClient();

  /** Entity+key → the Tally name chosen but not yet saved. */
  const [chosen, setChosen] = useState<Record<string, string>>({});

  const existing = useQuery({
    queryKey: ['seller', 'erp', 'mappings', connectionId],
    queryFn: () => fetchErpMappings(connectionId),
  });

  /*
   * Which Tally lists this panel needs, worked out from what is missing.
   *
   * Fetched per LIST rather than per row: a seller with two hundred unmatched
   * stock items needs the stock-item list once, not two hundred times.
   */
  const lists = useMemo(
    () => [...new Set(missing.map((row) => listFor(row.entity)))],
    [missing],
  );

  const masters = useQuery({
    queryKey: ['seller', 'erp', 'masters', connectionId, lists],
    queryFn: async () => {
      const byList: Record<string, { tallyName: string; parentName: string | null }[]> = {};

      for (const list of lists) {
        const result = await fetchTallyMasters(connectionId, list);
        byList[list] = result.masters;
      }

      return byList;
    },
    enabled: lists.length > 0,
  });

  const save = useMutation({
    mutationFn: () => {
      const rows = missing
        .map((row) => ({ row, tallyName: chosen[`${row.entity}:${row.localKey}`] ?? '' }))
        .filter((entry) => entry.tallyName !== '')
        .map((entry) => ({
          entity: entry.row.entity,
          localKey: entry.row.localKey,
          localLabel: entry.row.localLabel,
          tallyName: entry.tallyName,
          // Confirmed by the act of choosing and saving. The seller is looking
          // at their own Tally's list and pressing Save; that IS the
          // confirmation, and asking for a second tick after it would be
          // ceremony rather than a check.
          isConfirmed: true,
        }));

      return saveErpMappings(connectionId, rows);
    },
    onSuccess: async () => {
      setChosen({});
      toast.success(t('sellerErp.mappingsSaved'));
      await client.invalidateQueries({ queryKey: ['seller', 'erp'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotSaveMappings')));
    },
  });

  if (missing.length === 0) return null;

  const chosenCount = Object.values(chosen).filter((value) => value !== '').length;

  return (
    <Card
      title={t('sellerErp.mappings')}
      description={t('sellerErp.mappingsIntro')}
      actions={<Badge tone="warning">{String(missing.length)}</Badge>}
      bodyClassName="px-6 py-5"
    >
      {/* An empty list is a different problem from an unmatched row, and it has
          a different answer: read the lists out of Tally, rather than look
          harder at an empty picker. */}
      {masters.isSuccess && lists.every((list) => (masters.data[list] ?? []).length === 0) && (
        <p className="mb-4 rounded-lg bg-warning-soft p-3 text-sm text-warning">
          {t('sellerErp.noMastersYet')}
        </p>
      )}

      <ul className="space-y-3">
        {missing.slice(0, 50).map((row) => {
          const key = `${row.entity}:${row.localKey}`;
          const options = masters.data?.[listFor(row.entity)] ?? [];

          return (
            <li key={key} className="flex flex-wrap items-end gap-3 border-b border-border-subtle pb-3">
              <span className="min-w-[14rem] flex-1">
                <span className="block text-sm font-medium">{row.localLabel ?? row.entity}</span>
                {/* Why this one is needed, in the seller's own terms, rather
                    than a bare entity name they have to decode. */}
                <span className="block text-xs text-ink-muted">{row.because}</span>
              </span>

              <label className="min-w-[16rem] flex-1 text-sm">
                <span className="mb-1 block text-xs text-ink-muted">
                  {t('sellerErp.matchInTally')}
                </span>
                <Select
                  value={chosen[key] ?? ''}
                  disabled={options.length === 0}
                  onChange={(event) => {
                    const next = event.target.value;
                    setChosen((current) => ({ ...current, [key]: next }));
                  }}
                >
                  <option value="">{t('sellerErp.chooseFromTally')}</option>
                  {options.map((option) => (
                    <option key={option.tallyName} value={option.tallyName}>
                      {option.parentName === null
                        ? option.tallyName
                        : `${option.tallyName} — ${option.parentName}`}
                    </option>
                  ))}
                </Select>
              </label>
            </li>
          );
        })}
      </ul>

      {missing.length > 50 && (
        <p className="mt-3 text-xs text-ink-muted">
          {t('sellerErp.moreToMatch', { count: missing.length - 50 })}
        </p>
      )}

      <Button
        variant="primary"
        className="mt-4"
        isLoading={save.isPending}
        disabled={chosenCount === 0}
        onClick={() => {
          save.mutate();
        }}
      >
        {t('sellerErp.saveMappings', { count: chosenCount })}
      </Button>

      {existing.data !== undefined && existing.data.mappings.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          {t('sellerErp.alreadyMatched', { count: existing.data.mappings.length })}
        </p>
      )}
    </Card>
  );
}
