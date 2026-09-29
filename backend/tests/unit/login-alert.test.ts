/**
 * What "a new device" and "a new network" mean for the sign-in alert.
 *
 * The device is the browser family and operating system, never the version -
 * a browser updates itself every few weeks, and an alert on every update is
 * an alert people learn to ignore. The network is the /24 (IPv4) or /48
 * (IPv6) block, because a home connection's address moves inside its block.
 */
import { describe, expect, it } from 'vitest';
import { describeDevice, networkKey } from '../../src/modules/identity/login-alert.service.js';

describe('describeDevice', () => {
  it('names the browser family and the system, and ignores the version', () => {
    const v126 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
    const v127 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36';
    expect(describeDevice(v126)).toBe('Chrome on Windows');
    expect(describeDevice(v127)).toBe(describeDevice(v126));
  });

  it('tells the common browsers and systems apart', () => {
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe(
      'Firefox on Linux',
    );
    expect(
      describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15'),
    ).toBe('Safari on macOS');
    expect(
      describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 CriOS/126.0 Mobile Safari/604.1'),
    ).toBe('Chrome on iOS');
    expect(
      describeDevice('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0'),
    ).toBe('Edge on Windows');
    expect(describeDevice(null)).toBe('Another browser on an unknown system');
  });
});

describe('networkKey', () => {
  it('groups an IPv4 address by its /24', () => {
    expect(networkKey('203.0.113.7')).toBe('203.0.113.0/24');
    expect(networkKey('203.0.113.250')).toBe(networkKey('203.0.113.7'));
    expect(networkKey('203.0.114.7')).not.toBe(networkKey('203.0.113.7'));
  });

  it('reads an IPv4-mapped IPv6 address as IPv4', () => {
    expect(networkKey('::ffff:203.0.113.7')).toBe('203.0.113.0/24');
  });

  it('groups an IPv6 address by its /48', () => {
    expect(networkKey('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(networkKey('2001:db8:1234:ffff::9')).toBe(networkKey('2001:db8:1234:5678::1'));
    expect(networkKey('2001:db8::1')).toBe('2001:db8:0::/48');
  });

  it('has one bucket for an unknown address', () => {
    expect(networkKey(null)).toBe('unknown');
    expect(networkKey('')).toBe('unknown');
  });
});
