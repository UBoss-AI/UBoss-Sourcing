/**
 * What the About page says, as data: which capabilities it shows, which
 * people it names, and which of the story's paragraphs apply here.
 *
 * Kept apart from the layout for one reason: **the page may only describe
 * what this deployment actually does.** Three of the capabilities are switched
 * on and off per deployment - the AI assistant, company accounts and repeat
 * purchases - and an About page that promised a company account on a
 * storefront with company accounts off would be the one page on the site that
 * lies. So every entry that depends on a switch names it, and the functions
 * below decide from the live config, not from the copy.
 *
 * What is NOT here: numbers. No customer counts, no countries served, no
 * delivery times. This software is run by whoever bought it, and a figure
 * written into the product is a claim about somebody else's business.
 */
import {
  BoxIcon,
  BuildingIcon,
  FlowIcon,
  GlobeIcon,
  RepeatIcon,
  ShieldIcon,
  SparkIcon,
  TruckIcon,
} from '@/components/icons';
import type { StorefrontConfig } from '@/lib/types';

type Features = StorefrontConfig['features'];

export type AboutCapabilityKey =
  | 'assistant'
  | 'companies'
  | 'sellers'
  | 'bulk'
  | 'logistics'
  | 'secure'
  | 'schedules'
  | 'markets';

export interface AboutCapability {
  key: AboutCapabilityKey;
  icon: (props: { className?: string }) => React.JSX.Element;
  /** The switch this card depends on, or null when it is always built. */
  enabled: (features: Features) => boolean;
}

/**
 * Every capability the page can show, in the order it prefers them.
 *
 * The first six that apply are shown. With every switch on, that is the six
 * the page was designed around; with one off, the next always-true entry
 * takes its place, so the grid stays full without inventing anything.
 */
export const ABOUT_CAPABILITIES: readonly AboutCapability[] = [
  { key: 'assistant', icon: SparkIcon, enabled: (features) => features.assistant },
  {
    key: 'companies',
    icon: BuildingIcon,
    enabled: (features) => features.buyerCompanies === true,
  },
  { key: 'sellers', icon: ShieldIcon, enabled: () => true },
  { key: 'bulk', icon: BoxIcon, enabled: () => true },
  { key: 'logistics', icon: TruckIcon, enabled: () => true },
  { key: 'secure', icon: FlowIcon, enabled: () => true },
  { key: 'schedules', icon: RepeatIcon, enabled: (features) => features.recurringOrders },
  { key: 'markets', icon: GlobeIcon, enabled: () => true },
];

/** How many cards the grid holds: two rows of three. */
export const ABOUT_CAPABILITY_LIMIT = 6;

export function aboutCapabilities(features: Features): AboutCapability[] {
  return ABOUT_CAPABILITIES.filter((capability) => capability.enabled(features)).slice(
    0,
    ABOUT_CAPABILITY_LIMIT,
  );
}

export function capabilityTitleKey(
  key: AboutCapabilityKey,
): `about.capability.${AboutCapabilityKey}.title` {
  return `about.capability.${key}.title`;
}

export function capabilityBodyKey(
  key: AboutCapabilityKey,
): `about.capability.${AboutCapabilityKey}.body` {
  return `about.capability.${key}.body`;
}

export type AboutRoleKey = 'buyers' | 'companies' | 'sellers' | 'warehouses' | 'logistics' | 'team';

/** The people the marketplace connects, as the media panel draws them. */
export function aboutRoles(features: Features): AboutRoleKey[] {
  return [
    'buyers',
    ...(features.buyerCompanies === true ? (['companies'] as const) : []),
    'sellers',
    'warehouses',
    'logistics',
    'team',
  ];
}

export type AboutStoryKey =
  | 'buyers'
  | 'companies'
  | 'bulk'
  | 'sellers'
  | 'fulfilment'
  | 'assistant'
  | 'erp';

/**
 * The "What we do" paragraphs that apply here, in reading order: who buys,
 * how larger needs are met, who sells, who delivers, and what takes the
 * friction out.
 */
export function aboutStory(features: Features): AboutStoryKey[] {
  return [
    'buyers',
    ...(features.buyerCompanies === true ? (['companies'] as const) : []),
    'bulk',
    'sellers',
    'fulfilment',
    ...(features.assistant ? (['assistant'] as const) : []),
    'erp',
  ];
}

/**
 * Where the i-th of n groups sits on the orbit, as percentages of the stage.
 *
 * An ellipse, narrower than it is tall: a group's label is wider than it is
 * high, so the ones at the sides need more room from the edge than the ones at
 * the top and bottom. The first group is at twelve o'clock.
 */
export function orbitPosition(index: number, count: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
  return {
    x: Math.round((50 + 30 * Math.cos(angle)) * 100) / 100,
    y: Math.round((50 + 38 * Math.sin(angle)) * 100) / 100,
  };
}
