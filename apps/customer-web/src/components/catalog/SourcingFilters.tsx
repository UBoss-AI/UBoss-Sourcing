/**
 * B2B sourcing filters on search and category results (checklist JOURNEY-002).
 *
 * Minimum order, country of origin, bulk lead time, verified certificate,
 * verified supplier, samples and Incoterm. Every one is a URL parameter with
 * the API's own name, so a filtered result is a link somebody can share and a
 * bookmark keeps working. Each narrows to products an approved supplier sells
 * on those terms; products sold only from the marketplace's own stock carry no
 * seller terms and drop out while one is on, which the hint says.
 */
import { useI18n } from '@/i18n/i18n-context';
import { Field, Select } from '@/components/ui';
import { countryOptions } from '@/lib/iso-countries';
import type { SourcingParam } from '@/lib/sourcing-filters';


const MOQ_OPTIONS = [10, 50, 100, 500, 1000, 5000];
const LEAD_TIME_OPTIONS = [7, 15, 30, 45, 60, 90];
const INCOTERM_OPTIONS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

type SetParam = (updates: Record<string, string | string[] | null>) => void;

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint: string }): React.JSX.Element {
  return (
    <label className="-mx-2 flex cursor-pointer items-start gap-2.5 rounded-md p-2 text-sm text-ink transition-colors hover:bg-surface-hover">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-brand"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{hint}</span>
      </span>
    </label>
  );
}

export function SourcingFilterPanel({ searchParams, setParam }: { searchParams: URLSearchParams; setParam: SetParam }): React.JSX.Element {
  const { t, language } = useI18n();
  const value = (key: SourcingParam): string => searchParams.get(key) ?? '';
  const flag = (key: SourcingParam): boolean => searchParams.get(key) === 'true';

  return (
    <div className="pt-4">
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('catalog.sourcing.heading')}</p>
      <p className="mt-1 text-xs text-ink-muted">{t('catalog.sourcing.hint')}</p>
      <div className="mt-2.5">
        <Toggle
          checked={flag('verifiedSupplier')}
          onChange={(on) => {
            setParam({ verifiedSupplier: on ? 'true' : null });
          }}
          label={t('catalog.sourcing.verifiedSupplier')}
          hint={t('catalog.sourcing.verifiedSupplierHint')}
        />
        <Toggle
          checked={flag('certified')}
          onChange={(on) => {
            setParam({ certified: on ? 'true' : null });
          }}
          label={t('catalog.sourcing.certified')}
          hint={t('catalog.sourcing.certifiedHint')}
        />
        <Toggle
          checked={flag('sample')}
          onChange={(on) => {
            setParam({ sample: on ? 'true' : null });
          }}
          label={t('catalog.sourcing.sample')}
          hint={t('catalog.sourcing.sampleHint')}
        />
      </div>
      <div className="mt-3 grid gap-3">
        <Field label={t('catalog.sourcing.maxMoq')}>
          {({ inputId }) => (
            <Select id={inputId} value={value('maxMoq')} onChange={(event) => { setParam({ maxMoq: event.target.value || null }); }}>
              <option value="">{t('catalog.sourcing.any')}</option>
              {MOQ_OPTIONS.map((units) => (
                <option key={units} value={String(units)}>{t('catalog.sourcing.upToUnits', { units: String(units) })}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('catalog.sourcing.maxLeadTime')}>
          {({ inputId }) => (
            <Select id={inputId} value={value('maxLeadTimeDays')} onChange={(event) => { setParam({ maxLeadTimeDays: event.target.value || null }); }}>
              <option value="">{t('catalog.sourcing.any')}</option>
              {LEAD_TIME_OPTIONS.map((days) => (
                <option key={days} value={String(days)}>{t('catalog.sourcing.withinDays', { days: String(days) })}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('catalog.sourcing.incoterm')}>
          {({ inputId }) => (
            <Select id={inputId} value={value('incoterm')} onChange={(event) => { setParam({ incoterm: event.target.value || null }); }}>
              <option value="">{t('catalog.sourcing.any')}</option>
              {INCOTERM_OPTIONS.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('catalog.sourcing.origin')}>
          {({ inputId }) => (
            <Select id={inputId} value={value('origin')} onChange={(event) => { setParam({ origin: event.target.value || null }); }}>
              <option value="">{t('catalog.sourcing.any')}</option>
              {countryOptions(language).map((country) => (
                <option key={country.code} value={country.code}>{country.name}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </div>
  );
}
