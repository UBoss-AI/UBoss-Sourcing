/**
 * One qualification case (also reached from a seller's page and a
 * notification). The detail itself lives in `compliance/CaseDetailView`, so
 * a product case shows exactly the same screen.
 */
import { useParams } from 'react-router-dom';
import { useI18n } from '@/i18n/i18n-context';
import { CaseDetailView } from './compliance/CaseDetailView';

export function CasePage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams();

  return <CaseDetailView caseId={id} back={{ to: '/sellers', label: t('screens.caseDetail.back') }} />;
}
