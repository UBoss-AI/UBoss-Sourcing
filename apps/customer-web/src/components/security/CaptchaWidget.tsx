/**
 * The bot check on the public forms, when the store has one switched on.
 *
 * Renders nothing while `captcha.provider` is `off` (the default, and what a
 * laptop runs), so every form it sits in works exactly as before. With
 * `turnstile` or `hcaptcha` it loads that provider's script once, draws its
 * widget, and reports the token it produces - or null when the token expires,
 * so the form never sends a stale one.
 *
 * The provider's script is the only third-party code this adds, and only on a
 * deployment that asked for it. The operator also adds the provider's domain
 * to the Content-Security-Policy (see README, "Going live").
 */
import { useEffect, useRef } from 'react';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';

interface WidgetApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string | number;
  remove?: (id: string | number) => void;
}

declare global {
  interface Window {
    turnstile?: WidgetApi;
    hcaptcha?: WidgetApi;
  }
}

const SCRIPTS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
} as const;

const loading = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let promise = loading.get(src);
  if (promise === undefined) {
    promise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => {
        resolve();
      };
      script.onerror = () => {
        loading.delete(src);
        reject(new Error('captcha script failed to load'));
      };
      document.head.appendChild(script);
    });
    loading.set(src, promise);
  }
  return promise;
}

export function CaptchaWidget({ onToken }: { onToken: (token: string | null) => void }): React.JSX.Element | null {
  const { captcha } = useStorefront();
  const { t, language } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const report = useRef(onToken);
  report.current = onToken;

  const provider = captcha?.provider ?? 'off';
  const siteKey = captcha?.siteKey ?? null;

  useEffect(() => {
    if (provider === 'off' || siteKey === null || host.current === null) return;
    const element = host.current;
    let widgetId: string | number | null = null;
    let cancelled = false;

    void loadScript(SCRIPTS[provider])
      .then(() => {
        const widgets = provider === 'turnstile' ? window.turnstile : window.hcaptcha;
        if (cancelled || widgets === undefined) return;
        widgetId = widgets.render(element, {
          sitekey: siteKey,
          // Both providers accept a language hint; the form is in this one.
          language,
          hl: language,
          callback: (token: string) => {
            report.current(token);
          },
          'expired-callback': () => {
            report.current(null);
          },
          'error-callback': () => {
            report.current(null);
          },
        });
      })
      .catch(() => {
        report.current(null);
      });

    return () => {
      cancelled = true;
      const widgets = provider === 'turnstile' ? window.turnstile : window.hcaptcha;
      if (widgetId !== null) widgets?.remove?.(widgetId);
    };
  }, [provider, siteKey, language]);

  if (provider === 'off' || siteKey === null) return null;

  return (
    <div className="space-y-1">
      <div ref={host} data-testid="captcha-widget" />
      <p className="text-xs text-ink-muted">{t('security.captcha.hint')}</p>
    </div>
  );
}
