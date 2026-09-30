import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import { InspectionRequirementPage } from './InspectionConsolePages';

let manage=true;
vi.mock('@/auth/session-context',()=>({useSession:()=>({can:()=>manage})}));
vi.mock('react-router-dom',async original=>({...await original<typeof import('react-router-dom')>(),useParams:()=>({id:'R'})}));
vi.mock('@/lib/api',async original=>{const actual=await original<typeof import('@/lib/api')>();return {...actual,api:{...actual.api,get:vi.fn(),post:vi.fn()}};});
const original={id:'J',jobNumber:'INS-1',status:'COMPLETED',agency:{name:'QA'},scheduledFor:null,report:{status:'SIGNED',result:'FAIL'},defects:[{status:'CAPA_SUBMITTED'}],reinspectionOfJobId:null};
const detail={requirement:{id:'R',orderNumber:'ORD-1',sellerName:'Acme',sellerOrderGroupId:'G',level:'MANDATORY',status:'FAILED',reason:null,ruleName:null,gate:{sentence:'Blocked'}},jobs:[original],releases:[],timeline:[]};
function show():void {
 render(<I18nextProvider i18n={i18n}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><ToastProvider><MemoryRouter><InspectionRequirementPage /></MemoryRouter></ToastProvider></QueryClientProvider></I18nextProvider>);
}
beforeEach(async()=>{
 await i18n.changeLanguage('en'); vi.clearAllMocks(); manage=true;
 vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[{id:'A',name:'QA'}]}:{inspection:detail}));
 vi.mocked(api.post).mockResolvedValue({});
});
function fillBooking():void {
 fireEvent.change(screen.getByLabelText('Agency'),{target:{value:'A'}});
 fireEvent.change(screen.getByLabelText('Date and time'),{target:{value:'2026-10-05T10:00'}});
 fireEvent.change(screen.getByLabelText('City'),{target:{value:'Pune'}});
 fireEvent.change(screen.getByLabelText('Country (2 letters)'),{target:{value:'IN'}});
}
describe('linked re-inspection booking',()=>{
 it('requires an original failed inspection and sends its id with the booking',async()=>{
  show(); await screen.findByText('ORD-1'); fillBooking();
  expect(screen.getByRole('button',{name:'Book inspection'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Original inspection'),{target:{value:'J'}});
  fireEvent.click(screen.getByRole('button',{name:'Book inspection'}));
  await waitFor(()=>{expect(api.post).toHaveBeenCalledWith('/admin/inspection/jobs',expect.objectContaining({sellerOrderGroupId:'G',reinspectionOfJobId:'J',agencyId:'A',payer:'BUYER'}),expect.any(Object));});
  expect(typeof vi.mocked(api.post).mock.calls[0]?.[2]?.idempotencyKey).toBe('string');
 });
 it('blocks booking until every open finding has corrective action',async()=>{
  vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[]}:{inspection:{...detail,jobs:[{...original,defects:[{status:'OPEN'}]}]}}));
  show(); expect(await screen.findByText('Corrective action is required for every open finding before re-inspection.')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Book inspection'})).toBeDisabled();
 });
 it('omits booking controls for a reader',async()=>{
  manage=false;show();await screen.findByText('ORD-1');
  expect(screen.queryByRole('button',{name:'Book inspection'})).not.toBeInTheDocument();
 });
 it('displays the original inspection link on a repeat job',async()=>{
  vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[]}:{inspection:{...detail,jobs:[original,{...original,id:'J2',jobNumber:'INS-2',status:'REQUESTED',report:null,reinspectionOfJobId:'J'}]}}));
  show();expect(await screen.findByText(/Original inspection: INS-1/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Book inspection'})).toBeDisabled();
 });
});
