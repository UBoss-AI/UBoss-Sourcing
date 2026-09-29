/**
 * Completing a delivery from the portal.
 *
 *   - it asks for what this shipment's policy requires, and marks it;
 *   - a missing required field is caught before anything is sent;
 *   - files are uploaded first and their ids go with the capture, under one
 *     idempotency key; a retry after a failed capture does not upload twice;
 *   - the server naming a field puts its message on that field;
 *   - a policy that needs a delivery code asks for the six digits the
 *     recipient reads out, sends them with the capture, puts a refusal on the
 *     code field, and can have a new code sent - the code itself never
 *     reaching this screen;
 *   - with nobody to send a code to, it says why it cannot be completed,
 *     rather than offering a form that could only fail.
 *
 * Plain assertions throughout: this app's test setup has no jest-dom matchers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { ToastProvider } from '@/components/toast';
import { i18n } from '@/i18n/config';
import { ApiError } from '@/lib/api';
import type { DeliveryCodeState, PodRequirements, ShipmentDetail } from '@/lib/types';
import { ProofOfDeliveryDialog } from './ProofOfDeliveryDialog';

vi.mock('@/lib/logistics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logistics')>();
  return { ...actual, uploadDocument: vi.fn(), captureProofOfDelivery: vi.fn(), requestDeliveryCode: vi.fn() };
});

const logistics = await import('@/lib/logistics');
const uploadDocument = vi.mocked(logistics.uploadDocument);
const captureProofOfDelivery = vi.mocked(logistics.captureProofOfDelivery);
const requestDeliveryCode = vi.mocked(logistics.requestDeliveryCode);

const LIVE_CODE: DeliveryCodeState = {
  status: 'ACTIVE',
  canBeSent: true,
  sentAt: '2026-09-29T08:00:00.000Z',
  expiresAt: '2026-09-29T20:00:00.000Z',
  attemptsLeft: 5,
  nextSendAt: '2026-09-29T08:01:00.000Z',
  sendsLeftToday: 4,
};

// jsdom has no <dialog> methods; the Modal only needs `open` toggled.
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void;
  close?: () => void;
};
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
}
if (typeof dialogProto.close !== 'function') {
  dialogProto.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
}

const NAME_ONLY: PodRequirements = {
  requiresRecipientName: true,
  requiresSignature: false,
  requiresPhoto: false,
  requiresOtp: false,
  requiresDesignation: false,
};

function shipment(needs: Partial<PodRequirements> = {}, deliveryCode: DeliveryCodeState | null = null): ShipmentDetail {
  return {
    id: '01SHIPMENT0000000000000000',
    podRequirements: { ...NAME_ONLY, ...needs },
    deliveryCode,
  } as unknown as ShipmentDetail;
}

const onClose = vi.fn();

function open(needs: Partial<PodRequirements> = {}, deliveryCode: DeliveryCodeState | null = null): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ProofOfDeliveryDialog shipment={shipment(needs, deliveryCode)} isOpen onClose={onClose} />
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const typeInto = (label: RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const choose = (label: RegExp, file: File): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
};
const image = (name: string): File => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
const complete = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Complete the delivery' }));
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('completing a delivery', () => {
  it('records a named recipient and closes', async () => {
    captureProofOfDelivery.mockResolvedValue({ podId: 'pod1', status: 'DELIVERED', duplicate: false });
    open();

    typeInto(/Who took it/, 'A. Kowalska');
    complete();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(captureProofOfDelivery).toHaveBeenCalledTimes(1);
    const [shipmentId, input, key] = captureProofOfDelivery.mock.calls[0] ?? [];
    expect(shipmentId).toBe('01SHIPMENT0000000000000000');
    expect(input).toEqual({ recipientName: 'A. Kowalska' });
    expect(typeof key).toBe('string');
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('catches a missing name before sending anything', async () => {
    open();
    complete();

    expect(await screen.findByText('Needed for this delivery.')).toBeTruthy();
    expect(captureProofOfDelivery).not.toHaveBeenCalled();
  });

  it('uploads the signature and photograph, then captures with their ids', async () => {
    uploadDocument.mockImplementation((_id, file, kind) =>
      Promise.resolve({ id: `${kind}-${file.name}` } as never),
    );
    captureProofOfDelivery.mockResolvedValue({ podId: 'pod1', status: 'DELIVERED', duplicate: false });
    open({ requiresSignature: true, requiresPhoto: true });

    typeInto(/Who took it/, 'Ward sister');
    choose(/Signature/, image('sign.jpg'));
    choose(/Photograph/, image('door.jpg'));
    complete();

    await waitFor(() => {
      expect(captureProofOfDelivery).toHaveBeenCalledTimes(1);
    });
    expect(uploadDocument).toHaveBeenCalledWith('01SHIPMENT0000000000000000', expect.any(File), 'DELIVERY_SIGNATURE');
    expect(uploadDocument).toHaveBeenCalledWith('01SHIPMENT0000000000000000', expect.any(File), 'DELIVERY_PHOTO');
    expect(captureProofOfDelivery.mock.calls[0]?.[1]).toMatchObject({
      signatureDocumentId: 'DELIVERY_SIGNATURE-sign.jpg',
      photoDocumentId: 'DELIVERY_PHOTO-door.jpg',
    });
  });

  it('refuses a required photograph that is missing, or not an image', async () => {
    open({ requiresPhoto: true });
    typeInto(/Who took it/, 'Ward sister');
    choose(/Photograph/, new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    complete();

    expect(await screen.findByText('Choose an image file.')).toBeTruthy();
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('puts the server’s message on the field it names, and does not upload twice on a retry', async () => {
    uploadDocument.mockResolvedValue({ id: 'doc-sign' } as never);
    captureProofOfDelivery
      .mockRejectedValueOnce(
        new ApiError(400, {
          code: 'SHIPMENT_POD_REQUIRED',
          message: 'This delivery needs more proof before it can be completed.',
          details: [{ field: 'recipientDesignation', code: 'REQUIRED', message: 'Their role is needed.' }],
        }),
      )
      .mockResolvedValueOnce({ podId: 'pod1', status: 'DELIVERED', duplicate: false });
    open({ requiresSignature: true });

    typeInto(/Who took it/, 'Ward sister');
    choose(/Signature/, image('sign.jpg'));
    complete();

    expect(await screen.findByText('Their role is needed.')).toBeTruthy();

    typeInto(/Their role/, 'Charge nurse');
    complete();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    // One opening of the dialog, one key, both attempts.
    expect(captureProofOfDelivery.mock.calls[0]?.[2]).toBe(captureProofOfDelivery.mock.calls[1]?.[2]);
  });
});

describe('a delivery that needs a delivery code', () => {
  it('asks for the code, says one is live, and sends it with the capture', async () => {
    captureProofOfDelivery.mockResolvedValue({ podId: 'pod1', status: 'DELIVERED', duplicate: false });
    open({ requiresOtp: true }, LIVE_CODE);

    expect(screen.getByText(/A code was sent to the person receiving it/)).toBeTruthy();
    typeInto(/Who took it/, 'Greta Klein');
    typeInto(/Delivery code/, '042 917');
    complete();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(captureProofOfDelivery.mock.calls[0]?.[1]).toEqual({ recipientName: 'Greta Klein', otp: '042917' });
  });

  it('catches a code that is not six digits before sending anything', async () => {
    open({ requiresOtp: true }, LIVE_CODE);
    typeInto(/Who took it/, 'Greta Klein');
    typeInto(/Delivery code/, '12ab');
    complete();

    expect(await screen.findByText('Enter the six digits of the code.')).toBeTruthy();
    expect(captureProofOfDelivery).not.toHaveBeenCalled();
  });

  it('puts a wrong code on the code field, and a dead one as "send a new one"', async () => {
    captureProofOfDelivery
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: 'SHIPMENT_OTP_INVALID',
          message: 'That delivery code is not right.',
          details: [{ field: 'otp', code: 'INVALID' }],
        }),
      )
      .mockRejectedValueOnce(
        new ApiError(409, {
          code: 'SHIPMENT_OTP_INVALID',
          message: 'That delivery code can no longer be used.',
          details: [{ field: 'otp', code: 'TOO_MANY_ATTEMPTS' }],
        }),
      );
    open({ requiresOtp: true }, LIVE_CODE);

    typeInto(/Who took it/, 'Greta Klein');
    typeInto(/Delivery code/, '111111');
    complete();
    expect(await screen.findByText('That code is not right. Check it with the person receiving it.')).toBeTruthy();

    complete();
    expect(await screen.findByText('That code can no longer be used. Send a new one.')).toBeTruthy();
    expect(screen.getByText(/Too many wrong codes were entered/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sends a new code on request, and never shows the code itself', async () => {
    requestDeliveryCode.mockResolvedValue({
      sentAt: '2026-09-29T09:00:00.000Z',
      expiresAt: '2026-09-29T21:00:00.000Z',
      deliveryCode: { ...LIVE_CODE, sentAt: '2026-09-29T09:00:00.000Z', sendsLeftToday: 3 },
    });
    open({ requiresOtp: true }, { ...LIVE_CODE, status: 'NOT_SENT', sentAt: null, expiresAt: null, attemptsLeft: null });

    expect(screen.getByText(/No code has been sent yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send the code' }));

    await waitFor(() => {
      expect(requestDeliveryCode).toHaveBeenCalledWith('01SHIPMENT0000000000000000');
    });
    expect(await screen.findByText(/A code was sent to the person receiving it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeTruthy();
  });

  it('offers no resend once the day’s codes are used up', () => {
    open({ requiresOtp: true }, { ...LIVE_CODE, sendsLeftToday: 0, nextSendAt: null });
    expect(screen.queryByRole('button', { name: 'Send a new code' })).toBeNull();
    expect(screen.getByText(/No more codes can be sent for this delivery today/)).toBeTruthy();
  });

  it('explains a delivery whose code has nobody to go to, and cannot be completed', () => {
    open({ requiresOtp: true }, { ...LIVE_CODE, status: 'NOT_SENT', canBeSent: false });

    expect(screen.getByText(/there is nobody to send one to/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Complete the delivery' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

});
