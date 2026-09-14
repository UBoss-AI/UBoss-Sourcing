/**
 * Adding one listing.
 *
 * Three steps across the top - category, brand, details - and the third is
 * where almost all of the work is. That shape is taken from the reference
 * workflows and it is right for a reason worth stating: the fields a product
 * needs depend on its category, and the brand decides whether the seller is
 * even allowed to list it, so both have to be settled before the form can be
 * drawn at all.
 *
 * Four things this screen gets from the server and never decides for itself:
 *
 *   - **Which fields to draw.** `schema.attributes`, per category.
 *   - **Which photographs are required.** `schema.mediaSlots`.
 *   - **How complete each section is.** `draft.sections`, recomputed on every
 *     save. The counters here are rendered, not counted.
 *   - **Whether it can be submitted, and what is stopping it.**
 *     `draft.issues`, each carrying the field it belongs to, which is what lets
 *     every refusal sit beside the input that caused it rather than in one
 *     sentence at the top.
 *
 * The draft is created on the server the moment a category is chosen, so
 * closing the tab loses nothing. The URL carries its id, which is what makes
 * "resume later" a link rather than a feature.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  Textarea,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  createDraft,
  fetchBrands,
  fetchDraft,
  previewTitle,
  requestBrand,
  saveDraft,
  sectionLabel,
  submitDraft,
  type BrandSummary,
  type DraftView,
  type ListingSection,
  type SchemaAttribute,
  type SectionSummary,
} from '@/lib/seller';
import type { CategoryNode } from '@/lib/types';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';
import { ListingMediaPanel } from './ListingMediaPanel';

const STEPS = [
  { key: 'category', label: 'Select category' },
  { key: 'brand', label: 'Select brand' },
  { key: 'details', label: 'Add product details' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

export function SellerListingWizardPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();
  const [params, setParams] = useSearchParams();

  const draftId = params.get('draft');

  if (!seller.isTrading) {
    return <ApprovalRequiredNotice seller={seller} />;
  }

  return (
    <WizardBody
      draftId={draftId}
      onDraftCreated={(id) => {
        const next = new URLSearchParams(params);
        next.set('draft', id);
        // `replace`, not `push`: the seller pressed "choose category", not
        // "navigate", and a back button that returns to a draft-less wizard
        // would look like their work had vanished.
        setParams(next, { replace: true });
      }}
    />
  );
}

function WizardBody({
  draftId,
  onDraftCreated,
}: {
  draftId: string | null;
  onDraftCreated: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();

  const draftQuery = useQuery({
    queryKey: ['seller', 'draft', draftId],
    queryFn: () => fetchDraft(draftId ?? ''),
    enabled: draftId !== null,
  });

  const draft = draftQuery.data ?? null;

  /**
   * Which step to show.
   *
   * Derived from the draft rather than held in state, so a reload lands where
   * the seller was. The one piece of state is `manualStep`, which lets them go
   * back to change a category they have already chosen.
   */
  const [manualStep, setManualStep] = useState<StepKey | null>(null);

  const derivedStep: StepKey =
    draft === null || draft.categoryId === null
      ? 'category'
      : draft.brandId === null
        ? 'brand'
        : 'details';

  const step = manualStep ?? derivedStep;

  const createMutation = useMutation({
    mutationFn: (categoryId: string) => createDraft({ categoryId }),
    onSuccess: (created) => {
      onDraftCreated(created.id);
      setManualStep('brand');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That listing could not be started.'));
    },
  });

  const saveMutation = useMutation({
    mutationFn: (patch: Parameters<typeof saveDraft>[1]) => saveDraft(draft?.id ?? '', patch),
    onSuccess: (updated) => {
      client.setQueryData(['seller', 'draft', updated.id], updated);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That change could not be saved.'));
    },
  });

  const submitMutation = useMutation({
    mutationFn: () => submitDraft(draft?.id ?? ''),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'drafts'] });
      toast.success('Sent for quality review. We will let you know the outcome.');
      void navigate('/seller/listings?tab=PENDING_REVIEW');
    },
    onError: (error: unknown) => {
      // The server's message names how many things are wrong; the issues
      // themselves are already on the draft and are rendered beside their
      // fields, so this is a summary rather than the whole explanation.
      toast.error(errorMessage(t, error, 'This listing cannot be sent for review yet.'));
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="text-xxs text-ink-subtle">
            <Link to="/seller/listings" className="hover:text-ink">
              Listings
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Add a listing</span>
          </nav>
          <h1 className="mt-1 text-title-xl text-ink">Add a single listing</h1>
        </div>

        {draft !== null && step === 'details' && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <SaveIndicator mutation={saveMutation} updatedAt={draft.updatedAt} />
            <Link to="/seller/listings">
              <Button>Save and go back</Button>
            </Link>
            <Button
              variant="primary"
              isLoading={submitMutation.isPending}
              disabled={!draft.isSubmittable}
              title={
                draft.isSubmittable
                  ? undefined
                  : 'Fix the highlighted sections before sending this for review'
              }
              onClick={() => {
                submitMutation.mutate();
              }}
            >
              Send for quality review
            </Button>
          </div>
        )}
      </header>

      <Stepper
        current={step}
        draft={draft}
        onGoTo={(target) => {
          setManualStep(target);
        }}
      />

      {draftId !== null && draftQuery.isPending && <LoadingState label="Loading your listing" />}

      {draftQuery.isError && (
        <ErrorState
          error={draftQuery.error}
          onRetry={() => {
            void draftQuery.refetch();
          }}
        />
      )}

      {step === 'category' && (
        <CategoryStep
          isBusy={createMutation.isPending}
          onChoose={(categoryId) => {
            if (draft === null) {
              createMutation.mutate(categoryId);
              return;
            }
            saveMutation.mutate({ categoryId, expectedVersion: draft.version });
            setManualStep('brand');
          }}
        />
      )}

      {step === 'brand' && draft !== null && (
        <BrandStep
          draft={draft}
          onChoose={(brandId) => {
            saveMutation.mutate({ brandId, expectedVersion: draft.version });
            setManualStep('details');
          }}
          onBack={() => {
            setManualStep('category');
          }}
        />
      )}

      {step === 'details' && draft !== null && (
        <DetailsStep
          draft={draft}
          onSave={(patch) => {
            saveMutation.mutate({ ...patch, expectedVersion: draft.version });
          }}
          isSaving={saveMutation.isPending}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stepper
// ---------------------------------------------------------------------------

function Stepper({
  current,
  draft,
  onGoTo,
}: {
  current: StepKey;
  draft: DraftView | null;
  onGoTo: (step: StepKey) => void;
}): React.JSX.Element {
  const currentIndex = STEPS.findIndex((step) => step.key === current);

  const valueFor = (key: StepKey): string | null => {
    if (key === 'category') return draft?.schema?.categoryName ?? null;
    if (key === 'brand') return draft?.brandName ?? null;
    return null;
  };

  return (
    <ol className="flex flex-wrap items-start gap-x-2 gap-y-4">
      {STEPS.map((step, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        // Reachable only backwards. Jumping ahead to "details" before a
        // category exists would render a form with no fields in it, which
        // reads as the page being broken.
        const isReachable = index < currentIndex && draft !== null;
        const value = valueFor(step.key);

        return (
          <li key={step.key} className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cx(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xxs font-semibold',
                    isDone
                      ? 'bg-brand-fill text-white'
                      : isCurrent
                        ? 'bg-brand-soft text-brand ring-2 ring-brand/30'
                        : 'bg-surface-sunken text-ink-subtle',
                  )}
                >
                  {isDone ? '✓' : index + 1}
                </span>

                {isReachable ? (
                  <button
                    type="button"
                    onClick={() => {
                      onGoTo(step.key);
                    }}
                    className="truncate text-sm font-medium text-ink hover:text-brand"
                  >
                    {step.label}
                  </button>
                ) : (
                  <span
                    aria-current={isCurrent ? 'step' : undefined}
                    className={cx(
                      'truncate text-sm font-medium',
                      isCurrent ? 'text-ink' : 'text-ink-subtle',
                    )}
                  >
                    {step.label}
                  </span>
                )}
              </div>

              {/* What was chosen, under the step that chose it. The reference
                  screens do this and it is the right call: three steps with no
                  answers under them is a progress bar, not a summary. */}
              {value !== null && (
                <p className="ml-8 mt-0.5 truncate text-xxs text-ink-muted">{value}</p>
              )}

              <div
                aria-hidden="true"
                className={cx(
                  'ml-8 mt-2 h-0.5 rounded-full',
                  isDone || isCurrent ? 'bg-brand-fill' : 'bg-border',
                )}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Saving, saved, or failed.
 *
 * Autosave with no indicator is autosave a seller does not trust, and the one
 * they do not trust is the one they work around by retyping everything into a
 * document. The failed state is the one that matters: it must be visible and
 * it must not look like "saved".
 */
function SaveIndicator({
  mutation,
  updatedAt,
}: {
  mutation: { isPending: boolean; isError: boolean };
  updatedAt: string;
}): React.JSX.Element {
  if (mutation.isPending) {
    return (
      <span role="status" className="text-xxs text-ink-muted">
        Saving…
      </span>
    );
  }

  if (mutation.isError) {
    return (
      <span role="status" className="text-xxs font-medium text-danger">
        Not saved — try again
      </span>
    );
  }

  return (
    <span className="text-xxs text-ink-subtle">
      Saved {new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Step 1 - the category
// ---------------------------------------------------------------------------

function CategoryStep({
  isBusy,
  onChoose,
}: {
  isBusy: boolean;
  onChoose: (categoryId: string) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
    staleTime: 300_000,
  });

  const tree = useMemo(() => query.data?.categories ?? [], [query.data]);

  /**
   * Every leaf, flattened, for the search.
   *
   * A seller types "cannula" and expects the cannula category, wherever it
   * sits. Making them open three parents first is the difference between a
   * picker and a filing cabinet.
   */
  const flattened = useMemo(() => {
    const out: { id: string; name: string; path: string }[] = [];

    const walk = (nodes: CategoryNode[], trail: string[]): void => {
      for (const node of nodes) {
        const nextTrail = [...trail, node.name];
        if (node.children.length === 0) {
          out.push({ id: node.id, name: node.name, path: nextTrail.join(' › ') });
        }
        walk(node.children, nextTrail);
      }
    };

    walk(tree, []);
    return out;
  }, [tree]);

  const matches =
    search.trim().length < 2
      ? []
      : flattened
          .filter((entry) => entry.path.toLowerCase().includes(search.trim().toLowerCase()))
          .slice(0, 30);

  if (query.isPending) return <LoadingState label="Loading categories" />;

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

  return (
    <Card
      title="What kind of product is it?"
      description="The category decides which details and photographs we ask you for, so it is worth getting right."
    >
      <div className="space-y-5 px-6 py-5">
        <Field label="Search categories" hint="Type at least two letters">
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="search"
              value={search}
              placeholder="Fasteners, cables, packaging, gloves…"
              onChange={(event) => {
                setSearch(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        {matches.length > 0 && (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border">
            {matches.map((match) => (
              <li key={match.id}>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    onChoose(match.id);
                  }}
                  className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-surface-hover disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {match.name}
                    </span>
                    <span className="block truncate text-xxs text-ink-subtle">{match.path}</span>
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-ink-subtle">
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {search.trim().length >= 2 && matches.length === 0 && (
          <EmptyState
            title="No category matches that"
            description="Try a shorter term, or browse the departments below."
          />
        )}

        {/* Browsing, for a seller who does not know what the category is
            called here. Two levels at a time rather than a full tree: a
            fourteen-hundred-node accordion is not navigable. */}
        <div>
          <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            Browse departments
          </h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tree.map((department) => (
              <li key={department.id} className="rounded-lg border border-border bg-surface">
                <button
                  type="button"
                  aria-expanded={openId === department.id}
                  onClick={() => {
                    setOpenId(openId === department.id ? null : department.id);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
                >
                  <span className="truncate text-sm font-medium text-ink">{department.name}</span>
                  <span aria-hidden="true" className="shrink-0 text-ink-subtle">
                    {openId === department.id ? '−' : '+'}
                  </span>
                </button>

                {openId === department.id && (
                  <ul className="border-t border-border-subtle">
                    {department.children.length === 0 ? (
                      <li>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            onChoose(department.id);
                          }}
                          className="w-full px-4 py-2.5 text-left text-sm text-ink-muted hover:bg-surface-hover"
                        >
                          Use {department.name}
                        </button>
                      </li>
                    ) : (
                      department.children.map((child) => (
                        <li key={child.id}>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => {
                              onChoose(child.id);
                            }}
                            className="w-full px-4 py-2.5 text-left text-sm text-ink-muted hover:bg-surface-hover disabled:opacity-60"
                          >
                            {child.name}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 2 - the brand
// ---------------------------------------------------------------------------

function BrandStep({
  draft,
  onChoose,
  onBack,
}: {
  draft: DraftView;
  onChoose: (brandId: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [isRequesting, setIsRequesting] = useState(false);

  const query = useQuery({
    queryKey: ['seller', 'brands', search],
    queryFn: () => fetchBrands(search),
  });

  const requestMutation = useMutation({
    mutationFn: (name: string) => requestBrand({ requestedName: name }),
    onSuccess: (result) => {
      toast.success('Brand requested. You can carry on with the rest of the listing.');
      onChoose(result.brandId);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That brand could not be requested.'));
    },
  });

  const warnings = query.data?.warnings ?? [];

  return (
    <Card
      title="Who makes it?"
      description="Pick the brand exactly as it appears on the product. Do not add words like 'original' or 'genuine'."
      actions={<Button onClick={onBack}>Back</Button>}
    >
      <div className="space-y-5 px-6 py-5">
        <Field label="Search brands">
          {({ inputId }) => (
            <Input
              id={inputId}
              type="search"
              value={search}
              placeholder="Start typing a brand or manufacturer"
              onChange={(event) => {
                setSearch(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        {/*
          Advice, not a refusal. The brief is explicit that a validation
          warning must not silently reject a legitimate business name, so these
          appear beside the field and the "request it" button stays live.
        */}
        {warnings.length > 0 && (
          <ul className="space-y-1.5 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3">
            {warnings.map((warning) => (
              <li key={warning.code} className="text-xs leading-relaxed text-ink">
                {warning.message}
              </li>
            ))}
          </ul>
        )}

        {query.data !== undefined && query.data.recent.length > 0 && search.length === 0 && (
          <div>
            <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Brands you have used
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {query.data.recent.map((brand) => (
                <BrandChip
                  key={brand.id}
                  brand={brand}
                  isSelected={brand.id === draft.brandId}
                  onSelect={() => {
                    onChoose(brand.id);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {query.isPending && <LoadingState label="Searching brands" />}

        {query.data !== undefined && (
          <div>
            <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              {search.length === 0 ? 'All approved brands' : 'Matching brands'}
            </h3>

            {query.data.brands.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">
                No brand here is called that yet.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border-subtle rounded-lg border border-border">
                {query.data.brands.map((brand) => (
                  <li key={brand.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChoose(brand.id);
                      }}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-surface-hover"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">
                          {brand.name}
                        </span>
                        {brand.manufacturerLegalName !== null && (
                          <span className="block truncate text-xxs text-ink-subtle">
                            {brand.manufacturerLegalName}
                          </span>
                        )}
                      </span>
                      {brand.status !== 'APPROVED' && <Badge tone="warning">Being reviewed</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Requesting one. Always available, never gated on the search having
            failed - a seller who knows their brand is not listed should not
            have to prove it by searching first. */}
        <div className="rounded-lg border border-border bg-surface-sunken px-4 py-4">
          {isRequesting ? (
            <div className="space-y-3">
              <Field
                label="Brand name"
                hint="Exactly as it is printed on the product or its packaging."
              >
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.currentTarget.value);
                    }}
                  />
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  isLoading={requestMutation.isPending}
                  disabled={search.trim().length < 2}
                  onClick={() => {
                    requestMutation.mutate(search.trim());
                  }}
                >
                  Request this brand
                </Button>
                <Button
                  onClick={() => {
                    setIsRequesting(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-xxs leading-relaxed text-ink-muted">
                We will check it and let you know. You can finish the rest of this listing while
                you wait — it just cannot go on sale until the brand is approved.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-ink-muted">Cannot find the brand?</p>
              <Button
                onClick={() => {
                  setIsRequesting(true);
                }}
              >
                Request a new brand
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function BrandChip({
  brand,
  isSelected,
  onSelect,
}: {
  brand: BrandSummary;
  isSelected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
      className={cx(
        'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
        isSelected
          ? 'border-brand/40 bg-brand-soft text-brand'
          : 'border-border-strong bg-surface text-ink hover:bg-surface-hover',
      )}
    >
      {brand.name}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 3 - the details
// ---------------------------------------------------------------------------

const SECTION_ORDER: readonly ListingSection[] = Object.freeze([
  'PRODUCT_PHOTOS',
  'PRICE_STOCK_SHIPPING',
  'PRODUCT_DESCRIPTION',
  'ADDITIONAL_INFORMATION',
  'MEDICAL_COMPLIANCE',
]);

function DetailsStep({
  draft,
  onSave,
  isSaving,
}: {
  draft: DraftView;
  onSave: (patch: Parameters<typeof saveDraft>[1]) => void;
  isSaving: boolean;
}): React.JSX.Element {
  const schema = draft.schema;

  if (schema === null) {
    return (
      <Card>
        <EmptyState
          title="This listing has no category"
          description="Go back a step and choose one, and the right questions will appear here."
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      {/* Left: photographs and the title preview. Fixed on the left at
          desktop widths and stacked first on a phone, because the photographs
          are what a seller is usually waiting on. */}
      <div className="space-y-5">
        <ListingMediaPanel
          draft={draft}
          summary={draft.sections.find((entry) => entry.section === 'PRODUCT_PHOTOS') ?? null}
        />
        <TitlePreview draft={draft} />
      </div>

      {/* Right: the sections, each with its own Edit / Save / Cancel. */}
      <div className="space-y-4">
        <BlockerSummary draft={draft} />

        {SECTION_ORDER.map((section) => (
          <SectionPanel
            key={section}
            section={section}
            summary={draft.sections.find((entry) => entry.section === section) ?? null}
            attributes={schema.attributes.filter((attribute) => attribute.section === section)}
            draft={draft}
            issues={draft.issues.filter((issue) => issue.section === section)}
            onSave={onSave}
            isSaving={isSaving}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Everything blocking submission, once, at the top.
 *
 * The issues also appear beside their fields, and both are needed: the
 * per-field copy is how the seller fixes one, and this is how they find out
 * there are five without scrolling through five sections.
 */
function BlockerSummary({ draft }: { draft: DraftView }): React.JSX.Element | null {
  const blockers = draft.issues.filter((issue) => issue.severity === 'BLOCKER');

  if (draft.reviewComment !== null && draft.reviewComment.length > 0) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3" role="status">
        <p className="text-sm font-semibold text-ink">The marketplace sent this back</p>
        <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-muted">
          {draft.reviewComment}
        </p>
      </div>
    );
  }

  if (blockers.length === 0) {
    return (
      <div className="rounded-lg border border-success/30 bg-success-soft px-4 py-3" role="status">
        <p className="text-sm font-medium text-ink">
          Everything required is filled in. You can send this for quality review.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3" role="status">
      <p className="text-sm font-semibold text-ink">
        {blockers.length} {blockers.length === 1 ? 'thing needs' : 'things need'} fixing before this
        can be reviewed
      </p>
      <ul className="mt-2 space-y-1">
        {blockers.slice(0, 6).map((issue, index) => (
          <li key={`${issue.code}-${issue.attributeKey ?? String(index)}`} className="text-xs text-ink-muted">
            <span className="font-medium text-ink">
              {issue.section === null ? 'Listing' : sectionLabel(issue.section)}:
            </span>{' '}
            {issue.message}
          </li>
        ))}
        {blockers.length > 6 && (
          <li className="text-xs text-ink-subtle">and {blockers.length - 6} more</li>
        )}
      </ul>
    </div>
  );
}


/**
 * The generated title, and why it says what it says.
 *
 * The button is live exactly when the server says every title component is
 * present and valid. When it is not, the fields that are missing are named -
 * a disabled button with no explanation is the single most frustrating control
 * on a form this size.
 */
function TitlePreview({ draft }: { draft: DraftView }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewTitle>> | null>(null);

  const mutation = useMutation({
    mutationFn: () => previewTitle(draft.id),
    onSuccess: (result) => {
      setPreview(result);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'The title could not be worked out.'));
    },
  });

  return (
    <Card title="Product title">
      <div className="space-y-3 px-6 py-5">
        <p className="text-xxs leading-relaxed text-ink-muted">
          The title is built automatically from the product details you fill in, so that buyers can
          compare listings from different sellers side by side.
        </p>

        <Button
          fullWidth
          isLoading={mutation.isPending}
          disabled={!draft.canPreviewTitle}
          onClick={() => {
            mutation.mutate();
          }}
        >
          Preview title
        </Button>

        {!draft.canPreviewTitle && (
          <p className="text-xxs text-ink-subtle">
            Fill in the required product details and this will become available.
          </p>
        )}

        {preview !== null && preview.ready && (
          <div className="space-y-2 rounded-lg border border-border bg-surface-sunken px-3 py-3">
            <p className="text-sm font-medium leading-snug text-ink">{preview.title}</p>
            <div>
              <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Built from
              </p>
              <ul className="mt-1 space-y-0.5">
                {preview.contributions.map((entry) => (
                  <li key={entry.attributeKey} className="text-xxs text-ink-muted">
                    <span className="text-ink">{entry.label}:</span> {entry.text}
                  </li>
                ))}
              </ul>
            </div>
            {!preview.isEditable && (
              <p className="text-xxs text-ink-subtle">
                Titles cannot be edited directly here. If something is wrong, change the field it
                came from.
              </p>
            )}
          </div>
        )}

        {preview !== null && !preview.ready && preview.blockedBy.length > 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-3">
            <p className="text-xxs font-semibold text-ink">Still needed for the title</p>
            <ul className="mt-1 space-y-0.5">
              {preview.blockedBy.map((entry) => (
                <li key={entry.attributeKey} className="text-xxs text-ink-muted">
                  {entry.label} — {entry.reason === 'MISSING' ? 'not filled in' : 'not valid'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function SectionCount({ summary }: { summary: SectionSummary }): React.JSX.Element {
  const tone =
    summary.state === 'ERROR'
      ? 'danger'
      : summary.state === 'COMPLETE'
        ? 'success'
        : summary.state === 'OPTIONAL'
          ? 'neutral'
          : summary.state === 'IN_PROGRESS'
            ? 'warning'
            : 'neutral';

  return (
    <Badge tone={tone}>
      {summary.completed}/{summary.total}
      {summary.state === 'OPTIONAL' && ' optional'}
    </Badge>
  );
}

/**
 * One collapsible section with its own Edit / Save / Cancel.
 *
 * Cancel restores the values as they were when Edit was pressed, not as they
 * are on the server: a seller who types three things and changes their mind
 * expects all three to go, and a reload-from-server would also discard an
 * unrelated autosave that landed in between.
 */
function SectionPanel({
  section,
  summary,
  attributes,
  draft,
  issues,
  onSave,
  isSaving,
}: {
  section: ListingSection;
  summary: SectionSummary | null;
  attributes: SchemaAttribute[];
  draft: DraftView;
  issues: DraftView['issues'];
  onSave: (patch: Parameters<typeof saveDraft>[1]) => void;
  isSaving: boolean;
}): React.JSX.Element | null {
  const [isEditing, setIsEditing] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const snapshot = useRef<Record<string, unknown>>({});

  // Photos have their own panel on the left; this one would be an empty
  // duplicate of it.
  const isPhotoSection = section === 'PRODUCT_PHOTOS';

  const beginEditing = useCallback(() => {
    const current: Record<string, unknown> = {};
    for (const attribute of attributes) {
      current[attribute.attributeKey] = draft.attributes[attribute.attributeKey];
    }
    snapshot.current = current;
    setValues(current);
    setIsEditing(true);
  }, [attributes, draft.attributes]);

  if (isPhotoSection) {
    return issues.length === 0 ? null : (
      <Card title={sectionLabel(section)} actions={summary === null ? undefined : <SectionCount summary={summary} />}>
        <IssueList issues={issues} />
      </Card>
    );
  }

  if (attributes.length === 0 && section !== 'PRICE_STOCK_SHIPPING') return null;

  return (
    <Card
      title={sectionLabel(section)}
      actions={
        <div className="flex items-center gap-2">
          {summary !== null && <SectionCount summary={summary} />}
          {isEditing ? (
            <>
              <Button
                size="sm"
                onClick={() => {
                  setValues(snapshot.current);
                  setIsEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                isLoading={isSaving}
                onClick={() => {
                  onSave({ attributes: values });
                  setIsEditing(false);
                }}
              >
                Save
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={beginEditing}>
              Edit
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4 px-6 py-5">
        <IssueList issues={issues} />

        {section === 'PRICE_STOCK_SHIPPING' && (
          <OfferFields draft={draft} onSave={onSave} isSaving={isSaving} />
        )}

        {attributes.length === 0 ? (
          section === 'PRICE_STOCK_SHIPPING' ? null : (
            <p className="text-sm text-ink-muted">
              Nothing extra is asked for in this category.
            </p>
          )
        ) : isEditing ? (
          <div className="space-y-4">
            {attributes.map((attribute) => (
              <AttributeField
                key={attribute.attributeKey}
                attribute={attribute}
                value={values[attribute.attributeKey]}
                error={
                  issues.find((issue) => issue.attributeKey === attribute.attributeKey)?.message
                }
                onChange={(next) => {
                  setValues((previous) => ({ ...previous, [attribute.attributeKey]: next }));
                }}
              />
            ))}
          </div>
        ) : (
          <dl className="divide-y divide-border-subtle">
            {attributes.map((attribute) => (
              <div key={attribute.attributeKey} className="flex gap-4 py-2.5">
                <dt className="w-44 shrink-0 text-sm text-ink-muted">
                  {attribute.label}
                  {attribute.isRequired && (
                    <span aria-hidden="true" className="ml-0.5 text-danger">
                      *
                    </span>
                  )}
                </dt>
                <dd className="min-w-0 flex-1 text-sm text-ink">
                  {renderValue(draft.attributes[attribute.attributeKey]) ?? (
                    <span className="text-ink-subtle">Not filled in</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Card>
  );
}

function IssueList({ issues }: { issues: DraftView['issues'] }): React.JSX.Element | null {
  if (issues.length === 0) return null;

  return (
    <ul className="space-y-1.5">
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}-${issue.attributeKey ?? String(index)}`}
          className={cx(
            'flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed',
            issue.severity === 'BLOCKER'
              ? 'bg-danger-soft text-ink'
              : 'bg-warning-soft text-ink',
          )}
        >
          {/* An icon as well as a colour. A red panel and an amber one are the
              same panel to a lot of people, and the difference here is
              "blocked" versus "worth knowing". */}
          <span aria-hidden="true" className="shrink-0 font-semibold">
            {issue.severity === 'BLOCKER' ? '✕' : '!'}
          </span>
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Turn a stored value into something readable, or null when there is none. */
/**
 * A scalar as text, or null for anything that is not one.
 *
 * Everything below goes through this rather than through `String()`. The
 * values arrive as `unknown` - they are whatever the seller last saved into a
 * JSON column - and `String()` over an unexpected object produces
 * "[object Object]", which then appears on screen as though it were the
 * seller's own answer.
 */
function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return null;
}

function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === 'object' && entry !== null) {
          const row = entry as { name?: unknown; quantity?: unknown };
          const name = scalarText(row.name);
          const quantity = scalarText(row.quantity);
          if (name === null) return null;
          return quantity === null ? name : `${name} × ${quantity}`;
        }
        return scalarText(entry);
      })
      .filter((part): part is string => part !== null && part.length > 0);

    return parts.length === 0 ? null : parts.join(', ');
  }

  if (typeof value === 'object') {
    const measurement = value as { amount?: unknown; unit?: unknown };
    const amount = scalarText(measurement.amount);
    if (amount === null) return null;

    const unit = scalarText(measurement.unit);
    return unit === null ? amount : `${amount} ${unit}`;
  }

  const text = scalarText(value);
  return text === null || text.trim().length === 0 ? null : text.trim();
}

/**
 * One input, drawn from its definition.
 *
 * The switch is on `type`, which is a database column, so adding a field to a
 * category is a row rather than a deploy. That is the whole reason the schema
 * is data - see `listing-schema.service.ts`.
 */
function AttributeField({
  attribute,
  value,
  error,
  onChange,
}: {
  attribute: SchemaAttribute;
  value: unknown;
  error: string | undefined;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const common = {
    label: attribute.label,
    ...(attribute.helpText === null ? {} : { hint: attribute.helpText }),
    ...(error === undefined ? {} : { error }),
    required: attribute.isRequired,
  };

  switch (attribute.type) {
    case 'BOOLEAN':
      return (
        <Field {...common}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={value === true ? 'yes' : value === false ? 'no' : ''}
              onChange={(event) => {
                const next = event.currentTarget.value;
                onChange(next === '' ? null : next === 'yes');
              }}
            >
              <option value="">Not answered</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          )}
        </Field>
      );

    case 'DROPDOWN':
      return (
        <Field {...common}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                onChange(event.currentTarget.value === '' ? null : event.currentTarget.value);
              }}
            >
              <option value="">Choose one</option>
              {(attribute.allowedValues ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );

    case 'MULTI_SELECT': {
      const selected = Array.isArray(value) ? value.map(String) : [];

      return (
        <fieldset>
          <legend className="block text-sm font-medium text-ink">
            {attribute.label}
            {attribute.isRequired && (
              <span aria-hidden="true" className="ml-0.5 text-danger">
                *
              </span>
            )}
          </legend>
          {attribute.helpText !== null && (
            <p className="mt-1 text-xxs text-ink-muted">{attribute.helpText}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {(attribute.allowedValues ?? []).map((option) => {
              const isOn = selected.includes(option.value);

              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={isOn}
                  onClick={() => {
                    onChange(
                      isOn
                        ? selected.filter((entry) => entry !== option.value)
                        : [...selected, option.value],
                    );
                  }}
                  className={cx(
                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    isOn
                      ? 'border-brand/40 bg-brand-soft text-brand'
                      : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-hover',
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {error !== undefined && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </fieldset>
      );
    }

    case 'MEASUREMENT': {
      const measurement = (value ?? {}) as { amount?: unknown; unit?: unknown };

      return (
        <Field {...common}>
          {({ inputId }) => (
            <div className="flex gap-2">
              <Input
                id={inputId}
                type="number"
                className="flex-1"
                value={scalarText(measurement.amount) ?? ''}
                onChange={(event) => {
                  onChange({ ...measurement, amount: event.currentTarget.value });
                }}
              />
              <Select
                aria-label={`${attribute.label} unit`}
                className="w-28"
                value={typeof measurement.unit === 'string' ? measurement.unit : ''}
                onChange={(event) => {
                  onChange({ ...measurement, unit: event.currentTarget.value });
                }}
              >
                <option value="">Unit</option>
                {(attribute.allowedUnits ?? []).map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </Field>
      );
    }

    case 'KEY_VALUE_LIST': {
      const rows = Array.isArray(value)
        ? (value as { name?: string; quantity?: number; unit?: string }[])
        : [];

      return (
        <fieldset>
          <legend className="block text-sm font-medium text-ink">{attribute.label}</legend>
          {attribute.helpText !== null && (
            <p className="mt-1 text-xxs text-ink-muted">{attribute.helpText}</p>
          )}

          <ul className="mt-2 space-y-2">
            {rows.map((row, index) => (
              // The index is the key because these rows have no identity of
              // their own and reorder only by the seller adding or removing
              // one, which re-renders the list anyway.
              <li key={index} className="flex gap-2">
                <Input
                  aria-label={`Item ${String(index + 1)} name`}
                  placeholder="Item"
                  className="flex-1"
                  value={row.name ?? ''}
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = { ...row, name: event.currentTarget.value };
                    onChange(next);
                  }}
                />
                <Input
                  aria-label={`Item ${String(index + 1)} quantity`}
                  type="number"
                  min={1}
                  placeholder="Qty"
                  className="w-24"
                  value={row.quantity === undefined ? '' : String(row.quantity)}
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = { ...row, quantity: Number(event.currentTarget.value) };
                    onChange(next);
                  }}
                />
                <Button
                  size="sm"
                  onClick={() => {
                    onChange(rows.filter((_, entry) => entry !== index));
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>

          <Button
            size="sm"
            className="mt-2"
            onClick={() => {
              onChange([...rows, { name: '', quantity: 1 }]);
            }}
          >
            Add an item
          </Button>

          {error !== undefined && <p className="mt-1.5 text-xs text-danger">{error}</p>}
        </fieldset>
      );
    }

    case 'LONG_TEXT':
    case 'RICH_TEXT':
      return (
        <Field {...common}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={5}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                onChange(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      );

    case 'NUMBER':
    case 'DECIMAL':
      return (
        <Field {...common}>
          {({ inputId, describedBy }) => (
            <div className="flex items-center gap-2">
              <Input
                id={inputId}
                aria-describedby={describedBy}
                type="number"
                step={attribute.type === 'DECIMAL' ? 'any' : 1}
                value={scalarText(value) ?? ''}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  onChange(raw === '' ? null : Number(raw));
                }}
              />
              {attribute.unit !== null && (
                <span className="shrink-0 text-sm text-ink-muted">{attribute.unit}</span>
              )}
            </div>
          )}
        </Field>
      );

    case 'DATE':
      return (
        <Field {...common}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="date"
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                onChange(event.currentTarget.value === '' ? null : event.currentTarget.value);
              }}
            />
          )}
        </Field>
      );

    case 'DOCUMENT':
      return (
        <Field {...common} hint="Document uploads need object storage to be configured.">
          {({ inputId }) => (
            <Input id={inputId} disabled value="" placeholder="Not available on this deployment" />
          )}
        </Field>
      );

    case 'TEXT':
    default:
      return (
        <Field {...common}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => {
                onChange(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      );
  }
}

/**
 * Price, minimum order and stock.
 *
 * These live on the OFFER rather than in `attributes`, because they are the
 * seller's commercial terms rather than facts about the product - and because
 * they survive into `SellerOffer` unchanged when the listing is approved.
 *
 * The price is typed in major units and converted here, once. Two conversions
 * in two places is how a price ends up a hundred times too large.
 */
function OfferFields({
  draft,
  onSave,
  isSaving,
}: {
  draft: DraftView;
  onSave: (patch: Parameters<typeof saveDraft>[1]) => void;
  isSaving: boolean;
}): React.JSX.Element {
  const [price, setPrice] = useState(
    draft.offer.priceMinor === null || draft.offer.priceMinor === undefined
      ? ''
      : (Number(draft.offer.priceMinor) / 100).toFixed(2),
  );
  const [currency, setCurrency] = useState(draft.offer.currency ?? 'EUR');
  const [moq, setMoq] = useState(String(draft.offer.minimumOrderQuantity ?? 1));
  const [sku, setSku] = useState(draft.sellerSku ?? '');

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-sunken px-4 py-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your product code" hint="Unique to you. It appears on your picking lists." required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={sku}
              onChange={(event) => {
                setSku(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field label="Minimum order quantity" required>
          {({ inputId }) => (
            <Input
              id={inputId}
              type="number"
              min={1}
              value={moq}
              onChange={(event) => {
                setMoq(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field label="Price per unit" required>
          {({ inputId }) => (
            <Input
              id={inputId}
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(event) => {
                setPrice(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field label="Currency" required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={currency}
              onChange={(event) => {
                setCurrency(event.currentTarget.value);
              }}
            >
              {['EUR', 'GBP', 'USD', 'INR'].map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Button
        variant="primary"
        size="sm"
        isLoading={isSaving}
        onClick={() => {
          // Major units to minor, as a STRING. Rounded rather than truncated,
          // because 19.99 is not exactly representable and `Math.trunc` on the
          // product would charge 19.98.
          const minor =
            price.trim().length === 0 ? null : String(Math.round(Number(price) * 100));

          onSave({
            sellerSku: sku.trim().length === 0 ? null : sku.trim(),
            offer: {
              priceMinor: minor,
              currency,
              minimumOrderQuantity: Number(moq) > 0 ? Number(moq) : 1,
            },
          });
        }}
      >
        Save price and stock
      </Button>
    </div>
  );
}
