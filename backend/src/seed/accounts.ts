/**
 * The accounts the development seed creates.
 *
 * They live here rather than in `index.ts` because `index.ts` calls `main()` at
 * the bottom: importing it to read the list would run the entire seed as a side
 * effect. `rotate-seed-passwords.cli.ts` needs the same list and must not do
 * that, so the list moved and both import it.
 *
 * The passwords below are the ones a fresh clone starts with. They are in git
 * on purpose - SETUP.md prints them, and a development environment nobody can
 * sign into is worse than one with obvious credentials. They are also the
 * reason `npm run db:rotate-seed-passwords` exists: the moment an installation
 * is reachable by anybody else, a credential published in a repository is not a
 * credential.
 */
import { Role } from '../domain/permissions.js';

/**
 * Seed credentials. Deliberately long enough to satisfy the 12-character
 * policy, and deliberately obvious so nobody mistakes them for real ones.
 */
export const SEED_ACCOUNTS = [
  { email: 'owner@uboss.local', name: 'Priya Nair', role: Role.BUSINESS_OWNER, password: 'OwnerDev!2026' },
  { email: 'catalog@uboss.local', name: 'Arun Mehta', role: Role.CATALOG_MANAGER, password: 'CatalogDev!2026' },
  { email: 'inventory@uboss.local', name: 'Sana Qureshi', role: Role.INVENTORY_MANAGER, password: 'StockDev!2026' },
  { email: 'orders@uboss.local', name: 'Ravi Menon', role: Role.ORDER_MANAGER, password: 'OrdersDev!2026' },
  { email: 'finance@uboss.local', name: 'Neha Kulkarni', role: Role.FINANCE_APPROVER, password: 'FinanceDev!2026' },
] as const;

export const SEED_CUSTOMERS = [
  {
    email: 'buyer@acme.local',
    name: 'Deepak Sharma',
    organization: 'Acme Manufacturing Pvt Ltd',
    department: 'Procurement',
    password: 'BuyerDev!2026',
    // Active, so it can be signed into immediately.
    active: true,
  },
  {
    email: 'invited@zenith.local',
    name: 'Fatima Sheikh',
    organization: 'Zenith Labs',
    department: 'Operations',
    password: null,
    // Left PENDING_INVITATION on purpose: exercises the activation flow.
    active: false,
  },
] as const;
