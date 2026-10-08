/**
 * A turnover declaration for a test seller, for suites that need a seller to
 * get past the turnover eligibility policy without being about it.
 *
 * `VERIFIED` by default, because approval needs a reviewer's verification -
 * a test that approves a seller would otherwise be refused for a reason it is
 * not testing. The figure is one paisa above the default minimum, for the
 * most recently completed April-March year.
 */
import type { SellerVerificationState } from '../../src/generated/prisma/enums.js';
import { mostRecentFinancialYear, parseIsoDate } from '../../src/domain/seller-turnover.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

export async function seedTurnover(
  sellerAccountId: string,
  verificationState: SellerVerificationState = 'VERIFIED',
): Promise<void> {
  const year = mostRecentFinancialYear(4, new Date());
  await prisma.sellerTurnoverDeclaration.updateMany({
    where: { sellerAccountId, isCurrent: true },
    data: { isCurrent: false, supersededReason: 'AMENDED' },
  });
  await prisma.sellerTurnoverDeclaration.create({
    data: {
      id: newId(),
      sellerAccountId,
      amountMinor: 30_000_000_001n,
      currency: 'INR',
      financialYearStart: parseIsoDate(year.start) as Date,
      financialYearEnd: parseIsoDate(year.end) as Date,
      minimumMinor: 30_000_000_000n,
      policyVersion: 'test',
      declaredAt: new Date(),
      verificationState,
      ...(verificationState === 'VERIFIED'
        ? { decisionReason: 'Verified for the test.', reviewedAt: new Date() }
        : {}),
      isCurrent: true,
    },
  });
}
