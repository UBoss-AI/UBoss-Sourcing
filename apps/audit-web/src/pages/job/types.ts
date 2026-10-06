/**
 * What every section of the inspection workspace is handed.
 *
 * The page decides who may do what ONCE, from the server's own answer
 * (`me.isNamedInspector`, the job status) and the session's permissions, and
 * hands the sections the result. A section never re-derives it. The server
 * checks every one of these again on every write; this only decides which
 * buttons a person is shown.
 */
import type { JobDetail } from '@/lib/console-types';

export interface WorkspaceMode {
  /** An agency member viewing (writes go to /audit/agency). False for audit staff. */
  agency: boolean;
  /** The named (or backup) inspector, holding inspection.job.perform. */
  namedInspector: boolean;
  /** The named inspector, on a job that is IN_PROGRESS: may record findings now. */
  performing: boolean;
  /** Holds inspection.report.sign (QA), and is not this job's inspector. */
  qa: boolean;
  /** Holds inspection.job.accept / inspection.job.assign. */
  coordinator: boolean;
  /** Audit staff with oversight (read-only, plus sub-lot requests for a supervisor). */
  staff: boolean;
}

export interface SectionProps {
  detail: JobDetail;
  jobId: string;
  mode: WorkspaceMode;
}
