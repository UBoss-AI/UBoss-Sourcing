/**
 * Who in the Audit Console hears about an inspection job, and when.
 *
 *   offered        → the agency's admins and coordinators;
 *   assigned       → the named inspector (and backup);
 *   submitted      → the agency's QA reviewers;
 *   returned       → the named inspector;
 *   signed FAIL /
 *   INCONCLUSIVE   → the agency's coordinators and the marketplace's audit
 *                    supervisors, because goods are now held.
 *
 * Called after the job service's own transaction commits, from the job's
 * current state, so a notice always describes something that happened. A
 * notice that fails to write never undoes the action.
 */
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { agencyUserIds, memberUserId, notifyAuditUsers, staffUserIds } from './notification.service.js';

async function safely(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.warn({ err: error }, 'could not write an Audit Console notification');
  }
}

export async function notifyJobOffered(jobId: string): Promise<void> {
  await safely(async () => {
    const job = await prisma.inspectionJob.findUnique({ where: { id: jobId }, select: { agencyId: true, jobNumber: true, scheduledFor: true } });
    if (job === null) return;
    await notifyAuditUsers(prisma, await agencyUserIds(prisma, job.agencyId, ['AGENCY_ADMIN', 'COORDINATOR']), {
      kind: 'JOB_OFFERED',
      title: `New inspection ${job.jobNumber} offered for ${job.scheduledFor.toISOString().slice(0, 10)}`,
      link: `/jobs/${jobId}`,
      subjectType: 'inspection_job',
      subjectId: jobId,
      dedupeKey: `job-offered:${jobId}`,
    });
  });
}

/** After an agency action on a job: tell whoever the job's new state concerns. */
export async function notifyAfterJobAction(jobId: string, action: string): Promise<void> {
  await safely(async () => {
    const job = await prisma.inspectionJob.findUnique({
      where: { id: jobId },
      select: {
        agencyId: true,
        jobNumber: true,
        status: true,
        version: true,
        inspectorMemberId: true,
        backupInspectorMemberId: true,
        reports: { orderBy: { revision: 'desc' }, take: 1, select: { id: true, result: true, status: true, returnReason: true } },
      },
    });
    if (job === null) return;
    const link = `/jobs/${jobId}`;
    const report = job.reports[0];

    if (action === 'assign') {
      const inspectors = [...(await memberUserId(prisma, job.inspectorMemberId)), ...(await memberUserId(prisma, job.backupInspectorMemberId))];
      await notifyAuditUsers(prisma, inspectors, {
        kind: 'JOB_ASSIGNED',
        title: `You are named on inspection ${job.jobNumber}`,
        body: 'Declare any conflict of interest before you start.',
        link,
        subjectType: 'inspection_job',
        subjectId: jobId,
        dedupeKey: `job-assigned:${jobId}:${String(job.version)}`,
      });
    } else if (action === 'report/submit') {
      await notifyAuditUsers(prisma, await agencyUserIds(prisma, job.agencyId, ['QA_REVIEWER']), {
        kind: 'REPORT_SUBMITTED',
        title: `Report for ${job.jobNumber} is waiting for QA review`,
        link,
        subjectType: 'inspection_job',
        subjectId: jobId,
        dedupeKey: `report-submitted:${report?.id ?? jobId}`,
      });
    } else if (action === 'report/return') {
      const inspectors = [...(await memberUserId(prisma, job.inspectorMemberId)), ...(await memberUserId(prisma, job.backupInspectorMemberId))];
      await notifyAuditUsers(prisma, inspectors, {
        kind: 'REPORT_RETURNED',
        title: `QA returned the report for ${job.jobNumber}`,
        body: report?.returnReason ?? null,
        link,
        subjectType: 'inspection_job',
        subjectId: jobId,
        dedupeKey: `report-returned:${report?.id ?? jobId}`,
      });
    } else if (action === 'report/sign' && report !== undefined && report.result !== 'PASS') {
      const recipients = [
        ...(await agencyUserIds(prisma, job.agencyId, ['AGENCY_ADMIN', 'COORDINATOR'])),
        ...(await staffUserIds(prisma, ['SUPERVISOR'])),
      ];
      await notifyAuditUsers(prisma, recipients, {
        kind: report.result === 'FAIL' ? 'INSPECTION_FAILED' : 'INSPECTION_INCONCLUSIVE',
        title: `${job.jobNumber} signed ${report.result === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE'} - the goods are held`,
        body: 'Corrective action and a re-inspection are needed before the goods can leave.',
        link,
        subjectType: 'inspection_job',
        subjectId: jobId,
        dedupeKey: `report-held:${report.id}`,
      });
    }
  });
}
