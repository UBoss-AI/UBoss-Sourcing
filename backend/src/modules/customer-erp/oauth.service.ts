/**
 * OAuth 2.0 against a buyer's own ERP.
 *
 * Two grants, and the difference between them is who is present. Client
 * credentials is machine-to-machine: an SAP communication arrangement issues a
 * client id and secret, and this server exchanges them for a token whenever it
 * needs one, with nobody watching. Authorisation code with PKCE has a person in
 * the loop: the buyer is sent to their own ERP, signs in as themselves, sees
 * exactly which scopes are being asked for, and consents - which is the only
 * honest way to connect monday.com, where the thing being authorised is
 * somebody's own workspace.
 *
 * WHY PKCE ON A CONFIDENTIAL CLIENT
 *
 * This server holds a client secret, so RFC 6749 does not require PKCE. It is
 * used anyway, and the reason is the authorisation code itself: it travels
 * through a browser the buyer controls, past whatever extensions and logging
 * that browser has, and lands on a redirect URI over the public internet. A
 * code intercepted there is useless without the verifier, which never leaves
 * this process. It costs one hash.
 *
 * WHERE THE SECRETS LIVE
 *
 * Two different places, deliberately.
 *
 *   - For SAP and custom connections, the client id and secret are the
 *     BUYER's - issued by their own system to them - so they go in the vault
 *     under that connection, encrypted, and are shown as a hint and never
 *     returned.
 *   - For monday.com production connections, the app is registered by whoever
 *     runs this installation; every buyer authorises the same app. That secret
 *     is the OPERATOR's, it belongs in deployment configuration, and it must
 *     never be copied into a per-connection row where a tenant's export or a
 *     support screen could reach it. `oauthUsesPlatformApp` on the connection
 *     is the flag that says which of the two applies.
 *
 * The tokens that come back are the buyer's either way, and go in the vault.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict } from '../../domain/errors.js';
import { decryptSecret, encryptSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import {
  OutboundRequestError,
  assertSafeErpUrl,
  safeFetch,
} from '../../infra/outbound-http.js';
import {
  openCredential,
  saveCredential,
  type OAuthTokenCredential,
  type PrimaryCredential,
} from './credential.service.js';
import { ErpCallError, hostPolicy, safeErrorMessage } from './http.js';
import type { SystemName } from './connectors/types.js';

/**
 * Refresh this far before a token actually expires.
 *
 * Sixty seconds. A token that expires while a request is in flight produces a
 * 401 that looks like a credential problem, and the buyer is told to reconnect
 * something that was working perfectly.
 */
const EXPIRY_SKEW_MS = 60_000;

/** AAD for a PKCE verifier. Short-lived, and a secret for its whole life. */
function verifierAad(stateId: string): string {
  return `customer_erp_oauth_state:${stateId}`;
}

// ---------------------------------------------------------------------------
// The connection fields this module needs
// ---------------------------------------------------------------------------

export interface OAuthConnectionContext {
  id: string;
  organizationId: string;
  system: SystemName;
  authMethod: string;
  oauthAuthorizationUrl: string | null;
  oauthTokenUrl: string | null;
  oauthScope: string | null;
  oauthUsesPlatformApp: boolean;
  timeoutMs: number;
}

/**
 * The client id and secret to use for this connection.
 *
 * The one function that decides between the buyer's credentials and the
 * operator's registered app, so the decision is made once rather than at every
 * call site that could get it wrong in a way nobody would notice until a
 * buyer's client secret appeared in a support ticket.
 */
async function resolveClient(
  context: OAuthConnectionContext,
): Promise<{ clientId: string; clientSecret: string | null }> {
  if (context.oauthUsesPlatformApp) {
    if (env.MONDAY_OAUTH_CLIENT_ID.length === 0) {
      throw new ErpCallError(
        'This store has not registered a monday.com application, so a production ' +
          'monday connection cannot be authorised here.',
        'AUTH',
      );
    }

    return {
      clientId: env.MONDAY_OAUTH_CLIENT_ID,
      clientSecret: env.MONDAY_OAUTH_CLIENT_SECRET,
    };
  }

  const primary = await openCredential<PrimaryCredential>(context.id, 'PRIMARY');

  if (primary?.clientId === undefined) {
    throw new ErpCallError(
      'No client ID is configured for this connection.',
      'AUTH',
    );
  }

  return { clientId: primary.clientId, clientSecret: primary.clientSecret ?? null };
}

