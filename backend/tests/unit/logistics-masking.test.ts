/**
 * What a courier is allowed to read about the person at the door.
 *
 * The rule under test is the one in the module's header: masking is by ROLE
 * and by NEED together, the assigned driver on an active delivery is the only
 * ordinary reveal, and everything else gets a masked value plus a secure
 * contact action.
 */
import { describe, expect, it } from 'vitest';
import {
  contactEmailFor,
  contactPhoneFor,
  maskEmail,
  maskPersonName,
  maskPhone,
  revealPolicyFor,
} from '../../src/domain/logistics-masking.js';
import {
  LogisticsPermission,
  permissionsForLogisticsRole,
  LogisticsRole,
} from '../../src/domain/logistics-permissions.js';

const DISPATCHER = {
  permissions: permissionsForLogisticsRole(LogisticsRole.DISPATCHER),
  isAssignedDriver: false,
};

const DRIVER_ON_THE_JOB = {
  permissions: permissionsForLogisticsRole(LogisticsRole.DRIVER),
  isAssignedDriver: true,
};

const OTHER_DRIVER = {
  permissions: permissionsForLogisticsRole(LogisticsRole.DRIVER),
  isAssignedDriver: false,
};

const TRACKING_VIEWER = {
  permissions: permissionsForLogisticsRole(LogisticsRole.READ_ONLY_TRACKING_USER),
  isAssignedDriver: false,
};

describe('maskPhone', () => {
  it('keeps the country prefix and the last two digits', () => {
    const masked = maskPhone('+32 478 12 34 56');

    expect(masked).toContain('+32');
    expect(masked?.endsWith('56')).toBe(true);
    expect(masked).toContain('•');
  });

  it('does not keep four digits, which is the card-number habit', () => {
    /*
     * Four digits of a national number plus a city is frequently enough to
     * find the person. Two confirms a consignment; four identifies a human.
     */
    const masked = maskPhone('+3247812345678') ?? '';
    const digits = masked.replace(/\D/g, '');

    // The prefix digits plus exactly two tail digits, and nothing more.
    expect(digits.length).toBeLessThanOrEqual(5);
  });

  it('handles a number with no country code', () => {
    const masked = maskPhone('020 7946 0958');
    expect(masked?.endsWith('58')).toBe(true);
    expect(masked).not.toContain('+');
  });

  it('gives away nothing for something too short to mask', () => {
    expect(maskPhone('12')).toBe('•••');
  });

  it('answers null for nothing', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone('   ')).toBeNull();
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    // Six dots, not nine: the mask is capped so its LENGTH does not leak the
    // length of the local part on a long address.
    expect(maskEmail('jan.deboer@hospital.example')).toBe('j••••••@hospital.example');
  });

  it('keeps the domain because the organisation is operational information', () => {
    const masked = maskEmail('procurement@st-lukes.example') ?? '';
    expect(masked.endsWith('@st-lukes.example')).toBe(true);
    expect(masked).not.toContain('procurement');
  });

  it('gives away nothing for something that is not an address', () => {
    expect(maskEmail('not-an-address')).toBe('•••');
  });
});

describe('maskPersonName', () => {
  it('reduces a name to what a reception desk needs', () => {
    expect(maskPersonName('Jan de Boer')).toBe('Jan B.');
    expect(maskPersonName('Aisha Khan')).toBe('Aisha K.');
  });

  it('leaves a single name alone', () => {
    expect(maskPersonName('Prakash')).toBe('Prakash');
  });

  it('answers null for nothing', () => {
    expect(maskPersonName('')).toBeNull();
    expect(maskPersonName(null)).toBeNull();
  });
});

describe('who gets the real value', () => {
  it('unmasks for the assigned driver on an active delivery, and nobody else', () => {
    expect(revealPolicyFor(DRIVER_ON_THE_JOB, 'ACTIVE_DELIVERY').reveal).toBe(true);

    // The same driver, looking at the shipment page rather than standing at
    // the door.
    expect(revealPolicyFor(DRIVER_ON_THE_JOB, 'SHIPMENT_DETAIL').reveal).toBe(false);

    // A different driver, on the same context.
    expect(revealPolicyFor(OTHER_DRIVER, 'ACTIVE_DELIVERY').reveal).toBe(false);
  });

  it('unmasks for an operations agent working a live exception', () => {
    const agent = {
      permissions: permissionsForLogisticsRole(LogisticsRole.OPERATIONS_AGENT),
      isAssignedDriver: false,
    };

    expect(agent.permissions.has(LogisticsPermission.SHIPMENT_EXCEPTION_WRITE)).toBe(true);
    expect(revealPolicyFor(agent, 'EXCEPTION_HANDLING').reveal).toBe(true);
  });

  it('will not unmask for a tracking viewer in any context', () => {
    for (const context of ['LIST', 'SHIPMENT_DETAIL', 'ACTIVE_DELIVERY', 'EXCEPTION_HANDLING'] as const) {
      expect(revealPolicyFor(TRACKING_VIEWER, context).reveal).toBe(false);
    }
  });

  it('will not unmask for a dispatcher planning tomorrow', () => {
    expect(revealPolicyFor(DISPATCHER, 'LIST').reveal).toBe(false);
    expect(revealPolicyFor(DISPATCHER, 'SHIPMENT_DETAIL').reveal).toBe(false);
  });

  it('records WHY, so the caller can write an audit row', () => {
    expect(revealPolicyFor(DRIVER_ON_THE_JOB, 'ACTIVE_DELIVERY').reason).toBe(
      'ASSIGNED_DRIVER_ON_ACTIVE_DELIVERY',
    );
    expect(revealPolicyFor(DISPATCHER, 'LIST').reason).toBe('DEFAULT_MASKED');
  });
});

describe('the values the read paths actually return', () => {
  it('offers a secure contact action wherever it masks', () => {
    const masked = contactPhoneFor('+32 478 12 34 56', DISPATCHER, 'SHIPMENT_DETAIL');

    expect(masked.isMasked).toBe(true);
    expect(masked.offerSecureContact).toBe(true);
    expect(masked.display).not.toContain('478');
  });

  it('hands the driver the real number, with no secure-contact fallback', () => {
    const revealed = contactPhoneFor('+32 478 12 34 56', DRIVER_ON_THE_JOB, 'ACTIVE_DELIVERY');

    expect(revealed.isMasked).toBe(false);
    expect(revealed.offerSecureContact).toBe(false);
    expect(revealed.display).toBe('+32 478 12 34 56');
  });

  it('offers nothing at all when there is no number', () => {
    const empty = contactPhoneFor(null, DRIVER_ON_THE_JOB, 'ACTIVE_DELIVERY');

    expect(empty.display).toBeNull();
    expect(empty.offerSecureContact).toBe(false);
  });

  it('masks an email the same way', () => {
    const masked = contactEmailFor('jan@hospital.example', DISPATCHER, 'LIST');
    expect(masked.isMasked).toBe(true);
    expect(masked.display).toBe('j••@hospital.example');
  });
});
