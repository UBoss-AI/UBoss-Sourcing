/**
 * A QR code encoder, small enough to own.
 *
 * WHY THIS IS HERE RATHER THAN A DEPENDENCY
 *
 * The only thing this portal ever puts in a QR code is an `otpauth://` URI,
 * and that URI contains the account's TOTP SECRET — the entire second factor.
 * Drawing it in this process is what keeps the secret out of a chart service,
 * out of an HTTP response body, and out of every cache in between. The
 * component that renders it is `pages/QrCode.tsx`.
 *
 * A library would also do, and this codebase's own posture on a security
 * primitive is the one in `infra/totp.ts`: a dependency is a supply-chain
 * surface, and this is a contained, fully-specified algorithm that has not
 * changed since ISO/IEC 18004 was published. What is implemented is the subset
 * the one payload needs: BYTE mode, error correction level M, versions 1 to
 * 14.
 *
 * Level M rather than L, deliberately: a QR code on a screen is photographed
 * in a depot, at an angle, by a phone with a scratched lens, and 15% recovery
 * against 7% is the difference between one attempt and four.
 */

// ---------------------------------------------------------------------------
// GF(256), for Reed-Solomon
// ---------------------------------------------------------------------------

/**
 * Log and antilog tables over GF(2^8) with the primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D), which is the one QR specifies.
 *
 * Built once at module load: 512 bytes, and it turns every field
 * multiplication in the encoder into two lookups and an addition.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function buildTables(): void {
  let value = 1;

  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;

    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }

  // Doubled, so a sum of two logs never needs a modulo.
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] as number;
})();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPolynomial(degree: number): number[] {
  let poly = [1];

  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);

    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] as number) ^ gfMultiply(poly[j] as number, 1);
      next[j + 1] = (next[j + 1] as number) ^ gfMultiply(poly[j] as number, EXP[i] as number);
    }

    poly = next;
  }

  return poly;
}

/** The `degree` error-correction codewords for one block. */
function errorCorrection(data: number[], degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.shift();
    remainder.push(0);

    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] as number) ^ gfMultiply(generator[i + 1] as number, factor);
    }
  }

  return remainder;
}

// ---------------------------------------------------------------------------
// Version tables, error correction level M
// ---------------------------------------------------------------------------

interface VersionSpec {
  /** Error-correction codewords per block. */
  ecPerBlock: number;
  /** `[blockCount, dataCodewordsPerBlock]` for each group. */
  groups: readonly (readonly [number, number])[];
}

/**
 * Versions 1 to 14 at level M.
 *
 * The ceiling used to be ten, on the reasoning that an `otpauth://` URI could
 * not exceed 200 bytes. That was wrong, and the way it was wrong is worth
 * keeping: the URI carries the DEPLOYMENT'S OWN NAME twice - once in the label
 * and once as the issuer - and it is percent-encoded, so a business with a
 * long name and a member of staff with a long email address produced 215
 * bytes on the first real account this was tried with. The code then refused
 * to encode, and the screen fell back to the plain-text secret beside it: no
 * crash, nothing wrong on screen, and no QR code.
 *
 * Fourteen holds 365 data codewords, which is roughly 355 bytes of payload -
 * about twice the longest URI a plausible business name can produce. A payload
 * that still does not fit throws, deliberately: a clear exception is better
 * than a silently truncated code that scans to the wrong secret.
 */
const VERSIONS: readonly VersionSpec[] = [
  { ecPerBlock: 10, groups: [[1, 16]] }, // 1
  { ecPerBlock: 16, groups: [[1, 28]] }, // 2
  { ecPerBlock: 26, groups: [[1, 44]] }, // 3
  { ecPerBlock: 18, groups: [[2, 32]] }, // 4
  { ecPerBlock: 24, groups: [[2, 43]] }, // 5
  { ecPerBlock: 16, groups: [[4, 27]] }, // 6
  { ecPerBlock: 18, groups: [[4, 31]] }, // 7
  {
    ecPerBlock: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
  }, // 8
  {
    ecPerBlock: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
  }, // 9
  {
    ecPerBlock: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
  }, // 10
  {
    ecPerBlock: 30,
    groups: [
      [1, 50],
      [4, 51],
    ],
  }, // 11
  {
    ecPerBlock: 22,
    groups: [
      [6, 36],
      [2, 37],
    ],
  }, // 12
  {
    ecPerBlock: 22,
    groups: [
      [8, 37],
      [1, 38],
    ],
  }, // 13
  {
    ecPerBlock: 24,
    groups: [
      [4, 40],
      [5, 41],
    ],
  }, // 14
];

/** Alignment-pattern centre coordinates, by version. Version 1 has none. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
];

function dataCapacity(spec: VersionSpec): number {
  return spec.groups.reduce((total, [blocks, size]) => total + blocks * size, 0);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** A growable bit buffer, MSB first - which is the order QR reads. */
class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pad to a byte boundary and return the codewords. */
  toCodewords(): number[] {
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const bytes: number[] = [];

    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] as number);
      bytes.push(byte);
    }

    return bytes;
  }
}

