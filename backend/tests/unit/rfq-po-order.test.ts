/**
 * The pure rules for turning an RFQ purchase order into an order (LIVE-004):
 * the quantity is a whole number of units or it is refused, and a purchase
 * order that asks for any inspection makes the final inspection mandatory.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ORDER_LINE_QUANTITY,
  purchaseOrderInspectionReason,
  wholeOrderQuantity,
} from '../../src/domain/rfq-po-order.js';

describe('wholeOrderQuantity', () => {
  it('accepts whole numbers, written with or without zero decimals', () => {
    expect(wholeOrderQuantity('12000')).toEqual({ ok: true, units: 12000 });
    expect(wholeOrderQuantity('12000.000')).toEqual({ ok: true, units: 12000 });
    expect(wholeOrderQuantity('1')).toEqual({ ok: true, units: 1 });
  });

  it('refuses a fractional quantity rather than rounding it', () => {
    expect(wholeOrderQuantity('12.5')).toEqual({ ok: false, code: 'FRACTIONAL_QUANTITY' });
    expect(wholeOrderQuantity('0.001')).toEqual({ ok: false, code: 'FRACTIONAL_QUANTITY' });
    expect(wholeOrderQuantity('0')).toEqual({ ok: false, code: 'FRACTIONAL_QUANTITY' });
    expect(wholeOrderQuantity('-3')).toEqual({ ok: false, code: 'FRACTIONAL_QUANTITY' });
    expect(wholeOrderQuantity('abc')).toEqual({ ok: false, code: 'FRACTIONAL_QUANTITY' });
  });

  it('refuses a quantity an order line cannot hold', () => {
    expect(wholeOrderQuantity(String(MAX_ORDER_LINE_QUANTITY))).toEqual({ ok: true, units: MAX_ORDER_LINE_QUANTITY });
    expect(wholeOrderQuantity(String(MAX_ORDER_LINE_QUANTITY + 1))).toEqual({ ok: false, code: 'QUANTITY_TOO_LARGE' });
  });
});

describe('purchaseOrderInspectionReason', () => {
  it('is null when the purchase order asks for no inspection', () => {
    expect(purchaseOrderInspectionReason('PO-1', { inspectionRequirement: 'NONE', inspectionTerms: null })).toBeNull();
    expect(purchaseOrderInspectionReason('PO-1', { inspectionRequirement: 'NONE', inspectionTerms: '   ' })).toBeNull();
  });

  it('names the purchase order and its terms when it asks for one', () => {
    expect(purchaseOrderInspectionReason('PO-2026-ABC', { inspectionRequirement: 'THIRD_PARTY_PRE_SHIPMENT', inspectionTerms: 'SGS, AQL 2.5' })).toBe(
      'Purchase order PO-2026-ABC requires a pre-shipment inspection: SGS, AQL 2.5',
    );
    expect(purchaseOrderInspectionReason('PO-1', { inspectionRequirement: 'SUPPLIER_QC_REPORT', inspectionTerms: null })).toBe(
      'Purchase order PO-1 requires a pre-shipment inspection.',
    );
    // Terms alone are enough: the accepted offer is part of the contract.
    expect(purchaseOrderInspectionReason('PO-1', { inspectionRequirement: 'NONE', inspectionTerms: 'Intertek' })).toContain('Intertek');
  });

  it('fits the 512-character reason column', () => {
    const reason = purchaseOrderInspectionReason('PO-1', { inspectionRequirement: 'BUYER_VISIT', inspectionTerms: 'x'.repeat(2000) });
    expect(reason?.length).toBe(512);
  });
});
