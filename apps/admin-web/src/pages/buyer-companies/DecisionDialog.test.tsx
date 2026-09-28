/**
 * The confirmation behind approve, reject and suspend.
 *
 *   - A rejection cannot be confirmed without a reason code and a reason the
 *     applicant reads: the button stays disabled until both are there.
 *   - What is confirmed is exactly what was entered, trimmed - including
 *     whether the applicant may correct and reapply.
 *   - A refusal from the server is handed back and the dialog stays open, so
 *     the reviewer does not lose what they wrote.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@/i18n/config';
import { DecisionDialog } from './DecisionDialog';

// jsdom has no <dialog> methods. The smallest stand-in: toggle `open`, which
// is all the Modal observes. (The storefront keeps the same in its test setup.)
const dialogProto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
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

afterEach(() => {
  cleanup();
});

function renderReject(onConfirm = vi.fn().mockResolvedValue(undefined), onError = vi.fn(), onClose = vi.fn()) {
  render(
    <I18nextProvider i18n={i18n}>
      <DecisionDialog
        title="Reject this application"
        body="The applicant is told the reason you give."
        reasonLabel="Reason"
        reasonRequired
        withReasonCode
        withResubmission
        dangerous
        confirmLabel="Reject"
        onClose={onClose}
        onConfirm={onConfirm}
        onError={onError}
      />
    </I18nextProvider>,
  );
  return { onConfirm, onError, onClose };
}

const confirmButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: 'Reject' });

describe('DecisionDialog - rejecting', () => {
  it('stays disabled until both a reason code and a reason are given', () => {
    renderReject();
    expect(confirmButton().disabled).toBe(true);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'DETAILS_DO_NOT_MATCH' } });
    expect(confirmButton().disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(confirmButton().disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'The NIP belongs to another company.' } });
    expect(confirmButton().disabled).toBe(false);
  });

  it('confirms exactly what was entered, trimmed, and closes', async () => {
    const { onConfirm, onClose } = renderReject();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'DETAILS_DO_NOT_MATCH' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  The NIP belongs to another company.  ' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(onConfirm).toHaveBeenCalledWith({
      reason: 'The NIP belongs to another company.',
      reasonCode: 'DETAILS_DO_NOT_MATCH',
      resubmissionAllowed: false,
      documentKinds: [],
    });
  });

  it('hands a server refusal back and stays open', async () => {
    const refusal = new Error('BUYER_COMPANY_VERSION_CONFLICT');
    const { onError, onClose } = renderReject(vi.fn().mockRejectedValue(refusal));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'OTHER' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not a registered business.' } });
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(refusal);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Not a registered business.');
  });
});