/**
 * The storefront route that finishes an authorisation.
 *
 * Declared here rather than in the frontend alone because both sides have to
 * agree on it: the page lives at this path in `apps/customer-web`, and this is
 * the address a buyer registers with their own ERP. Changing one without the
 * other breaks every authorisation at its last step.
 */
export const OAUTH_CALLBACK_PATH = '/account/integrations/erp/oauth/callback';

/**
 * Where an ERP sends the buyer back to. Registered by them, compared by us.
 *
 * A STOREFRONT page, and deliberately not this API. The ERP redirects a
 * BROWSER here with `code` and `state` in the query string; the page that
 * receives them POSTs them to the API on the buyer's own authenticated
 * session. Pointing this at the API instead sends that browser to a POST-only
 * route - a 404 at the end of an authorisation that otherwise worked - and
 * would put the authorisation code in this server's access log as a GET
 * parameter, which is the thing the POST callback exists to avoid.
 *
 * The value reaches the ERP twice: as `redirect_uri` on the authorisation URL,
 * and again on the token exchange, where a mismatch is usually rejected. It is
 * stored on the state row, so a deployment whose public address changes
 * mid-flow still redeems with the address it actually sent.
 */
export function redirectUri(): string {
  if (env.CUSTOMER_ERP_OAUTH_REDIRECT_URI.length > 0) {
    return env.CUSTOMER_ERP_OAUTH_REDIRECT_URI;
  }

  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`;
}

// ---------------------------------------------------------------------------
// Authorisation code with PKCE
// ---------------------------------------------------------------------------

export interface AuthorizationStart {
  /** Where to send the buyer's browser. */
  authorizationUrl: string;
  /** Echoed back so a screen can show what is being asked for. */
  scope: string;
  expiresAt: string;
}

/**
 * Begin an authorisation-code flow.
 *
 * Produces a `state` that proves the callback belongs to this flow and this
 * member, and a PKCE verifier that proves the code is redeemed by whoever asked
 * for it. Both live for the length of the flow and no longer.
 */
export async function startAuthorization(
  context: OAuthConnectionContext,
  startedByProfileId: string,
): Promise<AuthorizationStart> {
  if (context.oauthAuthorizationUrl === null) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_OAUTH_FAILED,
      'This connection has no authorisation address configured.',
      [{ field: 'oauthAuthorizationUrl', code: 'REQUIRED' }],
    );
  }

  // The address the buyer's browser is about to be sent to. Checked with the
  // same rules as every other address they type - a "sign in here" URL pointing
  // at an internal host is a phishing page hosted by their own supplier.
  const authorizationUrl = assertSafeErpUrlForOAuth(
    context.oauthAuthorizationUrl,
    'oauthAuthorizationUrl',
  );

  const stateId = newId();
  const stateToken = randomBytes(32).toString('base64url');
  // RFC 7636 allows 43-128 characters from an unreserved set; 32 random bytes
  // base64url-encoded is 43.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const expiresAt = new Date(Date.now() + env.CUSTOMER_ERP_OAUTH_STATE_TTL_SECONDS * 1000);
  const uri = redirectUri();

  await prisma.customerErpOAuthState.create({
    data: {
      id: stateId,
      connectionId: context.id,
      stateToken,
      codeVerifierEnc: encryptSecret(codeVerifier, verifierAad(stateId)),
      redirectUri: uri,
      startedByProfileId,
      expiresAt,
    },
  });

  const scope = context.oauthUsesPlatformApp
    ? env.MONDAY_OAUTH_SCOPES
    : (context.oauthScope ?? '');

  const { clientId } = await resolveClient(context);

  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('redirect_uri', uri);
  authorizationUrl.searchParams.set('state', stateToken);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  if (scope.length > 0) authorizationUrl.searchParams.set('scope', scope);

  return {
    authorizationUrl: authorizationUrl.toString(),
    scope,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Which connection a returning authorisation belongs to.
 *
 * The ERP sends back only what it was given - `code` and `state` - so the
 * connection has to be recovered from one of them, and `state` is the one this
 * server issued. Carrying it in the browser across a full-page redirect to a
 * third party instead would mean losing it whenever that third party opens the
 * callback in a new tab.
 *
 * This answers "which connection", and nothing else. The caller still loads
 * that connection through the tenant-scoped loader, and `completeAuthorization`
 * still re-checks the state against it - so a state token belonging to somebody
 * else's connection gets the caller no further than a 404.
 */
export async function connectionIdForState(stateToken: string): Promise<string> {
  const state = await prisma.customerErpOAuthState.findUnique({
    where: { stateToken },
    select: { connectionId: true },
  });

  if (state === null) {
    // The same words `completeAuthorization` refuses with, deliberately: an
    // unknown state and a stale one are the same problem to the buyer, and
    // telling them apart is a way to ask this server which tokens exist.
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_OAUTH_FAILED,
      'That authorisation could not be completed. Start it again from the connection.',
    );
  }

  return state.connectionId;
}

/**
 * Finish an authorisation-code flow.
 *
 * Four things have to hold, and all four are checked before a single byte is
 * sent to the token endpoint: the state exists, it has not been used, it has
 * not expired, and the member finishing the flow is the one who started it.
 *
 * That last one matters more than it looks. Without it, an authorisation URL
 * that leaked - forwarded, pasted into a ticket, logged by a proxy - would let
 * somebody else bind THEIR ERP account to THIS buyer's connection, and every
 * purchase order the buyer places afterwards would be raised in a stranger's
 * system.
 */
export async function completeAuthorization(input: {
  context: OAuthConnectionContext;
  stateToken: string;
  code: string;
  customerProfileId: string;
}): Promise<{ scope: string | null; expiresAt: Date | null }> {
  const state = await prisma.customerErpOAuthState.findUnique({
    where: { stateToken: input.stateToken },
  });

  // Annotated on the const rather than on the arrow, which is what lets
  // TypeScript treat a call to it as terminating a code path.
  const refuse: () => never = () => {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_OAUTH_FAILED,
      'That authorisation could not be completed. Start it again from the connection.',
    );
  };

  if (
    state === null ||
    state.consumedAt !== null ||
    state.expiresAt.getTime() <= Date.now() ||
    state.connectionId !== input.context.id
  ) {
    refuse();
  }

  // Constant-time, because this compares two identifiers and the loop that
  // does it otherwise leaks their common prefix length.
  const started = Buffer.from(state.startedByProfileId, 'utf8');
  const finishing = Buffer.from(input.customerProfileId, 'utf8');

  if (started.length !== finishing.length || !timingSafeEqual(started, finishing)) {
    refuse();
  }

  // Single use. A conditional update rather than a read-then-write, so two
  // simultaneous callbacks - a double-click, a browser prefetch - cannot both
  // redeem the same code.
  const claimed = await prisma.customerErpOAuthState.updateMany({
    where: { id: state.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (claimed.count === 0) refuse();

  let codeVerifier: string;
  try {
    codeVerifier = decryptSecret(state.codeVerifierEnc, verifierAad(state.id));
  } catch {
    refuse();
    throw new Error('unreachable');
  }

  const { clientId, clientSecret } = await resolveClient(input.context);

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: state.redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  if (clientSecret !== null && clientSecret.length > 0) {
    form.set('client_secret', clientSecret);
  }

  const token = await exchange(input.context, form);
  await storeTokens(input.context.id, token);

  return {
    scope: token.scope ?? null,
    expiresAt: token.expiresAtMs === undefined ? null : new Date(token.expiresAtMs),
  };
}

// ---------------------------------------------------------------------------
// Getting a usable access token
// ---------------------------------------------------------------------------

/**
 * A token that will still be valid when the request lands.
 *
 * The one entry point every caller uses. It caches - a client-credentials round
 * trip before every stock read would double both the traffic and the failure
 * surface - refreshes when it can, and raises a clear, non-retryable failure
 * when the only remedy is a person reauthorising.
 */
export async function getAccessToken(context: OAuthConnectionContext): Promise<string> {
  const stored = await openCredential<OAuthTokenCredential>(context.id, 'OAUTH_TOKENS');

  if (
    stored !== null &&
    (stored.expiresAtMs === undefined || stored.expiresAtMs - EXPIRY_SKEW_MS > Date.now())
  ) {
    return stored.accessToken;
  }

  if (stored?.refreshToken !== undefined) {
    const refreshed = await refresh(context, stored.refreshToken);
    return refreshed.accessToken;
  }

  if (context.authMethod === 'OAUTH2_CLIENT_CREDENTIALS') {
    const granted = await clientCredentials(context);
    return granted.accessToken;
  }

  // An authorisation-code connection whose access token has expired and which
  // has no refresh token. Nothing automatic can fix this, and pretending
  // otherwise means retrying a grant that will keep being refused.
  throw new ErpCallError(
    'The authorisation for this connection has expired. Reconnect it to authorise again.',
    'AUTH',
  );
}

/** The client-credentials grant. No person, no refresh token, no consent screen. */
export async function clientCredentials(
  context: OAuthConnectionContext,
): Promise<OAuthTokenCredential> {
  const { clientId, clientSecret } = await resolveClient(context);

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
  });

  if (clientSecret !== null && clientSecret.length > 0) {
    form.set('client_secret', clientSecret);
  }

  if (context.oauthScope !== null && context.oauthScope.length > 0) {
    form.set('scope', context.oauthScope);
  }

  const token = await exchange(context, form);
  await storeTokens(context.id, token);
  return token;
}

/**
 * Spend a refresh token.
 *
 * Rotation is assumed: a response that carries a new refresh token replaces the
 * old one, and a response that does not keeps it. Getting that backwards is how
 * an integration works for exactly one refresh cycle and then dies at three in
 * the morning.
 */
export async function refresh(
  context: OAuthConnectionContext,
  refreshToken: string,
): Promise<OAuthTokenCredential> {
  const { clientId, clientSecret } = await resolveClient(context);

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  if (clientSecret !== null && clientSecret.length > 0) {
    form.set('client_secret', clientSecret);
  }

  let token: OAuthTokenCredential;

  try {
    token = await exchange(context, form);
  } catch (error) {
    // A refused refresh is terminal: the grant has been revoked at the other
    // end, or it expired. Reported as AUTH so the dispatcher stops rather than
    // spending six attempts on it, and so the connection moves to
    // ACTION_REQUIRED with something the buyer can actually act on.
    logger.warn(
      { connectionId: context.id, reason: safeErrorMessage(error) },
      'a buyer ERP refresh token was refused',
    );

    throw new ErpCallError(
      'Your system would not renew our authorisation. Reconnect it to authorise again.',
      'AUTH',
    );
  }

  const merged: OAuthTokenCredential = {
    ...token,
    refreshToken: token.refreshToken ?? refreshToken,
  };

  await storeTokens(context.id, merged);
  return merged;
}

/**
 * Forget the tokens.
 *
 * Called on disconnect and when a buyer presses Revoke. Best-effort revocation
 * at the ERP first, where it offers an endpoint, and then local destruction
 * regardless: an ERP that ignores the revocation must not leave us holding a
 * working token for it.
 */
export async function revokeTokens(context: OAuthConnectionContext): Promise<void> {
  await prisma.customerErpCredential
    .delete({ where: { connectionId_kind: { connectionId: context.id, kind: 'OAUTH_TOKENS' } } })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * POST to the token endpoint and make sense of what comes back.
 *
 * `application/x-www-form-urlencoded`, because that is what RFC 6749 says and
 * what every server actually implements, whatever its documentation claims
 * about JSON.
 */
async function exchange(
  context: OAuthConnectionContext,
  form: URLSearchParams,
): Promise<OAuthTokenCredential> {
  if (context.oauthTokenUrl === null) {
    throw new ErpCallError('This connection has no token address configured.', 'AUTH');
  }

  const url = assertSafeErpUrlForOAuth(context.oauthTokenUrl, 'oauthTokenUrl');

  let response;

  try {
    response = await safeFetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'UBOSS-Customer-ERP/1.0',
      },
      body: form.toString(),
      timeoutMs: context.timeoutMs,
      field: 'oauthTokenUrl',
      errorCode: ErrorCode.CUSTOMER_ERP_OAUTH_FAILED,
      ...(hostPolicy() === undefined ? {} : { allowedHostSuffixes: hostPolicy() }),
    });
  } catch (error) {
    if (error instanceof OutboundRequestError) {
      throw new ErpCallError(safeErrorMessage(error), 'TRANSPORT');
    }
    throw error;
  }

  let parsed: TokenResponse | null;
  try {
    parsed = JSON.parse(response.bodyText) as TokenResponse;
  } catch {
    parsed = null;
  }

  if (response.status >= 400 || parsed === null) {
    // The `error` field is from RFC 6749 and is a short machine token -
    // `invalid_grant`, `invalid_client` - which is safe and genuinely useful.
    // `error_description` is free text from somebody else's server and is not
    // passed through.
    const code =
      typeof parsed?.error === 'string' && /^[a-z_]{1,40}$/.test(parsed.error)
        ? parsed.error
        : null;

    throw new ErpCallError(
      code === null
        ? `Your system refused the authorisation (HTTP ${response.status}).`
        : `Your system refused the authorisation: ${code}.`,
      response.status === 401 || response.status === 400 ? 'AUTH' : 'SERVER',
      response.status,
    );
  }

  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new ErpCallError(
      'Your system answered the authorisation without an access token.',
      'UNUSABLE',
      response.status,
    );
  }

  const expiresIn =
    typeof parsed.expires_in === 'number'
      ? parsed.expires_in
      : typeof parsed.expires_in === 'string' && /^\d+$/.test(parsed.expires_in)
        ? Number.parseInt(parsed.expires_in, 10)
        : null;

  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === 'string'
      ? { refreshToken: parsed.refresh_token }
      : {}),
    ...(typeof parsed.token_type === 'string' ? { tokenType: parsed.token_type } : {}),
    ...(expiresIn === null
      ? {}
      : // Capped at a year. A server claiming a decade is misconfigured, and
        // caching a token for a decade is how a revoked grant keeps working.
        { expiresAtMs: Date.now() + Math.min(expiresIn, 31_536_000) * 1000 }),
    ...(typeof parsed.scope === 'string' ? { scope: parsed.scope } : {}),
  };
}

async function storeTokens(
  connectionId: string,
  token: OAuthTokenCredential,
): Promise<void> {
  await saveCredential({
    connectionId,
    kind: 'OAUTH_TOKENS',
    payload: token,
    expiresAt: token.expiresAtMs === undefined ? null : new Date(token.expiresAtMs),
    grantedScope: token.scope ?? null,
  });
}

/**
 * The address checks, with the OAuth error code attached.
 *
 * A separate helper only so the two OAuth URLs are refused with
 * `CUSTOMER_ERP_OAUTH_FAILED` rather than with the base-URL code - the buyer's
 * screen renders a different message for each, and the difference is "check the
 * address you typed" against "check the address your ERP gave you".
 */
function assertSafeErpUrlForOAuth(rawUrl: string, field: string): URL {
  return assertSafeErpUrl(rawUrl, {
    field,
    errorCode: ErrorCode.CUSTOMER_ERP_URL_NOT_ALLOWED,
    ...(hostPolicy() === undefined ? {} : { allowedHostSuffixes: hostPolicy() as string[] }),
  });
}

/**
 * Sweep OAuth flows nobody finished.
 *
 * Rows here hold an encrypted PKCE verifier and a member id. Neither is
 * dangerous on its own and neither has any use once the window has closed, and
 * a table of abandoned authorisation attempts is a table somebody eventually
 * has to explain.
 */
export async function purgeExpiredOAuthStates(): Promise<number> {
  const result = await prisma.customerErpOAuthState.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 3_600_000) } },
  });

  return result.count;
}

/** Refuse a flow the connection is not set up for, with a message that helps. */
export function assertOAuthConfigured(context: OAuthConnectionContext): void {
  if (
    context.authMethod !== 'OAUTH2_AUTHORIZATION_CODE' &&
    context.authMethod !== 'OAUTH2_CLIENT_CREDENTIALS'
  ) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_OAUTH_FAILED,
      'This connection does not use OAuth, so there is nothing to authorise.',
    );
  }
}
