/**
 * The operator's team and the marketplace are two names.
 *
 * A storefront can trade as one name and answer preorder chats as a team with
 * another - "Chat with Glovia", answered by "the UBoss team". Sentences about
 * the people who answer say `{{team}}`; sentences about the platform say
 * `{{marketplace}}`. With no team name set, the team is the marketplace.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { i18n, setTeamName, setMarketplaceName } from './config';

afterEach(() => {
  setMarketplaceName(null);
  setTeamName(null);
});

describe('the chat team’s name', () => {
  it('names the team without renaming the marketplace', () => {
    setMarketplaceName('Glovia');
    setTeamName('UBoss');
    expect(i18n.t('preorderChat.availability.available')).toBe('UBoss team is available');
    expect(i18n.t('preorderChat.team.name')).toBe('UBoss Preorder Team');
    expect(i18n.t('preorderChat.system.status.closed')).toBe('UBoss closed this conversation.');
    expect(i18n.t('preorderChat.title')).toBe('Chat with Glovia');
    expect(i18n.t('preorderChat.safety')).toContain('inside Glovia');
    // Who manages a delivery level is the same team.
    expect(i18n.t('sellerLogistics.mode.UBOSS')).toBe('UBoss');
    expect(i18n.t('sellerLogistics.mode.HYBRID')).toBe('Self + UBoss');
    expect(i18n.t('sellerLogistics.mode.SELF')).toBe('Self Ship');
  });

  it('is the marketplace’s own name when none is set', () => {
    setMarketplaceName('Northwind');
    setTeamName('');
    expect(i18n.t('preorderChat.availability.available')).toBe('Northwind team is available');
    expect(i18n.t('preorderChat.title')).toBe('Chat with Northwind');
  });
});
