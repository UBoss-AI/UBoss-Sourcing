/**
 * Your addresses.
 *
 * Deleting archives rather than removes: past orders hold their own snapshot
 * of where they went, so nothing here can rewrite delivery history. An
 * archived address simply stops appearing at checkout.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { AddressForm } from '@/components/AddressForm';
import { useToast } from '@/components/toast-context';
import { Badge, Button, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Address } from '@/lib/types';

export function AddressesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { business } = useStorefront();

  const [editing, setEditing] = useState<Address | null | undefined>(undefined);

  useDocumentMeta({ title: 'Addresses', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<{ addresses: Address[] }>('/account/addresses'),
  });

  const archive = useMutation({
    mutationFn: (addressId: string) => api.delete(`/account/addresses/${addressId}`),
    onSuccess: async () => {
      toast.success('Address removed.');
      await queryClient.invalidateQueries({ queryKey: ['addresses'] });
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? error.message : 'That address could not be removed.',
      );
    },
  });

  if (query.isPending) return <LoadingState label="Loading your addresses" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const addresses = query.data.addresses.filter((address) => address.archivedAt === null);

  return (
    <>
      <PageHeader
        title="Addresses"
        description="Used at checkout for delivery and billing."
        {...(editing === undefined
          ? {
              actions: (
                <Button
                  variant="primary"
                  onClick={() => {
                    setEditing(null);
                  }}
                >
                  Add an address
                </Button>
              ),
            }
          : {})}
      />

      {editing !== undefined && (
        <div className="mb-6 rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 className="mb-4 text-title-sm text-ink">
            {editing === null ? 'New address' : 'Edit address'}
          </h2>
          <AddressForm
            {...(editing === null ? {} : { existing: editing })}
            onSaved={() => {
              setEditing(undefined);
              toast.success('Address saved.');
            }}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </div>
      )}

      {addresses.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface shadow-card">
          <EmptyState
            title="No addresses saved"
            description="Add one here, or at checkout when you place your first order."
          />
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {addresses.map((address) => (
            <li key={address.id} className="rounded-lg border border-border bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  {address.label !== null && (
                    <p className="text-title-xs text-ink">{address.label}</p>
                  )}
                  <p className="text-sm text-ink">{address.contactName}</p>
                </div>

                <div className="flex flex-wrap gap-1">
                  {address.isDefaultShipping && <Badge tone="brand">Default delivery</Badge>}
                  {address.isDefaultBilling && <Badge tone="brand">Default billing</Badge>}
                </div>
              </div>

              <address className="mt-2 text-sm not-italic text-ink-muted">
                {address.line1}
                {address.line2 !== null && `, ${address.line2}`}
                <br />
                {address.city}, {address.state} {address.postalCode}
                <br />
                {address.country}
                <span className="mt-1 block">{address.contactPhone}</span>
              </address>

              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(address);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isLoading={archive.isPending}
                  onClick={() => {
                    archive.mutate(address.id);
                  }}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs text-ink-muted">
        Removing an address does not change any order already placed — each order keeps its own
        copy of where it was sent.
      </p>
    </>
  );
}
