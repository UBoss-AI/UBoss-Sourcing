/**
 * The one thing the two providers have to agree on.
 *
 * Everything that makes the assistant useful — the catalogue snapshot, the
 * behaviour rules, the medical-device guardrail, the input caps, the SSE
 * plumbing — is provider-neutral and lives outside this seam. What is left is
 * about forty lines per provider: turn a system prompt plus a list of turns
 * into a stream of text deltas.
 *
 * The seam exists because this deployment's provider is a deployment decision.
 * Swapping it is one environment variable, not a rewrite.
 */

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantUsage {
  /** Prompt tokens billed at full rate. */
  inputTokens: number;
  /** Prompt tokens served from the provider's cache, where it reports them. */
  cachedInputTokens: number;
  outputTokens: number;
  /**
   * Reasoning tokens, where the provider bills them separately and reports
   * them. Worth logging: on a grounded storefront answer they are pure waste,
   * and a non-zero number here means the model is thinking when it should not
   * be.
   */
  thinkingTokens: number;
}

export interface AssistantResult extends AssistantUsage {
  /** The provider's own reason, unmapped. Logged, not shown to a visitor. */
  finishReason: string | null;
  /** True when the provider declined on policy grounds rather than answering. */
  refused: boolean;
  model: string;
}

export interface AssistantRequest {
  /** Stable across customers, so a provider that caches prefixes can. */
  systemPrompt: string;
  /** The catalogue. Second half of the cacheable prefix. */
  catalogue: string;
  /**
   * What this particular customer's account already says about them, so the
   * assistant never has to ask.
   *
   * Goes LAST in the system prompt, after everything cacheable, and both
   * providers must keep it there: it is the one part that differs per caller,
   * and a per-caller byte anywhere earlier would miss the prefix cache for
   * every request on the deployment.
   */
  customer?: string | undefined;
  turns: AssistantTurn[];
  maxTokens: number;
  signal?: AbortSignal | undefined;
  onText: (delta: string) => void;
}

/**
 * One image, one question, one answer — the whole of what image search needs.
 *
 * Separate from `AssistantRequest` rather than a variant of it, because almost
 * nothing about the two is the same. There is no conversation, no streaming, no
 * customer block and no prefix worth caching: this is a single call whose reply
 * is parsed by a machine, not read by a person, and the caller wants the whole
 * string or nothing.
 *
 * The image arrives as bytes plus the type sniffed from its magic bytes. The
 * uploader's own `Content-Type` never reaches here — see the route.
 */
export interface AssistantVisionRequest {
  systemPrompt: string;
  /** The catalogue index the model must choose its matches from. */
  catalogue: string;
  image: { data: Buffer; mimeType: string };
  /** What to do with the image. */
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal | undefined;
}

export interface AssistantVisionResult {
  /** The reply in full. Parsed by the caller; never shown raw to a customer. */
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantProvider {
  readonly name: 'gemini' | 'anthropic';
  readonly model: string;
  stream: (request: AssistantRequest) => Promise<AssistantResult>;
  /**
   * Look at an image and answer one question about it.
   *
   * Required rather than optional: both providers this deployment can be
   * pointed at are multimodal, and making it optional would mean every caller
   * carrying a "this provider cannot see" branch that no configuration can
   * actually reach.
   */
  describeImage: (request: AssistantVisionRequest) => Promise<AssistantVisionResult>;
}

/** Thrown when the provider refuses for capacity or quota reasons. */
export class AssistantBusyError extends Error {
  constructor(
    message: string,
    /** True for a quota/billing exhaustion, as opposed to transient load. */
    readonly isQuota: boolean,
  ) {
    super(message);
    this.name = 'AssistantBusyError';
  }
}