/** The smallest version that holds this payload. */
function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= VERSIONS.length; version += 1) {
    const spec = VERSIONS[version - 1] as VersionSpec;
    // Mode indicator (4) + character count (8 or 16) + the data itself.
    const headerBits = 4 + (version < 10 ? 8 : 16);
    const needed = Math.ceil((headerBits + byteLength * 8) / 8);

    if (needed <= dataCapacity(spec)) return version;
  }

  throw new Error(
    `This payload is too long for a version-14 QR code (${String(byteLength)} bytes).`,
  );
}

/** Data codewords and error-correction codewords, interleaved as QR requires. */
function buildCodewords(text: string, version: number): number[] {
  const spec = VERSIONS[version - 1] as VersionSpec;
  const bytes = [...new TextEncoder().encode(text)];

  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // Byte mode.
  buffer.push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) buffer.push(byte, 8);

  const capacity = dataCapacity(spec);

  // Terminator: up to four zero bits, or fewer if the buffer is nearly full.
  buffer.push(0, Math.min(4, capacity * 8 - buffer.length));

  const codewords = buffer.toCodewords();

  // Pad alternately with 0xEC and 0x11, which is what the specification says
  // and what every decoder expects to find.
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < capacity; i += 1) {
    codewords.push(PAD[i % 2] as number);
  }

  // --- Split into blocks -------------------------------------------------
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;

  for (const [blockCount, blockSize] of spec.groups) {
    for (let i = 0; i < blockCount; i += 1) {
      const block = codewords.slice(offset, offset + blockSize);
      offset += blockSize;

      dataBlocks.push(block);
      ecBlocks.push(errorCorrection(block, spec.ecPerBlock));
    }
  }

  // --- Interleave ---------------------------------------------------------
  //
  // Column-wise across the blocks, which is what spreads a physical smudge
  // across several blocks instead of destroying one of them entirely.
  const result: number[] = [];
  const longestData = Math.max(...dataBlocks.map((block) => block.length));

  for (let i = 0; i < longestData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i] as number);
    }
  }

  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) result.push(block[i] as number);
  }

  return result;
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

type Cell = 0 | 1 | null;

function placeFinder(matrix: Cell[][], row: number, column: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = column + c;
      if (y < 0 || y >= matrix.length || x < 0 || x >= matrix.length) continue;

      const onRing =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCentre = r >= 2 && r <= 4 && c >= 2 && c <= 4;

      (matrix[y] as Cell[])[x] = onRing || inCentre ? 1 : 0;
    }
  }
}

function buildMatrix(version: number, codewords: number[], mask: number): Cell[][] {
  const size = version * 4 + 17;
  const matrix: Cell[][] = Array.from({ length: size }, () => new Array<Cell>(size).fill(null));

  // --- Function patterns ---------------------------------------------------
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    const bit: Cell = i % 2 === 0 ? 1 : 0;
    (matrix[6] as Cell[])[i] = bit;
    (matrix[i] as Cell[])[6] = bit;
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = ALIGNMENT[version - 1] as readonly number[];

  for (const row of centres) {
    for (const column of centres) {
      const onFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === size - 7) ||
        (row === size - 7 && column === 6);

      if (onFinder) continue;

      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          (matrix[row + r] as Cell[])[column + c] = ring === 1 ? 0 : 1;
        }
      }
    }
  }

  // The dark module. Always set, always here.
  (matrix[size - 8] as Cell[])[8] = 1;

  // --- Reserve the format and version areas -------------------------------
  for (let i = 0; i < 9; i += 1) {
    if ((matrix[8] as Cell[])[i] === null) (matrix[8] as Cell[])[i] = 0;
    if ((matrix[i] as Cell[])[8] === null) (matrix[i] as Cell[])[8] = 0;
  }
  /*
   * The second format copy is NOT symmetrical, and the asymmetry matters.
   *
   * Along row 8 it is eight modules, columns size-1 down to size-8. Down
   * column 8 it is SEVEN, rows size-1 up to size-7 - because row size-8 in
   * that column is the dark module, which was set just above. Running both
   * sides to eight clears it, and a code with no dark module still decodes
   * on most readers, so nothing looks wrong until one refuses it.
   */
  for (let i = 0; i < 8; i += 1) {
    (matrix[8] as Cell[])[size - 1 - i] = 0;
    if (i < 7) (matrix[size - 1 - i] as Cell[])[8] = 0;
  }

  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        (matrix[i] as Cell[])[size - 11 + j] = 0;
        (matrix[size - 11 + j] as Cell[])[i] = 0;
      }
    }
  }

  // --- The data, in the zigzag the specification defines -------------------
  let bitIndex = 0;
  let upward = true;

  for (let column = size - 1; column > 0; column -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    if (column === 6) column -= 1;

    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;

      for (let offset = 0; offset < 2; offset += 1) {
        const x = column - offset;
        if ((matrix[row] as Cell[])[x] !== null) continue;

        const byte = codewords[bitIndex >>> 3] ?? 0;
        const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
        bitIndex += 1;

        (matrix[row] as Cell[])[x] = (bit ^ maskBit(mask, row, x)) as Cell;
      }
    }

    upward = !upward;
  }

  return matrix;
}

