/**
 * Open a qualification case for a seller who already trades in a category a
 * rule now covers - the backfill review. Asking twice returns the same case,
 * so a second press is harmless; the server says which happened.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MutationError } from '@/components/console';
import { Modal } from '@/components/Modal';
import { Button, Field, Select, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, openCase } from '@/lib/console-api';
import { SUPPLY_ROLES, type BackfillRow, type SupplyRole } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { useConsoleMutation } from '@/lib/use-console-mutation';

export function OpenCaseDialog({ row, onClose }: { row: BackfillRow; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [supplyRole, setSupplyRole] = useState<SupplyRole>('DISTRIBUTOR');
  const [message, setMessage] = useState('');

  const mutation = useConsoleMutation({
    mutationFn: (_: undefined, key) =>
      openCase(
        {
          sellerAccountId: row.sellerAccountId,
          level: 'SELLER_CATEGORY',
          categoryId: row.categoryId,
          supplyRole,
          message: message.trim() === '' ? null : message.trim(),
        },
        key,
      ),
    invalidate: [consoleKeys.sellersAll(), consoleKeys.casesAll(), consoleKeys.seller(row.sellerAccountId)],
    successMessage: (result) => (result.created ? t('sellers.backfill.opened') : t('sellers.backfill.alreadyOpen')),
    onSuccess: (result) => {
      onClose();
      void navigate(`/cases/${result.id}`);
    },
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('sellers.backfill.dialogTitle')}
      description={t('sellers.backfill.dialogBody', { seller: row.sellerName, category: row.categoryName })}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate(undefined);
            }}
          >
            {t('sellers.backfill.openCase')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('sellers.backfill.supplyRole')} hint={t('sellers.backfill.supplyRoleHint')} required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={supplyRole}
              onChange={(event) => {
                setSupplyRole(event.target.value as SupplyRole);
              }}
            >
              {SUPPLY_ROLES.map((role) => (
                <option key={role} value={role}>
                  {enumLabel(t, 'supplyRole', role)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('sellers.backfill.message')} hint={t('sellers.backfill.messageHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              value={message}
              maxLength={2000}
              onChange={(event) => {
                setMessage(event.target.value);
              }}
            />
          )}
        </Field>
        {mutation.isError && <MutationError error={mutation.error} />}
      </div>
    </Modal>
  );
}
