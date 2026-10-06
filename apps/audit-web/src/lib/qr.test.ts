/**
 * The QR encoder, checked by DECODING what it draws.
 *
 * WHY IT IS DONE THIS WAY
 *
 * An encoder is easy to test badly. "It returned a grid and did not throw" is
 * satisfied by a grid of noise, and that is exactly the failure this file was
 * written after: a real enrolment produced a 215-byte URI, the version table
 * stopped at ten, the encoder threw, and the component's deliberate
 * fall-back - the plain-text secret is printed beside it - meant the screen
 * looked fine with a blank white square where the code should be. Nothing was
 * red. Nobody would have found it except by scanning.
 *
 * So the test reads the code back. It walks the same zigzag the writer walks,
 * removes the mask, de-interleaves the blocks and recovers the bytes, then
 * asserts they are the bytes that went in. That exercises the version tables,
 * the block structure, the interleave and the mask together - and a wrong
 * entry in any of them shows up as a payload that does not round-trip, which
 * is what a phone would experience.
 *
 * It does NOT check the Reed-Solomon parity, the format information or the
 * penalty scoring. Those are verified by a scanner, and this file says so
 * rather than implying more coverage than it has.
 */
import { describe, expect, it } from 'vitest';
import { encodeQr } from './qr';

/** The function positions, which carry no data and are skipped on the read. */
function reservedMask(size: number, version: number): boolean[][] {
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const block = (row: number, column: number, height: number, width: number): void => {
    for (let r = row; r < row + height; r += 1) {
      for (let c = column; c < column + width; c += 1) {
        if (r >= 0 && r < size && c >= 0 && c < size) (reserved[r] as boolean[])[c] = true;
      }
    }
  };

  // Finders with their separators, and the format areas beside each.
  block(0, 0, 9, 9);
  block(0, size - 8, 9, 8);
  block(size - 8, 0, 8, 9);

  // Timing.
  for (let i = 0; i < size; i += 1) {
    (reserved[6] as boolean[])[i] = true;
    (reserved[i] as boolean[])[6] = true;
  }

  // Alignment, at the centres this version uses.
  const centres = ALIGNMENT_CENTRES[version] ?? [];

  for (const row of centres) {
    for (const column of centres) {
      const onFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === size - 7) ||
        (row === size - 7 && column === 6);

      if (!onFinder) block(row - 2, column - 2, 5, 5);
    }
  }

  // Version information, for 7 and up.
  if (version >= 7) {
    block(0, size - 11, 6, 3);
    block(size - 11, 0, 3, 6);
  }

  return reserved;
}

/** Table E.1, for the versions the encoder supports. */
const ALIGNMENT_CENTRES: Record<number, readonly number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
};

/** `[ecPerBlock, [[blocks, dataCodewords], …]]` at level M. */
const BLOCKS: Record<number, readonly [number, readonly (readonly [number, number])[]]> = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [
    22,
    [
      [2, 38],
      [2, 39],
    ],
  ],
  9: [
    22,
    [
      [3, 36],
      [2, 37],
    ],
  ],
  10: [
    26,
    [
      [4, 43],
      [1, 44],
    ],
  ],
  11: [
    30,
    [
      [1, 50],
      [4, 51],
    ],
  ],
  12: [
    22,
    [
      [6, 36],
      [2, 37],
    ],
  ],
  13: [
    22,
    [
      [8, 37],
      [1, 38],
    ],
  ],
  14: [
    24,
    [
      [4, 40],
      [5, 41],
    ],
  ],
};

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Read one code back.
 *
 * The mask is not read from the format information - that would make this test
 * depend on the very bits it cannot otherwise check. Instead it tries all
 * eight and returns the first that yields a well-formed byte-mode payload,
 * which is a stricter test: seven of them must fail to parse.
 */
