import { buildApp } from '../../../backend/src/http/app.js';
import { totpCodeAt } from '../../../backend/src/infra/totp.js';
import { as, buildRfqWorld, submitted } from '../../../backend/tests/support/rfq-fixture.js';

async function main(): Promise<void> {
const prefix = 'row21ui-';
const app = await buildApp();
await app.ready();
const world = await buildRfqWorld(app, prefix);
const sent = await submitted(world);
const setupResponse = await as(world, world.sellers.alpha.owner, 'POST', '/auth/mfa/setup');
if (setupResponse.statusCode !== 200) throw new Error(setupResponse.body);
const setup = setupResponse.json<{ secret: string }>();
const confirmResponse = await as(world, world.sellers.alpha.owner, 'POST', '/auth/mfa/confirm', {
  code: totpCodeAt(setup.secret, Date.now()),
});
if (confirmResponse.statusCode !== 200) throw new Error(confirmResponse.body);
const quoteResponse = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, {
  currency: 'INR',
  unitPriceMinor: '90000',
  quantity: '12000',
  moq: '5000',
  leadTimeDays: 25,
  incoterm: 'CIF',
  incotermPlace: 'Nhava Sheva',
  paymentTerms: '20% advance, balance against shipping documents',
  inspectionTerms: 'SGS pre-shipment inspection',
  toolingMinor: '250000',
  shippingEstimateMinor: '125000',
  taxesDisclosure: 'Tax is calculated separately at checkout.',
  warranty: '18 months from delivery',
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
});
if (quoteResponse.statusCode !== 201) throw new Error(quoteResponse.body);
const quote = quoteResponse.json<{ quote: { id: string; current: { id: string; termsHash: string } } }>().quote;
const acceptResponse = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${quote.id}/accept`, {
  versionId: quote.current.id,
  termsHash: quote.current.termsHash,
});
if (acceptResponse.statusCode !== 200) throw new Error(acceptResponse.body);
process.stdout.write(JSON.stringify({ rfqId: sent.id, email: world.buyer.email, password: 'RfqFixture!2026x' }));
await app.close();
}

void main();
