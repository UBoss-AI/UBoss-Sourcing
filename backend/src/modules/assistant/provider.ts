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
  /** Stable across visitors, so a provider that caches prefixes can. */
  systemPrompt: string;
  /** The catalogue. Second half of the cacheable prefix. */
  catalogue: string;
  turns: AssistantTurn[];
  maxTokens: number;
  signal?: AbortSignal | undefined;
  onText: (delta: string) => void;
}

export interface AssistantProvider {
  readonly name: 'gemini' | 'anthropic';
  readonly model: string;
  stream: (request: AssistantRequest) => Promise<AssistantResult>;
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