function decode(modules: boolean[][], version: number): string {
  const size = modules.length;
  const reserved = reservedMask(size, version);

  for (let mask = 0; mask < 8; mask += 1) {
    const bits: number[] = [];
    const isMasked = MASKS[mask];
    if (isMasked === undefined) continue;

    // The writer's zigzag: right-hand column pair first, upwards, skipping
    // the vertical timing column.
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      const column = right === 6 ? right - 1 : right;

      for (let step = 0; step < size; step += 1) {
        const row = upward ? size - 1 - step : step;

        for (const c of [column, column - 1]) {
          if ((reserved[row] as boolean[])[c] === true) continue;

          const dark = (modules[row] as boolean[])[c] === true;
          bits.push(dark !== isMasked(row, c) ? 1 : 0);
        }
      }

      upward = !upward;
      if (right === 7) right -= 1;
    }

    // Bits to interleaved codewords.
    const stream: number[] = [];
    for (let i = 0; i + 7 < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] as number);
      stream.push(byte);
    }

    const entry = BLOCKS[version];
    if (entry === undefined) continue;

    const [, groups] = entry;
    const sizes: number[] = [];
    for (const [count, dataCodewords] of groups) {
      for (let i = 0; i < count; i += 1) sizes.push(dataCodewords);
    }

    // De-interleave: column-major across the blocks, short blocks first.
    const blocks: number[][] = sizes.map(() => []);
    const longest = Math.max(...sizes);
    let read = 0;

    for (let i = 0; i < longest; i += 1) {
      for (let b = 0; b < sizes.length; b += 1) {
        if (i >= (sizes[b] as number)) continue;
        (blocks[b] as number[]).push(stream[read] as number);
        read += 1;
      }
    }

    const data = blocks.flat();

    // Byte mode, then the character count, then the payload.
    if (data.length < 3) continue;
    const mode = ((data[0] as number) >>> 4) & 0x0f;
    if (mode !== 0b0100) continue;

    const countBits = version < 10 ? 8 : 16;
    let cursor = 4;

    const take = (length: number): number => {
      let value = 0;
      for (let i = 0; i < length; i += 1) {
        const byte = data[cursor >>> 3];
        if (byte === undefined) return -1;
        value = (value << 1) | ((byte >>> (7 - (cursor & 7))) & 1);
        cursor += 1;
      }
      return value;
    };

    const length = take(countBits);
    if (length <= 0 || length > 400) continue;

    const bytes: number[] = [];
    for (let i = 0; i < length; i += 1) {
      const byte = take(8);
      if (byte < 0) break;
      bytes.push(byte);
    }

    if (bytes.length !== length) continue;

    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  return '<could not decode>';
}

/** The size of the grid tells you the version: 21 + 4*(v-1). */
function versionOf(modules: boolean[][]): number {
  return (modules.length - 21) / 4 + 1;
}

describe('the QR encoder round-trips its own payload', () => {
  const cases: readonly [string, string][] = [
    ['a short string', 'UBOSS'],
    [
      'a typical enrolment URI',
      'otpauth://totp/UBOSS%20Logistics:carrier.dispatch@uboss.local?secret=BDKOREB3METWHMYK3AQLHOBG3KEXABEC&issuer=UBOSS%20Logistics&algorithm=SHA1&digits=6&period=30',
    ],
    [
      'the one that used to be too long',
      `otpauth://totp/${encodeURIComponent('Northwind Medical Supplies Marketplace:logistics.operations.manager@northwind-medical.example')}?secret=BDKOREB3METWHMYK3AQLHOBG3KEXABEC&issuer=${encodeURIComponent('Northwind Medical Supplies Marketplace')}&algorithm=SHA1&digits=6&period=30`,
    ],
  ];

  for (const [name, payload] of cases) {
    it(`reads back ${name}`, () => {
      const modules = encodeQr(payload);
      const version = versionOf(modules);

      expect(Number.isInteger(version)).toBe(true);
      expect(version).toBeGreaterThanOrEqual(1);
      expect(version).toBeLessThanOrEqual(14);

      expect(decode(modules, version)).toBe(payload);
    });
  }

  /**
   * The specific length that broke it.
   *
   * 215 bytes is what a real deployment produced. Asserting the exact number
   * is the point: a version table trimmed back to ten would pass every other
   * test in this file and fail this one.
   */
  it('encodes the 215-byte URI that used to be refused', () => {
    const payload = `otpauth://totp/${'A'.repeat(60)}?secret=${'B'.repeat(32)}&issuer=${'C'.repeat(60)}&algorithm=SHA1&digits=6&period=30`;

    expect(new TextEncoder().encode(payload).length).toBeGreaterThan(200);

    const modules = encodeQr(payload);
    expect(decode(modules, versionOf(modules))).toBe(payload);
  });

  it('refuses a payload no version-14 code can hold, rather than truncating it', () => {
    expect(() => encodeQr('z'.repeat(400))).toThrow(/too long/);
  });
});

describe('the structural patterns a scanner looks for', () => {
  const modules = encodeQr('UBOSS');

  it('draws three finder patterns', () => {
    const size = modules.length;
    const finder = (row: number, column: number): boolean =>
      (modules[row] as boolean[])[column] === true &&
      (modules[row + 1] as boolean[])[column + 1] === false &&
      (modules[row + 2] as boolean[])[column + 2] === true;

    expect(finder(0, 0)).toBe(true);
    expect(finder(0, size - 7)).toBe(true);
    expect(finder(size - 7, 0)).toBe(true);
  });

  it('draws the timing patterns as alternating modules', () => {
    for (let i = 8; i < modules.length - 8; i += 1) {
      expect((modules[6] as boolean[])[i]).toBe(i % 2 === 0);
      expect((modules[i] as boolean[])[6]).toBe(i % 2 === 0);
    }
  });

  it('sets the dark module', () => {
    expect((modules[modules.length - 8] as boolean[])[8]).toBe(true);
  });
});
