/**
 * Choose the files to attach to a ticket: photographs, a screen recording,
 * a PDF.
 *
 * A real `<input type="file">` behind a real label, so the keyboard, a screen
 * reader and a phone's own picker all work as they do everywhere else. The
 * chosen files are listed with their size and a remove button each.
 *
 * Checked here only so nobody waits for an upload that was always going to be
 * refused: the type the browser reports and the size. The server decides the
 * type again from the bytes - a renamed file is caught there - and scans each
 * one before it is stored.
 */
import { useId, useRef, useState } from 'react';
import { CloseIcon, PaperclipIcon } from '@/components/icons';
import { checkSupportFile, formatBytes } from '@/lib/support';
import { useI18n } from '@/i18n/i18n-context';

export interface PickedFile {
  /** Stable across renders, so removing one does not reshuffle the others. */
  key: string;
  file: File;
}

export function SupportFilePicker({
  files,
  onChange,
  rules,
  alreadyAttached = 0,
  disabled = false,
}: {
  files: PickedFile[];
  onChange: (files: PickedFile[]) => void;
  rules: { maxBytes: number; maxFiles: number; types: readonly string[] };
  /** Files the ticket already carries, which count towards the limit. */
  alreadyAttached?: number;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const problemId = `${inputId}-problem`;
  const input = useRef<HTMLInputElement>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const room = Math.max(0, rules.maxFiles - alreadyAttached - files.length);

  function add(list: FileList | null): void {
    if (list === null) return;
    const accepted: PickedFile[] = [];
    const refused: string[] = [];
    for (const file of Array.from(list)) {
      if (accepted.length >= room) {
        refused.push(t('support.files.tooMany', { name: file.name, max: String(rules.maxFiles) }));
        continue;
      }
      const problem = checkSupportFile(file, rules);
      if (problem === 'TYPE') refused.push(t('support.files.wrongType', { name: file.name }));
      else if (problem === 'SIZE') {
        refused.push(
          t('support.files.tooLarge', { name: file.name, max: formatBytes(rules.maxBytes) }),
        );
      } else
        accepted.push({
          key: `${file.name}:${String(file.size)}:${String(file.lastModified)}:${crypto.randomUUID()}`,
          file,
        });
    }
    setProblems(refused);
    onChange([...files, ...accepted]);
    // The same file can be picked again after it is removed.
    if (input.current !== null) input.current.value = '';
  }

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {t('support.files.label')}
      </label>
      <p id={hintId} className="text-xs leading-relaxed text-ink-muted">
        {t('support.files.hint', {
          max: formatBytes(rules.maxBytes),
          files: String(rules.maxFiles),
        })}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* The input itself, visible to assistive technology, drawn as a button. */}
        <label
          className={
            'inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-surface px-4 ' +
            'text-sm font-medium text-ink shadow-card hover:border-border-hover hover:bg-surface-hover ' +
            'focus-within:ring-2 focus-within:ring-brand ' +
            (disabled || room === 0 ? 'pointer-events-none opacity-60' : '')
          }
        >
          <PaperclipIcon className="h-4 w-4" />
          {t('support.files.add')}
          <input
            ref={input}
            id={inputId}
            type="file"
            multiple
            accept={rules.types.join(',')}
            aria-describedby={`${hintId}${problems.length > 0 ? ` ${problemId}` : ''}`}
            disabled={disabled || room === 0}
            className="sr-only"
            onChange={(event) => {
              add(event.currentTarget.files);
            }}
          />
        </label>
        {room === 0 && <span className="text-xs text-ink-muted">{t('support.files.full')}</span>}
      </div>

      {problems.length > 0 && (
        <ul id={problemId} role="alert" className="space-y-1 text-xs font-medium text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul
          className="divide-y divide-border-subtle rounded-md border border-border"
          aria-label={t('support.files.chosen')}
        >
          {files.map((picked) => (
            <li key={picked.key} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink">{picked.file.name}</span>
              <span className="shrink-0 text-xs text-ink-muted">
                {formatBytes(picked.file.size)}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setProblems([]);
                  onChange(files.filter((other) => other.key !== picked.key));
                }}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink"
                aria-label={t('support.files.remove', { name: picked.file.name })}
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
