/**
 * The preorder assistant, in the chat's history before a conversation exists.
 *
 * Automated, and says so on every answer: "{{marketplace}} Preorder
 * Assistant · Automated", its own mark, never the team's avatar and never a
 * person's name. It answers common questions from the product's own preorder
 * information - the server builds every answer - and when that information is
 * not there it says the team has to confirm it, and offers a person.
 *
 * A person is one button away the whole time, not only at the end of an
 * answer: "Connect with a human agent" is in the assistant's header from the
 * first moment.
 *
 * Everything here is text. Answers are rendered as React text nodes from
 * translation keys and typed values; nothing the server sends is HTML.
 */
import { useId, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import {
  BoxIcon,
  CalendarIcon,
  CardIcon,
  ChevronRightIcon,
  CurrencyIcon,
  CylinderIcon,
  LayersIcon,
  PencilIcon,
  RefreshIcon,
  SparkIcon,
  TruckIcon,
} from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  faqLineText,
  faqQuestionText,
  type AssistantQuestion,
  type FaqAnswer,
  type FaqId,
  type TranscriptEntry,
} from '@/lib/preorder-assistant';
import type { PreorderAssistantState } from '@/lib/use-preorder-assistant';

export type HandoffStatus = 'idle' | 'sending' | 'failed';

export interface PreorderAssistantProps {
  assistant: PreorderAssistantState;
  /** From the chat's own context card while the greeting's is loading. */
  productName: string;
  onRequestHuman: () => void;
  handoffStatus: HandoffStatus;
  handoffError: unknown;
  /** A guest is told that asking for a person means signing in first. */
  signedIn: boolean;
}

/** The assistant's mark: a spark in a soft brand circle - not a face, not initials. */
export function AssistantMark({ size = 'sm' }: { size?: 'sm' | 'md' }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand ring-1 ring-inset ring-brand/25',
        size === 'sm' ? 'size-7' : 'size-9',
      )}
    >
      <SparkIcon className={size === 'sm' ? 'size-3.5' : 'size-4'} />
    </span>
  );
}

/** "{{marketplace}} Preorder Assistant  [Automated]" - above every answer. */
export function AssistantLabel(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <p className="mb-0.5 flex items-center gap-1.5 px-1 text-xxs font-medium text-ink-muted">
      <span>{t('preorderChat.assistant.name')}</span>
      <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
        {t('preorderChat.assistant.automated')}
      </span>
    </p>
  );
}

/** One answer's lines, and a quiet flag when the team has to confirm it. */
export function AnswerLines({ answer }: { answer: FaqAnswer }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  return (
    <div className="space-y-1.5">
      {answer.lines.map((line, index) => (
        <p
          key={`${line.key}-${String(index)}`}
          className={cx(
            'whitespace-pre-line [overflow-wrap:anywhere]',
            line.key === 'preorderChat.assistant.a.needsConfirmation' && 'font-medium text-ink',
          )}
        >
          {faqLineText(line, t, intlLocale)}
        </p>
      ))}
      {answer.outcome === 'NEEDS_CONFIRMATION' && (
        <p className="inline-flex rounded-full bg-warning-soft px-2 py-0.5 text-xxs font-semibold text-warning">
          {t('preorderChat.assistant.needsTeam')}
        </p>
      )}
    </div>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-end gap-2">
      <span className="w-7 shrink-0">
        <AssistantMark />
      </span>
      <div className="flex min-w-0 max-w-[min(85%,36rem)] flex-col items-start">
        <AssistantLabel />
        <div className="min-w-0 max-w-full rounded-2xl rounded-bl-md border border-brand/15 bg-brand-soft/40 px-3 py-2 text-sm text-ink">
          {children}
        </div>
      </div>
    </div>
  );
}

function QuestionBubble({ text }: { text: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex justify-end">
      <p className="min-w-0 max-w-[min(85%,36rem)] rounded-2xl rounded-br-md bg-brand-fill px-3 py-2 text-sm text-white [overflow-wrap:anywhere]">
        <span className="sr-only">{t('preorderChat.sender.you')}: </span>
        {text}
      </p>
    </div>
  );
}

