import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { InspectionRequirementPage, SubLotReleasesPanel } from './InspectionConsolePages';

let manage=true;
vi.mock('@/auth/session-context',()=>({useSession:()=>({can:()=>manage})}));
vi.mock('react-router-dom',async original=>({...await original<typeof import('react-router-dom')>(),useParams:()=>({id:'R'})}));
vi.mock('@/lib/api',async original=>{const actual=await original<typeof import('@/lib/api')>();return {...actual,api:{...actual.api,get:vi.fn(),post:vi.fn(),upload:vi.fn()},downloadFile:vi.fn()};});
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

describe('conditional releases',()=>{
 const pending={id:'REL',kind:'CONDITIONAL',state:'PENDING_APPROVAL',requestedByLabel:'ops@example.test'};
 it('offers approve and reject on a release waiting for approval (state PENDING_APPROVAL)',async()=>{
  vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[]}:{inspection:{...detail,releases:[pending]}}));
  show();
  fireEvent.click(await screen.findByRole('button',{name:'Approve release'}));
  await waitFor(()=>{expect(api.post).toHaveBeenCalledWith('/admin/inspection/releases/REL/approve',undefined,expect.objectContaining({idempotencyKey: expect.any(String) as string}));});
  expect(screen.getByRole('button',{name:'Reject release'})).toBeInTheDocument();
 });
 it('shows no decision buttons on a release already decided',async()=>{
  vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[]}:{inspection:{...detail,releases:[{...pending,state:'ACTIVE'}]}}));
  show(); await screen.findByText('ORD-1');
  expect(screen.queryByRole('button',{name:'Approve release'})).not.toBeInTheDocument();
 });
 it('uploads RELEASE evidence first and sends its id with the request',async()=>{
  vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[]}:{inspection:{...detail,releaseEvidence:[{id:'E1',fileName:'photo.jpg',purpose:'RELEASE',releaseId:null}]}}));
  vi.mocked(api.upload).mockResolvedValue({id:'E1'});
  show(); await screen.findByText('ORD-1');
  fireEvent.change(screen.getByLabelText('Reason for a conditional release (manual override)'),{target:{value:'Buyer accepts the minor finding in writing.'}});
  expect(screen.getByRole('button',{name:'Ask for conditional release'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Evidence file'),{target:{files:[new File(['x'],'photo.jpg',{type:'image/jpeg'})]}});
  fireEvent.click(screen.getByRole('button',{name:'Attach evidence'}));
  await waitFor(()=>{expect(api.upload).toHaveBeenCalled();});
  const form=vi.mocked(api.upload).mock.calls[0]?.[1];
  expect(form?.get('purpose')).toBe('RELEASE');
  await waitFor(()=>{expect(screen.getByRole('button',{name:'Ask for conditional release'})).toBeEnabled();});
  fireEvent.click(screen.getByRole('button',{name:'Ask for conditional release'}));
  await waitFor(()=>{expect(api.post).toHaveBeenCalledWith('/admin/inspection/requirements/R/conditional-release',{reason:'Buyer accepts the minor finding in writing.',evidenceIds:['E1']},expect.any(Object));});
 });
 it('labels an inconclusive result and the on-hold status',async()=>{
  vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[]}:{inspection:{...detail,requirement:{...detail.requirement,status:'ON_HOLD'},jobs:[{...original,report:{status:'SIGNED',result:'INCONCLUSIVE'}}]}}));
  show(); expect(await screen.findByText(/On hold \(inconclusive\)/)).toBeInTheDocument();
  expect(screen.getByText(/Inconclusive/)).toBeInTheDocument();
 });
 it('sends stage, scope method and time zone with a booking',async()=>{
  vi.mocked(api.get).mockImplementation(path=>Promise.resolve(path.endsWith('/agencies')?{agencies:[{id:'A',name:'QA'}]}:{inspection:{...detail,jobs:[]}}));
  show(); await screen.findByText('ORD-1'); fillBooking();
  fireEvent.change(screen.getByLabelText('Stage'),{target:{value:'DURING_PRODUCTION'}});
  fireEvent.change(screen.getByLabelText('How much is examined'),{target:{value:'FULL'}});
  fireEvent.change(screen.getByLabelText('Time zone of the inspection site'),{target:{value:'Asia/Kolkata'}});
  fireEvent.click(screen.getByRole('button',{name:'Book inspection'}));
  await waitFor(()=>{expect(api.post).toHaveBeenCalledWith('/admin/inspection/jobs',expect.objectContaining({stage:'DURING_PRODUCTION',scopeMethod:'FULL',timezone:'Asia/Kolkata'}),expect.any(Object));});
 });
});
function showPanel():void {
 render(<I18nextProvider i18n={i18n}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><ToastProvider><MemoryRouter><SubLotReleasesPanel /></MemoryRouter></ToastProvider></QueryClientProvider></I18nextProvider>);
}
describe('sub-lot releases',()=>{
 const row={id:'S1',subLotCode:'SL-1',lotReference:'LOT',quantity:'40',unit:'PIECE',lines:[{orderItemId:'ITEM000001',quantity:40}],reason:'Separated and labelled on pallet 3.',state:'PENDING_APPROVAL',requestedByLabel:'qa@agency.test',requestedAt:'2026-10-05T10:00:00Z',sellerOrderNumber:'SO-1',sellerName:'Acme'};
 beforeEach(()=>{vi.mocked(api.get).mockResolvedValue({releases:[row]});});
 it('approves a waiting sub-lot release with an idempotency key',async()=>{
  showPanel();
  fireEvent.click(await screen.findByRole('button',{name:'Approve sub-lot release'}));
  await waitFor(()=>{expect(api.post).toHaveBeenCalledWith('/admin/inspection/sublot-releases/S1/decision',{decision:'APPROVE',note:null},expect.objectContaining({idempotencyKey: expect.any(String) as string}));});
  expect(vi.mocked(api.get).mock.calls[0]?.[1]).toEqual({query:{state:'PENDING_APPROVAL'}});
 });
 it('needs a note to reject',async()=>{
  showPanel();
  expect(await screen.findByRole('button',{name:'Reject sub-lot release'})).toBeDisabled();
 });
 it('explains when the requester tries to decide their own',async()=>{
  vi.mocked(api.post).mockRejectedValue(new ApiError(409,{code:'INSPECTION_SUBLOT_NOT_ALLOWED',message:'x',details:[{code:'SAME_PERSON'}]}));
  showPanel();
  fireEvent.click(await screen.findByRole('button',{name:'Approve sub-lot release'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('You asked for this sub-lot release, so somebody else must decide it.');
 });
});
