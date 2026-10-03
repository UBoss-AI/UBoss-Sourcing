/**
 * Upload a CSV or Excel SKU list to fill the cart (ENH-016). The server reads
 * it and reports every row it could not use; nothing is added until the buyer
 * presses Add, and then all lines go in one all-or-nothing request.
 */
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

interface UploadPreview {
  lines: { row: number; sku: string; productId: string; variantId: string | null; name: string; quantity: number }[];
  problems: { row: number; sku: string | null; code: 'SKU_MISSING' | 'QUANTITY_INVALID' | 'SKU_UNKNOWN' | 'DUPLICATE_SKU' | 'TOO_MANY_LINES' }[];
}

const MAX_BYTES = 1_000_000;

function toBase64(bytes: ArrayBuffer): string {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** FileReader rather than File.arrayBuffer, which older browsers and jsdom lack. */
function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('read failed'));
    };
    reader.readAsArrayBuffer(file);
  });
}

export function CartUploadPanel(): React.JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const read = useMutation({
    mutationFn: async (file: File) =>
      api.post<UploadPreview>('/cart/items/upload/preview', { fileName: file.name, contentBase64: toBase64(await readFile(file)) }),
    onSuccess: (data) => {
      setPreview(data);
    },
  });
  const add = useMutation({
    mutationFn: (lines: UploadPreview['lines']) =>
      api.post('/cart/items/bulk', { items: lines.map((line) => ({ productId: line.productId, variantId: line.variantId, quantity: line.quantity })) }),
    onSuccess: () => {
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
  });
  const failure = read.error ?? add.error;
  return (
    <details className="my-3 rounded-lg border border-border-subtle p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t('cartUpload.title')}</summary>
      <p className="mt-2 text-ink-muted">{t('cartUpload.hint')}</p>
      <label htmlFor={`${id}-file`} className="mt-2 block font-medium">{t('cartUpload.choose')}</label>
      <input
        id={`${id}-file`}
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="mt-1 block"
        onChange={(event) => {
          const file = event.target.files?.[0];
          setPreview(null);
          setLocalError(null);
          if (file === undefined) return;
          if (file.size > MAX_BYTES) {
            setLocalError(t('cartUpload.tooLarge'));
            return;
          }
          read.mutate(file);
        }}
      />
      {read.isPending ? <p role="status" className="mt-2">{t('cartUpload.reading')}</p> : null}
      {localError !== null || failure !== null ? (
        <p role="alert" className="mt-2 text-danger">{localError ?? errorMessage(t, failure)}</p>
      ) : null}
      {preview === null ? null : (
        <div className="mt-3 space-y-2">
          {preview.lines.length === 0 ? (
            <p role="status">{t('cartUpload.noLines')}</p>
          ) : (
            <ul className="space-y-1">
              {preview.lines.map((line) => (
                <li key={line.row}>{t('cartUpload.line', { name: line.name, sku: line.sku, quantity: String(line.quantity) })}</li>
              ))}
            </ul>
          )}
          {preview.problems.length === 0 ? null : (
            <ul className="space-y-1 text-warning">
              {preview.problems.map((problem) => (
                <li key={problem.row}>{t('cartUpload.problem', { row: String(problem.row), reason: t(`cartUpload.code.${problem.code}`) })}</li>
              ))}
            </ul>
          )}
          {preview.lines.length === 0 ? null : (
            <Button
              variant="primary"
              disabled={add.isPending}
              onClick={() => {
                add.mutate(preview.lines);
              }}
            >
              {t('cartUpload.add', { lines: String(preview.lines.length) })}
            </Button>
          )}
        </div>
      )}
    </details>
  );
}
