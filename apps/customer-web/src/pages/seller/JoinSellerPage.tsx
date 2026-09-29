/**
 * Where an invitation to join a seller's team lands (checklist Master row 14).
 *
 * Signed in first - the account route sends a signed-out visitor to sign-in
 * and back here with the link intact. The page asks the server what the
 * invitation is for and shows it: which seller, who asked, the role. Nothing
 * happens until the person presses Accept, because joining a business in a
 * role is a decision, not a side effect of opening an email.
 *
 * The token goes to the server in a request body, and is taken out of the
 * address bar as soon as it is read, so it does not linger in history. After
 * joining, the Seller Hub asks the new member to choose their Hub password.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { Button, ButtonLink, LoadingState, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { acceptSellerInvitation, previewSellerInvitation } from '@/lib/seller';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { AccountPanel } from '@/pages/account/AccountPanel';

export function JoinSellerPage(): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { business } = useStorefront();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  // Read once and kept: the address bar is cleaned below.
  const [token] = useState(() => searchParams.get('token') ?? '');

  useDocumentMeta({ title: t('joinSeller.title'), noIndex: true }, business.displayName);

  const preview = useQuery({
    queryKey: ['seller-invitation', token],
    queryFn: async () => {
      const result = await previewSellerInvitation(token);
      window.history.replaceState(window.history.state, '', window.location.pathname);
      return result;
    },
    enabled: token.length > 0,
    retry: false,
    staleTime: Infinity,
  });

  const accept = useMutation({
    mutationFn: () => acceptSellerInvitation(token),
    onSuccess: async () => {
      // The header asks "does this account sell here?" - it does now.
      await queryClient.invalidateQueries({ queryKey: ['seller'] });
      void navigate('/seller/dashboard', { replace: true });
    },
  });

  const invalid = (message: string): React.JSX.Element => (
    <>
      <PageHeader title={t('joinSeller.title')} />
      <AccountPanel title={t('joinSeller.invalidTitle')}>
        <p role="alert" className="max-w-prose text-sm leading-relaxed text-ink">
          {message}
        </p>
        <div className="mt-5">
          <ButtonLink to="/account">{t('joinSeller.toAccount')}</ButtonLink>
        </div>
      </AccountPanel>
    </>
  );

  if (token.length === 0) return invalid(t('joinSeller.noToken'));
  if (preview.isPending) return <LoadingState label={t('joinSeller.loading')} />;
  if (preview.isError) return invalid(errorMessage(t, preview.error, t('joinSeller.invalidBody')));

  const invitation = preview.data;
  const expires = new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium' }).format(new Date(invitation.expiresAt));

  return (
    <>
      <PageHeader title={t('joinSeller.title')} />
      <AccountPanel title={t('joinSeller.heading', { seller: invitation.sellerName })}>
        <p className="max-w-prose text-sm leading-relaxed text-ink">
          {t('joinSeller.body', {
            inviter: invitation.inviterName,
            seller: invitation.sellerName,
            role: t(`sellerRole.${invitation.role}` as TranslationKey),
          })}
        </p>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">{t('joinSeller.afterwards')}</p>
        <p className="mt-2 text-sm text-ink-muted">{t('joinSeller.expires', { date: expires })}</p>
        {accept.isError && (
          <p role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {errorMessage(t, accept.error, t('joinSeller.invalidBody'))}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            isLoading={accept.isPending}
            onClick={() => {
              accept.mutate();
            }}
          >
            {t('joinSeller.accept')}
          </Button>
          <ButtonLink to="/account" variant="secondary">
            {t('joinSeller.notNow')}
          </ButtonLink>
        </div>
      </AccountPanel>
    </>
  );
}
