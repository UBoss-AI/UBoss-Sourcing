/**
 * A seller's verification report, section by section.
 *
 * Laid out the way Alibaba.com lays out a Verified Supplier assessment report
 * (legal status, certifications, production, quality management): one line
 * per area, each with a plain state and the facts behind it. Every state is
 * read from data the seller page already holds; nothing is decided here that
 * a reviewer has not decided somewhere in the console or the Admin Panel.
 *
 * "Verified" overall means the three areas a buyer relies on most - business
 * identity, sanctions screening and certifications - are each verified, and
 * no area needs attention. It is a summary of decisions, not a new one.
 */
import type { SellerDetail } from './console-types';

export type SectionState = 'VERIFIED' | 'ATTENTION' | 'PENDING' | 'DECLARED' | 'NOT_ASSESSED';
export type SectionKey = 'identity' | 'screening' | 'sites' | 'certifications' | 'qualifications' | 'quality';

export interface ReportSection {
  key: SectionKey;
  state: SectionState;
  /** Counts behind the state, for the line under it. */
  facts: Record<string, number>;
}

const OPEN_CASE = ['REQUESTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED'];
const PENDING_DOCUMENT = ['SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED'];

export function verificationReport(detail: SellerDetail): { sections: ReportSection[]; verified: boolean } {
  const checks = detail.businessIdentity.checks;
  const identity: SectionState =
    checks.length === 0
      ? 'NOT_ASSESSED'
      : checks.some((check) => check.state === 'REJECTED' || check.state === 'EXPIRED')
        ? 'ATTENTION'
        : checks.every((check) => check.state === 'VERIFIED')
          ? 'VERIFIED'
          : 'PENDING';

  const latestScreening = detail.businessIdentity.screening[0]?.state;
  const screening: SectionState =
    latestScreening === undefined
      ? 'NOT_ASSESSED'
      : latestScreening === 'CLEAR'
        ? 'VERIFIED'
        : latestScreening === 'PENDING_REVIEW'
          ? 'PENDING'
          : 'ATTENTION';

  const documents = detail.documents.filter((row) => row.supersededAt === null);
  const approved = documents.filter((row) => row.reviewStatus === 'APPROVED').length;
  const lapsed = documents.filter((row) => ['SUSPENDED', 'EXPIRED', 'REJECTED'].includes(row.reviewStatus)).length;
  const waiting = documents.filter((row) => PENDING_DOCUMENT.includes(row.reviewStatus)).length;
  const certifications: SectionState = lapsed > 0 ? 'ATTENTION' : approved > 0 ? 'VERIFIED' : waiting > 0 ? 'PENDING' : 'NOT_ASSESSED';

  const categoryCases = detail.cases.filter((row) => row.level === 'SELLER_CATEGORY');
  const qualified = categoryCases.filter((row) => row.status === 'QUALIFIED').length;
  const troubled = categoryCases.filter((row) => ['SUSPENDED', 'EXPIRED', 'REREVIEW_REQUIRED'].includes(row.status)).length;
  const open = categoryCases.filter((row) => OPEN_CASE.includes(row.status)).length;
  const qualifications: SectionState = troubled > 0 ? 'ATTENTION' : qualified > 0 ? 'VERIFIED' : open > 0 ? 'PENDING' : 'NOT_ASSESSED';

  const record = detail.health.inspection;
  const quality: SectionState =
    record.reports === 0 ? 'NOT_ASSESSED' : record.meetsTarget === null ? 'PENDING' : record.meetsTarget ? 'VERIFIED' : 'ATTENTION';

  const sections: ReportSection[] = [
    { key: 'identity', state: identity, facts: { checks: checks.length, verified: checks.filter((check) => check.state === 'VERIFIED').length } },
    { key: 'screening', state: screening, facts: {} },
    { key: 'sites', state: detail.factories.length > 0 ? 'DECLARED' : 'NOT_ASSESSED', facts: { sites: detail.factories.length } },
    { key: 'certifications', state: certifications, facts: { approved, lapsed, waiting } },
    { key: 'qualifications', state: qualifications, facts: { qualified, troubled, open } },
    { key: 'quality', state: quality, facts: { reports: record.reports, passed: record.passed } },
  ];

  const verified = identity === 'VERIFIED' && screening === 'VERIFIED' && certifications === 'VERIFIED' && sections.every((section) => section.state !== 'ATTENTION');
  return { sections, verified };
}
