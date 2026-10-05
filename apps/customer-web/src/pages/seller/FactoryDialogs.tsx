/**
 * The dialogs behind Seller Hub -> Factories (checklist Master row 13): a
 * factory's details, its machines, a piece of evidence, and a certificate.
 *
 * Each checks what it can before sending - required fields, whole numbers,
 * coordinates in range and in pairs - and shows the server's refusal inside
 * the dialog when there is one, so the seller fixes it where they typed it.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { countryOptions } from '@/lib/iso-countries';
import { errorMessage } from '@/lib/errors';
import {
  addEvidence,
  createCertification,
  createFactory,
  saveMachines,
  updateCertification,
  updateFactory,
  uploadEvidenceFile,
  type Certification,
  type Factory,
  type FactoryInput,
} from '@/lib/factories';
import { fetchSellerDocuments } from '@/lib/seller';
import { CERTIFICATIONS_KEY, FACTORIES_KEY } from './factory-query-keys';

type Errors = Record<string, TranslationKey>;

const blankToNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** A whole number of zero or more, or nothing. Undefined means "not a valid number". */
function wholeNumber(value: string): number | null | undefined {
  if (value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** A decimal coordinate in range, or nothing. Undefined means invalid. */
function coordinate(value: string, limit: number): number | null | undefined {
  if (value.trim() === '') return null;
  const parsed = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return undefined;
  return parsed;
}

function ProblemLine({ problem }: { problem: string | null }): React.JSX.Element | null {
  if (problem === null) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
      {problem}
    </p>
  );
}

// ---------------------------------------------------------------------------
// A factory's details
// ---------------------------------------------------------------------------

const TEXT_FIELDS = [
  'name',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postcode',
  'countryCode',
  'latitude',
  'longitude',
  'establishedYear',
  'floorAreaSqm',
  'workforceCount',
  'qcStaffCount',
  'monthlyCapacity',
  'capacityUnit',
  'productsMade',
  'qcProcess',
] as const;
type FactoryField = (typeof TEXT_FIELDS)[number];
type FactoryForm = Record<FactoryField, string>;

function formFrom(factory: Factory | null): FactoryForm {
  const form = {} as FactoryForm;
  for (const field of TEXT_FIELDS) {
    const value = factory === null ? null : factory[field];
    form[field] = value === null ? '' : String(value);
  }
  if (factory === null) form.countryCode = '';
  return form;
}

function parseFactory(form: FactoryForm): { input: FactoryInput | null; errors: Errors } {
  const errors: Errors = {};
  for (const field of ['name', 'addressLine1', 'city', 'postcode', 'countryCode'] as const) {
    if (form[field].trim() === '') errors[field] = 'seller.factories.form.required';
  }
  const latitude = coordinate(form.latitude, 90);
  const longitude = coordinate(form.longitude, 180);
  if (latitude === undefined) errors['latitude'] = 'seller.factories.form.latitudeInvalid';
  if (longitude === undefined) errors['longitude'] = 'seller.factories.form.longitudeInvalid';
  if (latitude !== undefined && longitude !== undefined && (latitude === null) !== (longitude === null)) {
    errors[latitude === null ? 'latitude' : 'longitude'] = 'seller.factories.form.coordinatePair';
  }
  const numbers: Partial<Record<FactoryField, number | null>> = {};
  for (const field of ['establishedYear', 'floorAreaSqm', 'workforceCount', 'qcStaffCount', 'monthlyCapacity'] as const) {
    const parsed = wholeNumber(form[field]);
    if (parsed === undefined) errors[field] = 'seller.factories.form.wholeNumber';
    else numbers[field] = parsed;
  }
  const year = numbers.establishedYear;
  if (typeof year === 'number' && (year < 1800 || year > new Date().getFullYear())) {
    errors['establishedYear'] = 'seller.factories.form.yearInvalid';
  }
  if (
    typeof numbers.workforceCount === 'number' &&
    typeof numbers.qcStaffCount === 'number' &&
    numbers.qcStaffCount > numbers.workforceCount
  ) {
    errors['qcStaffCount'] = 'seller.factories.form.qcAboveWorkforce';
  }
  if (typeof numbers.monthlyCapacity === 'number' && numbers.monthlyCapacity > 0 && form.capacityUnit.trim() === '') {
    errors['capacityUnit'] = 'seller.factories.form.unitRequired';
  }
  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    errors,
    input: {
      name: form.name.trim(),
      addressLine1: form.addressLine1.trim(),
      addressLine2: blankToNull(form.addressLine2),
      city: form.city.trim(),
      region: blankToNull(form.region),
      postcode: form.postcode.trim(),
      countryCode: form.countryCode,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      establishedYear: numbers.establishedYear ?? null,
      floorAreaSqm: numbers.floorAreaSqm ?? null,
      workforceCount: numbers.workforceCount ?? null,
      qcStaffCount: numbers.qcStaffCount ?? null,
      monthlyCapacity: numbers.monthlyCapacity ?? null,
      capacityUnit: blankToNull(form.capacityUnit),
      productsMade: blankToNull(form.productsMade),
      qcProcess: blankToNull(form.qcProcess),
    },
  };
}

