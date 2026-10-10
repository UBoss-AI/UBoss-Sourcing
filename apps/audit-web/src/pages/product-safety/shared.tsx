/**
 * Small pieces the product evidence and safety case screens share.
 */
import type { ReactNode } from 'react';
import { MutationError } from '@/components/console';
import { Badge, type BadgeTone, Field, Input, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import type { Severity } from '@/lib/product-safety';

/**
 * A refused write. Separation of duties gets its own title, because "you may
 * not do this" reads as a fault unless it says that somebody else must.
 */
export function SafetyMutationError({ error }: { error: unknown }): React.JSX.Element | null {
  const { t } = useI18n();
  if (error instanceof ApiError && error.code === 'SEPARATION_OF_DUTIES_REQUIRED') {
    return <MutationError error={error} title={t('productSafety.separationTitle')} />;
  }
  return <MutationError error={error} />;
}

const SEVERITY_TONE: Record<Severity, BadgeTone> = { CRITICAL: 'danger', HIGH: 'warning', MEDIUM: 'action', LOW: 'neutral' };

export function SeverityBadge({ severity }: { severity: Severity }): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone={SEVERITY_TONE[severity]}>{t(`productSafety.severity.${severity}` as TranslationKey)}</Badge>;
}

export function TextField({
  label,
  value,
  onChange,
  required,
  hint,
  type = 'text',
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: string;
  type?: string;
  multiline?: boolean;
}): React.JSX.Element {
  return (
    <Field label={label} required={required === true} {...(hint === undefined ? {} : { hint })}>
      {({ inputId, describedBy }) =>
        multiline ? (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            required={required}
            rows={3}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        ) : (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            required={required}
            type={type}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        )
      }
    </Field>
  );
}

export function FormGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}