/** The eight mask patterns, as the specification numbers them. */
function maskBit(mask: number, row: number, column: number): number {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0 ? 1 : 0;
    case 1:
      return row % 2 === 0 ? 1 : 0;
    case 2:
      return column % 3 === 0 ? 1 : 0;
    case 3:
      return (row + column) % 3 === 0 ? 1 : 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0 ? 1 : 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0 ? 1 : 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0 ? 1 : 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0 ? 1 : 0;
  }
}

/**
 * The 15-bit format information: error-correction level and mask, BCH-coded.
 *
 * Level M is `00`. The generator is 0x537 and the result is XORed with 0x5412,
 * both of which are fixed by the specification - a code written without the
 * XOR scans as a different mask and decodes to noise.
 */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let value = data << 10;

  for (let i = 4; i >= 0; i -= 1) {
    if ((value >>> (i + 10)) & 1) value ^= 0x537 << i;
  }

  return ((data << 10) | value) ^ 0x5412;
}

/** The 18-bit version information, for versions 7 and up. */
function versionBits(version: number): number {
  let value = version << 12;

  for (let i = 5; i >= 0; i -= 1) {
    if ((value >>> (i + 12)) & 1) value ^= 0x1f25 << i;
  }

  return (version << 12) | value;
}

function applyFormatAndVersion(matrix: Cell[][], version: number, mask: number): void {
  const size = matrix.length;
  const format = formatBits(mask);

  for (let i = 0; i < 15; i += 1) {
    const bit: Cell = ((format >>> i) & 1) === 1 ? 1 : 0;

    // The copy beside the top-left finder.
    if (i < 6) (matrix[i] as Cell[])[8] = bit;
    else if (i === 6) (matrix[7] as Cell[])[8] = bit;
    else if (i === 7) (matrix[8] as Cell[])[8] = bit;
    else if (i === 8) (matrix[8] as Cell[])[7] = bit;
    else (matrix[8] as Cell[])[14 - i] = bit;

    // The second copy, split between the other two finders.
    if (i < 8) (matrix[8] as Cell[])[size - 1 - i] = bit;
    else (matrix[size - 15 + i] as Cell[])[8] = bit;
  }

  if (version < 7) return;

  const info = versionBits(version);

  for (let i = 0; i < 18; i += 1) {
    const bit: Cell = ((info >>> i) & 1) === 1 ? 1 : 0;
    const row = Math.floor(i / 3);
    const column = size - 11 + (i % 3);

    (matrix[row] as Cell[])[column] = bit;
    (matrix[column] as Cell[])[row] = bit;
  }
}

/**
 * The four penalty rules, summed.
 *
 * Lower is better. Evaluating all eight masks and taking the least-penalised
 * one is what keeps a code readable by a cheap camera; a fixed mask produces a
 * perfectly valid code that some phones take four attempts to read.
 */
function penalty(matrix: Cell[][]): number {
  const size = matrix.length;
  const at = (r: number, c: number): number => ((matrix[r] as Cell[])[c] === 1 ? 1 : 0);
  let score = 0;

  // Rule 1: runs of five or more of the same colour, in both directions.
  for (let i = 0; i < size; i += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;

      for (let j = 1; j < size; j += 1) {
        const previous = horizontal ? at(i, j - 1) : at(j - 1, i);
        const current = horizontal ? at(i, j) : at(j, i);

        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }

      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = at(r, c);
      if (value === at(r, c + 1) && value === at(r + 1, c) && value === at(r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like pattern 1:1:3:1:1 with four light modules beside
  // it, which is what a scanner mistakes for a finder.
  const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const REVERSED = [...PATTERN].reverse();

  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= size - 11; j += 1) {
      for (const pattern of [PATTERN, REVERSED]) {
        let horizontal = true;
        let vertical = true;

        for (let k = 0; k < 11; k += 1) {
          if (at(i, j + k) !== pattern[k]) horizontal = false;
          if (at(j + k, i) !== pattern[k]) vertical = false;
        }

        if (horizontal) score += 40;
        if (vertical) score += 40;
      }
    }
  }

  // Rule 4: how far the dark/light balance is from even.
  let dark = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) dark += at(r, c);
  }

  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * The finished module grid: true is a dark module.
 *
 * Exported for its own test and for nothing else. Its unit test decodes what
 * it draws, which is the only check that catches a wrong version table - the
 * component swallows an encoder failure on purpose, so a broken encoder shows
 * up on screen as a blank square rather than as an error.
 */
export function encodeQr(text: string): boolean[][] {
  const version = chooseVersion(new TextEncoder().encode(text).length);
  const codewords = buildCodewords(text, version);

  let best: Cell[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(version, codewords, mask);
    applyFormatAndVersion(candidate, version, mask);

    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  const matrix = best as Cell[][];
  return matrix.map((row) => row.map((cell) => cell === 1));
}
