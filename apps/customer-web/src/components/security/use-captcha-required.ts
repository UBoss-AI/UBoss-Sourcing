import { useStorefront } from '@/app/storefront-context';

/** Whether the store has a bot check on, so a form can require the token. */
export function useCaptchaRequired(): boolean {
  const { captcha } = useStorefront();
  return captcha !== undefined && captcha.provider !== 'off' && captcha.siteKey !== null;
}