function ChoiceRow({ children, label }: { children: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <div className="ml-9 mt-2" role="group" aria-label={label}>
      <p className="mb-1 text-xs font-medium text-ink-muted" aria-hidden="true">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

const CHOICE =
  'inline-flex min-h-8 items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60';

type IconComponent = (props: { className?: string }) => React.JSX.Element;

/** One icon per question, so the list can be scanned by shape as well as by word. */
const QUESTION_ICON: Readonly<Record<FaqId, IconComponent>> = {
  moq: BoxIcon,
  bulkPricing: CurrencyIcon,
  container20: LayersIcon,
  container40: LayersIcon,
  stock: CylinderIcon,
  insufficientStock: CylinderIcon,
  deliveryDate: CalendarIcon,
  splitShipments: TruckIcon,
  customisation: PencilIcon,
  payment: CardIcon,
  logistics: TruckIcon,
  changeCancel: RefreshIcon,
};

/** The first few are enough to start; the rest are one tap away. */
const QUESTIONS_SHOWN = 6;

/**
 * The common questions as one card of tappable rows - the shape a support
 * chat uses: an icon, the question, a chevron. Every row is a real button, at
 * least 44 px tall, and the whole card is one list for a screen reader. A
 * question already asked stays in the list, quieter, and can be asked again.
 */
function QuestionCards({
  questions,
  labelledBy,
  disabled,
  asked,
  onAsk,
}: {
  questions: AssistantQuestion[];
  labelledBy: string;
  disabled: boolean;
  asked: ReadonlySet<FaqId>;
  onAsk: (id: FaqId) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const visible = expanded ? questions : questions.slice(0, QUESTIONS_SHOWN);
  const hidden = questions.length - visible.length;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <ul id={listId} aria-labelledby={labelledBy} className="divide-y divide-border-subtle">
        {visible.map((question) => {
          const Icon = QUESTION_ICON[question.id];
          const done = asked.has(question.id);
          return (
            <li key={question.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onAsk(question.id);
                }}
                className={cx(
                  'group flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-sm',
                  'transition-colors duration-150 motion-reduce:transition-none',
                  'hover:bg-brand-soft/60 focus-visible:bg-brand-soft/60 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'inline-flex size-8 shrink-0 items-center justify-center rounded-lg',
                    done ? 'bg-surface-sunken text-ink-subtle' : 'bg-brand-soft text-brand',
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <span className={cx('min-w-0 flex-1 [overflow-wrap:anywhere]', done ? 'text-ink-muted' : 'font-medium text-ink')}>
                  {faqQuestionText(question.id, t)}
                  {done && <span className="sr-only"> ({t('preorderChat.assistant.alreadyAsked')})</span>}
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-ink-subtle transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-brand motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 rtl:rotate-180"
                />
              </button>
            </li>
          );
        })}
      </ul>
      {questions.length > QUESTIONS_SHOWN && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => {
            setExpanded((open) => !open);
          }}
          className="flex min-h-10 w-full items-center justify-center gap-1 border-t border-border-subtle bg-surface-sunken/50 px-3 py-2 text-xs font-semibold text-brand hover:bg-brand-soft/60 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
        >
          {expanded
            ? t('preorderChat.assistant.fewerQuestions')
            : t('preorderChat.assistant.moreQuestions', { more: String(hidden) })}
        </button>
      )}
    </div>
  );
}

export function PreorderAssistant({
  assistant,
  productName,
  onRequestHuman,
  handoffStatus,
  handoffError,
  signedIn,
}: PreorderAssistantProps): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const headingId = useId();
  const { intro, entries, asking, askError, choosing } = assistant;
  const name = intro?.greeting.productName ?? productName;
  const last: TranscriptEntry | undefined = entries.at(-1);
  const connecting = handoffStatus === 'sending';

  const connectButton = (variant: 'primary' | 'quiet'): React.JSX.Element => (
    <button
      type="button"
      onClick={onRequestHuman}
      disabled={connecting}
      aria-describedby={signedIn ? undefined : `${headingId}-signin`}
      className={cx(
        CHOICE,
        variant === 'primary'
          ? 'border-brand bg-brand-fill text-white hover:bg-brand-fill-hover'
          : 'border-border bg-surface text-brand hover:border-brand/50 hover:bg-brand-soft',
      )}
    >
      {connecting ? (
        <>
          <Spinner className="mr-1.5 size-3.5" /> {t('preorderChat.assistant.connecting')}
        </>
      ) : (
        t('preorderChat.assistant.connectHuman')
      )}
    </button>
  );

  return (
    <section aria-labelledby={headingId} className="mb-2">
      {/* Who this is, and the way to a person, before anything else. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border-subtle bg-surface-sunken/60 px-3 py-2">
        <AssistantMark size="md" />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
            {t('preorderChat.assistant.name')}
            <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
              {t('preorderChat.assistant.automated')}
            </span>
          </h3>
          <p className="text-xxs text-ink-subtle">{t('preorderChat.assistant.identityNote')}</p>
        </div>
        {connectButton('quiet')}
      </div>
      {!signedIn && (
        <p id={`${headingId}-signin`} className="-mt-2 mb-3 px-1 text-xxs text-ink-subtle">
          {t('preorderChat.assistant.signInToConnect')}
        </p>
      )}

      <ol className="flex flex-col gap-3">
        <li>
          <AssistantBubble>
            <p className="[overflow-wrap:anywhere]">
              {intro?.greeting.firstName !== null && intro?.greeting.firstName !== undefined
                ? t('preorderChat.assistant.greeting', { firstName: intro.greeting.firstName, productName: name })
                : t('preorderChat.assistant.greetingGuest', { productName: name })}
            </p>
          </AssistantBubble>
        </li>

        {entries.map((entry, index) => (
          <li key={`${entry.askedAt}-${String(index)}`} className="flex flex-col gap-3">
            <QuestionBubble text={faqQuestionText(entry.answer.faqId, t)} />
            <AssistantBubble>
              <AnswerLines answer={entry.answer} />
            </AssistantBubble>
          </li>
        ))}

        {asking !== null && (
          <li className="flex flex-col gap-3">
            <QuestionBubble text={faqQuestionText(asking, t)} />
            <p role="status" className="ml-9 flex items-center gap-2 text-xs text-ink-muted">
              <Spinner className="size-3.5" /> {t('preorderChat.assistant.thinking')}
            </p>
          </li>
        )}
      </ol>

      {askError !== null && asking === null && (
        <div role="alert" className="ml-9 mt-3 rounded-md border border-danger/30 bg-danger-soft p-2.5 text-xs">
          <p>{errorMessage(t, askError.error, t('preorderChat.assistant.askError'))}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => { assistant.ask(askError.faqId); }}>
            {t('preorderChat.assistant.tryAgain')}
          </Button>
        </div>
      )}

      {/* After an answer: was it enough, and would a person help? */}
      {last !== undefined && !choosing && asking === null && (
        <>
          {last.feedback === null ? (
            <ChoiceRow label={t('preorderChat.assistant.helpfulQuestion')}>
              <button type="button" className={cx(CHOICE, 'border-border bg-surface text-ink hover:border-brand/50 hover:bg-brand-soft')} onClick={assistant.markHelpful}>
                {t('preorderChat.assistant.helpfulYes')}
              </button>
              <button type="button" className={cx(CHOICE, 'border-border bg-surface text-ink hover:border-brand/50 hover:bg-brand-soft')} onClick={assistant.showQuestions}>
                {t('preorderChat.assistant.askAnother')}
              </button>
            </ChoiceRow>
          ) : (
            <p className="ml-9 mt-2 text-xs text-ink-muted">{t('preorderChat.assistant.helpfulThanks')}</p>
          )}
          {!assistant.humanOfferDismissed && (
            <ChoiceRow label={t('preorderChat.assistant.humanQuestion')}>
              {connectButton(last.answer.outcome === 'NEEDS_CONFIRMATION' ? 'primary' : 'quiet')}
              <button
                type="button"
                className={cx(CHOICE, 'border-border bg-surface text-ink-muted hover:text-ink')}
                onClick={assistant.dismissHumanOffer}
                disabled={connecting}
              >
                {t('preorderChat.assistant.notNow')}
              </button>
            </ChoiceRow>
          )}
        </>
      )}

      {handoffStatus === 'failed' && (
        <div role="alert" className="ml-9 mt-3 rounded-md border border-danger/30 bg-danger-soft p-2.5 text-xs">
          <p>{errorMessage(t, handoffError, t('preorderChat.assistant.handoffError'))}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onRequestHuman}>
            {t('preorderChat.assistant.tryAgain')}
          </Button>
        </div>
      )}

      {/* The questions: at the start, and whenever the customer wants another. */}
      {(choosing || last?.feedback === 'helpful') && asking === null && (
        <div className="ml-9 mt-3">
          <p className="mb-1.5 text-xs font-medium text-ink-muted" id={`${headingId}-questions`}>
            {t('preorderChat.assistant.questionsHeading')}
          </p>
          {assistant.introLoading ? (
            <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
              <Spinner className="size-3.5" /> {t('preorderChat.assistant.loadingQuestions')}
            </p>
          ) : assistant.introError !== null || intro === undefined ? (
            <div role="alert" className="text-xs">
              <p className="text-ink-muted">{t('preorderChat.assistant.introError')}</p>
              <Button size="sm" variant="secondary" className="mt-1.5" onClick={assistant.retryIntro}>
                {t('preorderChat.assistant.tryAgain')}
              </Button>
            </div>
          ) : (
            <QuestionCards
              questions={intro.questions}
              labelledBy={`${headingId}-questions`}
              // The list is only drawn while no answer is on its way.
              disabled={false}
              asked={new Set(entries.map((entry) => entry.answer.faqId))}
              onAsk={assistant.ask}
            />
          )}
        </div>
      )}

      {/* The newest answer, read once to a screen reader - the history is a log that does not read itself. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {last === undefined
          ? ''
          : `${t('preorderChat.assistant.name')}: ${last.answer.lines.map((line) => faqLineText(line, t, intlLocale)).join(' ')}`}
      </p>
    </section>
  );
}
