/**
 * The top of My Profile: who this company is, at a glance.
 *
 * Logo, trading and legal name, the partner ID (read-only, with a copy
 * button), the status badges, a completion ring and when the record last
 * changed. The frame's border carries a slow gradient drift - the one piece
 * of ambient motion on the page, and the global reduced-motion rule stops it.
 */
import { useRef, useState } from 'react';
import { Badge, Button, Spinner, type BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { LogisticsProfile } from '@/lib/profile';
import { Tooltip } from './Tooltip';

const STATUS_TONE: Record<LogisticsProfile['identity']['status'], BadgeTone> = {
  ACTIVE: 'success',
  PENDING_ACTIVATION: 'accent',
  SUSPENDED: 'warning',
  DEACTIVATED: 'danger',
};

const VERIFICATION_TONE: Record<LogisticsProfile['identity']['verificationState'], BadgeTone> = {
  VERIFIED: 'success',
  UNVERIFIED: 'neutral',
  REVERIFICATION_REQUIRED: 'warning',
};

function CompletionRing({ percent, label }: { percent: number; label: string }): React.JSX.Element {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(Math.max(percent, 0), 100) / 100);

  return (
    <div className="flex items-center gap-3">
      <svg
        viewBox="0 0 64 64"
        className="h-16 w-16 shrink-0 -rotate-90"
        role="img"
        aria-label={label}
      >
        <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="6" className="stroke-border-subtle" />
        <circle
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="stroke-brand transition-[stroke-dashoffset] duration-700"
        />
        <text
          x="32"
          y="32"
          textAnchor="middle"
          dominantBaseline="central"
          className="rotate-90 fill-ink text-[13px] font-semibold"
          style={{ transformOrigin: '32px 32px' }}
        >
          {`${String(percent)}%`}
        </text>
      </svg>
    </div>
  );
}

export function ProfileHero({
  profile,
  canEdit,
  hasPendingChange,
  onUploadLogo,
  onRemoveLogo,
  logoBusy,
}: {
  profile: LogisticsProfile;
  canEdit: boolean;
  hasPendingChange: boolean;
  onUploadLogo: (file: File) => void;
  onRemoveLogo: () => void;
  logoBusy: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const { identity, completion } = profile;
  const initial = identity.displayName.trim().charAt(0).toUpperCase() || '?';

  const copyId = (): void => {
    void navigator.clipboard
      .writeText(identity.partnerCode)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 1600);
      })
      .catch(() => {
        // Clipboard refused (an insecure origin, a denied permission). The ID
        // is on screen and selectable, so nothing is lost.
      });
  };

  return (
    <section
      aria-labelledby="profile-hero-name"
      className="profile-hero-frame mb-5 rounded-2xl shadow-card"
    >
      <div className="flex flex-col gap-5 rounded-[calc(1rem-1px)] bg-surface px-4 py-5 sm:flex-row sm:items-center sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <div className="relative shrink-0">
            {identity.logoUrl === null ? (
              <span
                aria-hidden="true"
                className="grid h-16 w-16 place-items-center rounded-xl bg-gradient-to-br from-brand to-operational text-2xl font-semibold text-white shadow-lift sm:h-20 sm:w-20"
              >
                {initial}
              </span>
            ) : (
              <img
                src={identity.logoUrl}
                alt={t('profile.hero.logoAlt', { name: identity.displayName })}
                className="h-16 w-16 rounded-xl border border-border-subtle bg-surface object-contain p-1 shadow-lift sm:h-20 sm:w-20"
              />
            )}
            {logoBusy ? (
              <span className="absolute inset-0 grid place-items-center rounded-xl bg-surface/70">
                <Spinner className="h-5 w-5 text-brand" />
              </span>
            ) : null}
          </div>

          <div className="min-w-0">
            <h2 id="profile-hero-name" className="truncate text-title text-ink">
              {identity.displayName}
            </h2>
            <p className="truncate text-sm text-ink-muted">{identity.legalName}</p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink">
                <span className="sr-only">{t('profile.hero.partnerId')}: </span>
                {identity.partnerCode}
              </span>
              <Tooltip label={copied ? t('profile.hero.copied') : t('profile.hero.copyId')}>
                <button
                  type="button"
                  onClick={copyId}
                  aria-label={t('profile.hero.copyId')}
                  className="grid h-8 w-8 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4" aria-hidden="true">
                    <rect x="6.5" y="6.5" width="9" height="10" rx="1.6" />
                    <path d="M13.5 6.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
                  </svg>
                </button>
              </Tooltip>
              <Badge tone={STATUS_TONE[identity.status]} dot>
                {t(`profile.status.${identity.status}`)}
              </Badge>
              <Badge tone={VERIFICATION_TONE[identity.verificationState]} dot>
                {t(`profile.verification.${identity.verificationState}`)}
              </Badge>
              {hasPendingChange ? (
                <Badge tone="warning">{t('profile.hero.pendingReview')}</Badge>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 sm:flex-nowrap">
          <div className="flex items-center gap-3">
            <CompletionRing
              percent={completion.percent}
              label={t('profile.hero.completionLabel', { percent: completion.percent })}
            />
            <div className="text-xs text-ink-muted">
              <p className="font-semibold text-ink">{t('profile.hero.completion')}</p>
              <p>
                {completion.missing.length === 0
                  ? t('profile.hero.complete')
                  : t('profile.hero.missing', { missing: String(completion.missing.length) })}
              </p>
              <p className="mt-1" title={formatDateTime(identity.updatedAt)}>
                {t('profile.hero.updated', { when: formatRelative(identity.updatedAt) })}
              </p>
            </div>
          </div>

          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) onUploadLogo(file);
                  event.target.value = '';
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={logoBusy}
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                {identity.logoUrl === null ? t('profile.hero.addLogo') : t('profile.hero.changeLogo')}
              </Button>
              {identity.logoUrl === null ? null : (
                <Button size="sm" variant="ghost" disabled={logoBusy} onClick={onRemoveLogo}>
                  {t('profile.hero.removeLogo')}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