export function FactoryDialog({ factory, onClose }: { factory: Factory | null; onClose: () => void }): React.JSX.Element {
  const { t, language } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [form, setForm] = useState<FactoryForm>(() => formFrom(factory));
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: FactoryInput) => (factory === null ? createFactory(input) : updateFactory(factory.id, input)),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: FACTORIES_KEY });
      const backToReview = factory?.verification.status === 'VERIFIED' && result.factory.verification.status === 'PENDING';
      toast.success(t(backToReview ? 'seller.factories.savedBackToReview' : 'seller.factories.saved'));
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });

  const set = (field: FactoryField) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const text = (field: FactoryField, labelKey: TranslationKey, options: { required?: boolean; hintKey?: TranslationKey; inputMode?: 'numeric' | 'decimal' } = {}) => (
    <Field
      label={t(labelKey)}
      required={options.required === true}
      {...(options.hintKey === undefined ? {} : { hint: t(options.hintKey) })}
      error={errors[field] === undefined ? undefined : t(errors[field])}
    >
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          invalid={errors[field] !== undefined}
          value={form[field]}
          inputMode={options.inputMode}
          onChange={set(field)}
        />
      )}
    </Field>
  );

  return (
    <Modal
      isOpen
      size="lg"
      title={t(factory === null ? 'seller.factories.addTitle' : 'seller.factories.editTitle')}
      {...(factory?.verification.status === 'VERIFIED' ? { description: t('seller.factories.editVerifiedWarning') } : {})}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            onClick={() => {
              const parsed = parseFactory(form);
              setErrors(parsed.errors);
              setProblem(null);
              if (parsed.input !== null) save.mutate(parsed.input);
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">{text('name', 'seller.factories.form.name', { required: true })}</div>
        <div className="sm:col-span-2">{text('addressLine1', 'seller.factories.form.addressLine1', { required: true })}</div>
        <div className="sm:col-span-2">{text('addressLine2', 'seller.factories.form.addressLine2')}</div>
        {text('city', 'seller.factories.form.city', { required: true })}
        {text('region', 'seller.factories.form.region')}
        {text('postcode', 'seller.factories.form.postcode', { required: true })}
        <Field
          label={t('seller.factories.form.country')}
          required
          error={errors['countryCode'] === undefined ? undefined : t(errors['countryCode'])}
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['countryCode'] !== undefined}
              value={form.countryCode}
              onChange={set('countryCode')}
            >
              <option value="">{t('seller.factories.form.chooseCountry')}</option>
              {countryOptions(language).map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {text('latitude', 'seller.factories.form.latitude', { hintKey: 'seller.factories.form.coordinatesHint', inputMode: 'decimal' })}
        {text('longitude', 'seller.factories.form.longitude', { inputMode: 'decimal' })}
        {text('establishedYear', 'seller.factories.form.establishedYear', { inputMode: 'numeric' })}
        {text('floorAreaSqm', 'seller.factories.form.floorArea', { inputMode: 'numeric' })}
        {text('workforceCount', 'seller.factories.form.workforce', { inputMode: 'numeric' })}
        {text('qcStaffCount', 'seller.factories.form.qcStaff', { inputMode: 'numeric' })}
        {text('monthlyCapacity', 'seller.factories.form.monthlyCapacity', { inputMode: 'numeric' })}
        {text('capacityUnit', 'seller.factories.form.capacityUnit', { hintKey: 'seller.factories.form.capacityUnitHint' })}
        <div className="sm:col-span-2">
          <Field label={t('seller.factories.form.productsMade')} hint={t('seller.factories.form.productsMadeHint')}>
            {({ inputId, describedBy }) => (
              <Textarea id={inputId} aria-describedby={describedBy} value={form.productsMade} maxLength={4000} onChange={set('productsMade')} />
            )}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={t('seller.factories.form.qcProcess')}>
            {({ inputId, describedBy }) => (
              <Textarea id={inputId} aria-describedby={describedBy} value={form.qcProcess} maxLength={4000} onChange={set('qcProcess')} />
            )}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <ProblemLine problem={problem} />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

interface MachineRow {
  key: string;
  name: string;
  quantity: string;
  capacityNote: string;
}

let rowCounter = 0;
const nextKey = (): string => {
  rowCounter += 1;
  return `row-${String(rowCounter)}`;
};

export function MachinesDialog({ factory, onClose }: { factory: Factory; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [rows, setRows] = useState<MachineRow[]>(() =>
    factory.machines.map((machine) => ({
      key: nextKey(),
      name: machine.name,
      quantity: String(machine.quantity),
      capacityNote: machine.capacityNote ?? '',
    })),
  );
  const [invalid, setInvalid] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (machines: { name: string; quantity: number; capacityNote: string | null }[]) => saveMachines(factory.id, machines),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: FACTORIES_KEY });
      const backToReview = factory.verification.status === 'VERIFIED' && result.factory.verification.status === 'PENDING';
      toast.success(t(backToReview ? 'seller.factories.savedBackToReview' : 'seller.factories.saved'));
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });

  const update = (key: string, patch: Partial<MachineRow>): void => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  return (
    <Modal
      isOpen
      size="lg"
      title={t('seller.factories.machinesTitle', { name: factory.name })}
      {...(factory.verification.status === 'VERIFIED' ? { description: t('seller.factories.editVerifiedWarning') } : {})}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            onClick={() => {
              const kept = rows.filter((row) => row.name.trim() !== '' || row.quantity.trim() !== '');
              const bad = kept.some((row) => row.name.trim() === '' || !/^[1-9]\d*$/.test(row.quantity.trim()));
              setInvalid(bad);
              setProblem(null);
              if (!bad) {
                save.mutate(
                  kept.map((row) => ({ name: row.name.trim(), quantity: Number(row.quantity.trim()), capacityNote: blankToNull(row.capacityNote) })),
                );
              }
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {rows.length === 0 && <p className="text-sm text-ink-muted">{t('seller.factories.noMachines')}</p>}
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li key={row.key} className="grid grid-cols-1 gap-2 rounded-md border border-border-subtle p-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end">
              <Field label={t('seller.factories.machineName')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={row.name}
                    maxLength={160}
                    onChange={(event) => {
                      update(row.key, { name: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('seller.factories.machineQuantity')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    value={row.quantity}
                    onChange={(event) => {
                      update(row.key, { quantity: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('seller.factories.machineCapacity')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={row.capacityNote}
                    maxLength={255}
                    onChange={(event) => {
                      update(row.key, { capacityNote: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Button
                variant="ghost"
                aria-label={t('seller.factories.removeMachine', { position: String(index + 1) })}
                onClick={() => {
                  setRows((previous) => previous.filter((entry) => entry.key !== row.key));
                }}
              >
                {t('common.remove')}
              </Button>
            </li>
          ))}
        </ul>
        <Button
          onClick={() => {
            setRows((previous) => [...previous, { key: nextKey(), name: '', quantity: '1', capacityNote: '' }]);
          }}
        >
          {t('seller.factories.addMachine')}
        </Button>
        {invalid && (
          <p role="alert" className="text-sm text-danger">
            {t('seller.factories.machinesInvalid')}
          </p>
        )}
        <ProblemLine problem={problem} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Choosing or uploading a document
// ---------------------------------------------------------------------------

function DocumentChooser({
  value,
  onChange,
  file,
  onFile,
}: {
  value: string;
  onChange: (documentId: string) => void;
  file: File | null;
  onFile: (file: File | null) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const documents = useQuery({ queryKey: ['seller', 'documents'], queryFn: fetchSellerDocuments });
  const usable = (documents.data?.documents ?? []).filter(
    (document) => document.scanState !== 'INFECTED' && document.scanState !== 'SCAN_FAILED',
  );

  return (
    <div className="space-y-3">
      <Field label={t('seller.factories.chooseDocument')} hint={t('seller.factories.chooseDocumentHint')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={value}
            disabled={file !== null}
            onChange={(event) => {
              onChange(event.currentTarget.value);
            }}
          >
            <option value="">{documents.isPending ? t('common.loading') : t('seller.factories.noDocumentChosen')}</option>
            {usable.map((document) => (
              <option key={document.id} value={document.id}>
                {document.originalFileName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('seller.factories.uploadDocument')} hint={t('seller.factories.uploadDocumentHint')}>
        {({ inputId, describedBy }) => (
          <input
            id={inputId}
            aria-describedby={describedBy}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-surface-sunken file:px-3 file:py-2 file:text-sm file:text-ink"
            onChange={(event) => {
              onFile(event.currentTarget.files?.[0] ?? null);
            }}
          />
        )}
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function EvidenceDialog({ factory, onClose }: { factory: Factory; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [documentId, setDocumentId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (input: { capturedLatitude: number | null; capturedLongitude: number | null }) => {
      const id = file === null ? documentId : (await uploadEvidenceFile(file, 'factory')).id;
      return addEvidence(factory.id, { documentId: id, caption: blankToNull(caption), ...input });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: FACTORIES_KEY }),
        client.invalidateQueries({ queryKey: ['seller', 'documents'] }),
      ]);
      toast.success(t('seller.factories.evidenceAdded'));
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });

  return (
    <Modal
      isOpen
      title={t('seller.factories.evidenceTitle', { name: factory.name })}
      description={t('seller.factories.evidenceIntro')}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            onClick={() => {
              setProblem(null);
              const lat = coordinate(latitude, 90);
              const long = coordinate(longitude, 180);
              if (file === null && documentId === '') {
                setProblem(t('seller.factories.documentRequired'));
                return;
              }
              if (lat === undefined || long === undefined || (lat === null) !== (long === null)) {
                setProblem(t('seller.factories.form.coordinatePair'));
                return;
              }
              save.mutate({ capturedLatitude: lat, capturedLongitude: long });
            }}
          >
            {t('seller.factories.attach')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <DocumentChooser value={documentId} onChange={setDocumentId} file={file} onFile={setFile} />
        <Field label={t('seller.factories.caption')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              value={caption}
              maxLength={255}
              onChange={(event) => {
                setCaption(event.currentTarget.value);
              }}
            />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('seller.factories.capturedLatitude')} hint={t('seller.factories.capturedHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={latitude}
                onChange={(event) => {
                  setLatitude(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field label={t('seller.factories.capturedLongitude')}>
            {({ inputId }) => (
              <Input
                id={inputId}
                inputMode="decimal"
                value={longitude}
                onChange={(event) => {
                  setLongitude(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        </div>
        <ProblemLine problem={problem} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// A certificate
// ---------------------------------------------------------------------------

export function CertificationDialog({
  certification,
  factories,
  onClose,
}: {
  certification: Certification | null;
  factories: Factory[];
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [form, setForm] = useState({
    standard: certification?.standard ?? '',
    certificateNumber: certification?.certificateNumber ?? '',
    issuer: certification?.issuer ?? '',
    scope: certification?.scope ?? '',
    issuedOn: certification?.issuedOn ?? '',
    expiresOn: certification?.expiresOn ?? '',
    factoryId: certification?.factoryId ?? '',
  });
  const [documentId, setDocumentId] = useState(certification?.documentId ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const proof = file === null ? documentId : (await uploadEvidenceFile(file, 'certificate')).id;
      const input = {
        standard: form.standard.trim(),
        certificateNumber: blankToNull(form.certificateNumber),
        issuer: form.issuer.trim(),
        scope: blankToNull(form.scope),
        issuedOn: blankToNull(form.issuedOn),
        expiresOn: blankToNull(form.expiresOn),
        documentId: proof,
        factoryId: blankToNull(form.factoryId),
      };
      return certification === null ? createCertification(input) : updateCertification(certification.id, input);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: CERTIFICATIONS_KEY }),
        client.invalidateQueries({ queryKey: ['seller', 'documents'] }),
      ]);
      toast.success(t('seller.factories.certificateSaved'));
      onClose();
    },
    onError: (error: unknown) => {
      setProblem(errorMessage(t, error, t('seller.factories.saveFailed')));
    },
  });

  const set = (field: keyof typeof form) => (event: { currentTarget: { value: string } }) => {
    const value = event.currentTarget.value;
    setForm((previous) => ({ ...previous, [field]: value }));
  };

  const input = (field: 'standard' | 'certificateNumber' | 'issuer' | 'issuedOn' | 'expiresOn', labelKey: TranslationKey, type = 'text', required = false) => (
    <Field label={t(labelKey)} required={required} error={errors[field] === undefined ? undefined : t(errors[field])}>
      {({ inputId, describedBy }) => (
        <Input id={inputId} aria-describedby={describedBy} type={type} invalid={errors[field] !== undefined} value={form[field]} onChange={set(field)} />
      )}
    </Field>
  );

  return (
    <Modal
      isOpen
      size="lg"
      title={t(certification === null ? 'seller.factories.addCertificateTitle' : 'seller.factories.editCertificateTitle')}
      description={t(certification?.state === 'VERIFIED' ? 'seller.factories.editVerifiedCertificateWarning' : 'seller.factories.certificateIntro')}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={save.isPending}
            onClick={() => {
              const found: Errors = {};
              if (form.standard.trim() === '') found['standard'] = 'seller.factories.form.required';
              if (form.issuer.trim() === '') found['issuer'] = 'seller.factories.form.required';
              if (form.issuedOn !== '' && form.expiresOn !== '' && form.expiresOn < form.issuedOn) {
                found['expiresOn'] = 'seller.factories.expiresBeforeIssued';
              }
              setErrors(found);
              setProblem(null);
              if (file === null && documentId === '') {
                setProblem(t('seller.factories.documentRequired'));
                return;
              }
              if (Object.keys(found).length === 0) save.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {input('standard', 'seller.factories.standard', 'text', true)}
        {input('certificateNumber', 'seller.factories.certificateNumber')}
        {input('issuer', 'seller.factories.issuer', 'text', true)}
        <Field label={t('seller.factories.coversFactory')}>
          {({ inputId }) => (
            <Select id={inputId} value={form.factoryId} onChange={set('factoryId')}>
              <option value="">{t('seller.factories.wholeBusiness')}</option>
              {factories.map((factory) => (
                <option key={factory.id} value={factory.id}>
                  {factory.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {input('issuedOn', 'seller.factories.issuedOn', 'date')}
        {input('expiresOn', 'seller.factories.expiresOn', 'date')}
        <div className="sm:col-span-2">
          <Field label={t('seller.factories.scope')}>
            {({ inputId }) => <Textarea id={inputId} value={form.scope} maxLength={4000} onChange={set('scope')} />}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <DocumentChooser value={documentId} onChange={setDocumentId} file={file} onFile={setFile} />
        </div>
        <div className="sm:col-span-2">
          <ProblemLine problem={problem} />
        </div>
      </div>
    </Modal>
  );
}
