/**
 * Components every commercial-policy screen shares: status badges, code lists,
 * the refusal list a server error carries, tabs and a one-field action
 * dialog. Kept here so the five screens read the same way.
 */
import { useState, type ReactNode } from 'react';
import { Modal } from '@/components/Modal';
import { Badge, Button, Callout, Field, Input, Select, Textarea, type BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { codeLabel, statusLabel } from './format';
import { ApiError } from '@/lib/api';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';

const STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'accent',
  ACTIVE: 'success',
  RETIRED: 'neutral',
  ENABLED: 'success',
  DISABLED: 'neutral',
  VERIFIED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
  FAILED: 'danger',
  IN_REVIEW: 'warning',
  PROPOSED: 'warning',
  APPLIED: 'success',
};

export function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} dot>
      {statusLabel(t, status)}
    </Badge>
  );
}

/** The server's message, then every refusal code in its details, as a list. */
export function RefusalCallout({ error }: { error: unknown }): React.JSX.Element | null {
  const { t } = useI18n();
  if (error === null || error === undefined) return null;
  // Each detail names WHAT is refused (field, e.g. a launch decision) and WHY (code).
  const items = error instanceof ApiError ? error.details.filter((d): d is typeof d & { code: string } => typeof d.code === 'string') : [];
  return (
    <Callout tone="danger" title={t('commercial.refused')} role="alert">
      <p>{errorMessage(t, error)}</p>
      {items.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {items.map((item, index) => (
            <li key={`${item.field ?? ''}:${item.code}:${String(index)}`}>
              {typeof item.field === 'string' && item.field !== '' ? `${codeLabel(t, item.field)}: ${codeLabel(t, item.code)}` : codeLabel(t, item.code)}
            </li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

/** A plain list of codes, in words. */
export function CodeList({ codes, empty }: { codes: string[]; empty: string }): React.JSX.Element {
  const { t } = useI18n();
  if (codes.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink">
      {codes.map((code) => (
        <li key={code}>{codeLabel(t, code)}</li>
      ))}
    </ul>
  );
}

export function Tabs<K extends string>({ label, tabs, value, onChange }: { label: string; tabs: { key: K; label: string }[]; value: K; onChange: (key: K) => void }): React.JSX.Element {
  return (
    <div role="tablist" aria-label={label} className="mb-4 flex flex-wrap gap-1 rounded-md border border-border bg-surface-sunken p-1">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => {
            onChange(tab.key);
          }}
          className={cx('rounded px-3 py-1.5 text-sm font-medium transition-colors', value === tab.key ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink')}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TextField({ label, value, onChange, hint, type = 'text', required }: { label: string; value: string; onChange: (value: string) => void; hint?: string; type?: string; required?: boolean }): React.JSX.Element {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })} {...(required === undefined ? {} : { required })}>
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          type={type}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

export function AreaField({ label, value, onChange, hint, rows = 3, required }: { label: string; value: string; onChange: (value: string) => void; hint?: string; rows?: number; required?: boolean }): React.JSX.Element {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })} {...(required === undefined ? {} : { required })}>
      {({ inputId, describedBy }) => (
        <Textarea
          id={inputId}
          aria-describedby={describedBy}
          rows={rows}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}

/**
 * One text answer, then a call. Used for evidence, notes and references,
 * which the server requires and checks for length.
 */
export function TextActionDialog({
  title,
  description,
  label,
  minLength,
  confirmLabel,
  onClose,
  onSubmit,
  isDangerous = false,
  children,
}: {
  title: string;
  description?: string | undefined;
  label: string;
  minLength: number;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (text: string) => Promise<unknown>;
  isDangerous?: boolean;
  children?: ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      {...(description === undefined ? {} : { description })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={isDangerous ? 'danger' : 'primary'}
            isLoading={busy}
            disabled={text.trim().length < minLength}
            onClick={() => {
              void submit();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RefusalCallout error={error} />
        {children}
        <AreaField label={label} value={text} onChange={setText} {...(minLength > 0 ? { hint: t('commercial.minLength', { min: String(minLength) }), required: true } : {})} rows={4} />
      </div>
    </Modal>
  );
}

/** A preformatted block for a JSON body a person must read as written. */
export function JsonBlock({ value }: { value: unknown }): React.JSX.Element {
  return <pre className="max-h-80 overflow-auto rounded-md bg-surface-sunken p-3 text-xxs text-ink">{JSON.stringify(value, null, 2)}</pre>;
}

/** A form dialog whose fields the caller renders; the save call may throw a refusal. */
export function FormDialog({ title, onClose, onSave, canSave, children }: { title: string; onClose: () => void; onSave: () => Promise<unknown>; canSave: boolean; children: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSave();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal isOpen size="lg" onClose={onClose} title={title} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" isLoading={busy} disabled={!canSave} onClick={() => { void save(); }}>{t('common.save')}</Button></>}>
      <div className="space-y-4">
        <RefusalCallout error={error} />
        {children}
      </div>
    </Modal>
  );
}

export function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }): React.JSX.Element {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink">{label}</span>
      <Select className="mt-1.5" value={value} onChange={(event) => { onChange(event.target.value); }}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>
    </label>
  );
}

