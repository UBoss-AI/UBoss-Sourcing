/**
 * Pick one of this job's evidence files - for a laboratory report against a
 * checklist line or a sample, or the evidence behind a reclassification.
 *
 * Lists what the server returned for the job and nothing else; an empty list
 * says to upload the file first rather than offering a free-text id.
 */
import { Field, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { EvidenceItem } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDateTime } from '@/lib/format';

export function EvidenceSelect({
  label,
  evidence,
  value,
  onChange,
  required = false,
  hint,
  error,
  filter,
}: {
  label: string;
  evidence: EvidenceItem[];
  value: string;
  onChange: (id: string) => void;
  required?: boolean;
  hint?: string;
  error?: string | undefined;
  /** Narrow the list, e.g. to documents only. */
  filter?: (item: EvidenceItem) => boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const options = filter === undefined ? evidence : evidence.filter(filter);

  return (
    <Field
      label={label}
      required={required}
      {...(hint === undefined ? {} : { hint })}
      error={error}
    >
      {({ inputId, describedBy }) => (
        <Select
          id={inputId}
          aria-describedby={describedBy}
          value={value}
          disabled={options.length === 0}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="">{options.length === 0 ? t('evidenceSelect.noneYet') : t('evidenceSelect.choose')}</option>
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.fileName} · {enumLabel(t, 'evidencePurpose', item.purpose)} · {formatDateTime(item.receivedAt)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
