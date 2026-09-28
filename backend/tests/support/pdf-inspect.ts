/**
 * Just enough of a PDF reader to test what this server renders: page sizes,
 * document info and the text on each page.
 *
 * Written for PDFKit's own output - Flate-compressed streams, embedded
 * Type0 fonts with a ToUnicode map, text drawn with TJ/Tj on hex glyph ids -
 * rather than for PDF in general. It exists so a regression test can read an
 * issued document the way a person would, without a PDF library on the CI
 * runner.
 */
import { inflateSync } from 'node:zlib';

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

export interface InspectedPdf {
  pages: { widthPt: number; heightPt: number; text: string }[];
  info: Record<string, string>;
}

function objects(bytes: Buffer): Map<number, PdfObject> {
  const source = bytes.toString('latin1');
  const found = new Map<number, PdfObject>();
  const pattern = /(\d+) 0 obj\s*([\s\S]*?)endobj/g;
  for (const match of source.matchAll(pattern)) {
    const id = Number(match[1]);
    const body = match[2] ?? '';
    const streamAt = body.indexOf('stream');
    if (streamAt < 0) {
      found.set(id, { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    let start = streamAt + 'stream'.length;
    if (body[start] === '\r') start += 1;
    if (body[start] === '\n') start += 1;
    const end = body.lastIndexOf('endstream');
    let raw = Buffer.from(body.slice(start, end), 'latin1');
    if (/\/FlateDecode/.test(dict)) {
      try {
        raw = inflateSync(raw);
      } catch {
        raw = inflateSync(raw.subarray(0, raw.length - 1));
      }
    }
    found.set(id, { dict, stream: raw });
  }
  return found;
}

function ref(dict: string, key: string): number | null {
  const match = new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(dict);
  return match === null ? null : Number(match[1]);
}

/** glyph id (hex) -> text, from a ToUnicode CMap. */
function cmap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  // A ligature maps to several units, and PDFKit writes them with a space: <0066 0069>.
  const decode = (hex: string) => String.fromCodePoint(...(hex.replace(/\s+/g, '').match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    for (const line of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
      const from = parseInt(line[1] ?? '0', 16);
      const to = parseInt(line[2] ?? '0', 16);
      const target = line[3] ?? '';
      if (target.startsWith('[')) {
        const values = [...target.matchAll(/<([0-9a-fA-F\s]+)>/g)].map((value) => value[1] ?? '');
        values.forEach((value, index) => map.set(from + index, decode(value)));
      } else {
        const base = parseInt(target.slice(1, -1), 16);
        for (let code = from; code <= to; code += 1) map.set(code, String.fromCodePoint(base + code - from));
      }
    }
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const line of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(line[1] ?? '0', 16), decode(line[2] ?? ''));
    }
  }
  return map;
}

export function inspectPdf(bytes: Buffer): InspectedPdf {
  const all = objects(bytes);

  // Font resource names (/F1 ...) to their ToUnicode maps. PDFKit names fonts
  // document-wide, so one map serves every page.
  const fontMaps = new Map<string, Map<number, string>>();
  for (const object of all.values()) {
    const fonts = /\/Font\s*<<([\s\S]*?)>>/.exec(object.dict);
    if (fonts === null) continue;
    for (const entry of (fonts[1] ?? '').matchAll(/\/(\w+)\s+(\d+) 0 R/g)) {
      const font = all.get(Number(entry[2]));
      const toUnicode = font === undefined ? null : ref(font.dict, 'ToUnicode');
      const stream = toUnicode === null ? null : (all.get(toUnicode)?.stream ?? null);
      if (stream !== null) fontMaps.set(entry[1] ?? '', cmap(stream.toString('latin1')));
    }
  }

  const root = [...all.values()].find((object) => /\/Type\s*\/Pages/.test(object.dict));
  const kids = [...(/\/Kids\s*\[([^\]]*)\]/.exec(root?.dict ?? '')?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));

  const pages = kids.map((id) => {
    const page = all.get(id);
    const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(page?.dict ?? '');
    const contents = ref(page?.dict ?? '', 'Contents');
    const stream = contents === null ? '' : (all.get(contents)?.stream?.toString('latin1') ?? '');
    return {
      widthPt: Number(box?.[3] ?? 0) - Number(box?.[1] ?? 0),
      heightPt: Number(box?.[4] ?? 0) - Number(box?.[2] ?? 0),
      text: pageText(stream, fontMaps),
    };
  });

  const info: Record<string, string> = {};
  const infoId = /\/Info\s+(\d+) 0 R/.exec(bytes.toString('latin1'))?.[1];
  const infoDict = infoId === undefined ? '' : (all.get(Number(infoId))?.dict ?? '');
  for (const entry of infoDict.matchAll(/\/(\w+)\s*(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F]*>|\d+ 0 R)/g)) {
    let raw = entry[2] ?? '';
    // PDFKit writes each value as an object of its own.
    if (raw.endsWith(' R')) raw = (all.get(Number(raw.split(' ')[0]))?.dict ?? '').trim();
    info[entry[1] ?? ''] = raw.startsWith('(') ? literal(raw.slice(1, -1)) : hexText(raw.slice(1, -1));
  }
  return { pages, info };
}

function literal(value: string): string {
  return value.replace(/\\([nrtbf()\\]|\d{1,3})/g, (_match, escape: string) => {
    if (/^\d/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[escape] ?? escape;
  });
}

/** A hex string in the info dictionary: UTF-16BE with a BOM, as PDFKit writes non-ASCII. */
function hexText(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) out += String.fromCharCode((bytes[index] ?? 0) * 256 + (bytes[index + 1] ?? 0));
    return out;
  }
  return bytes.toString('latin1');
}

function pageText(stream: string, fonts: Map<string, Map<number, string>>): string {
  const lines: string[] = [];
  let font = new Map<number, string>();
  const tokens = /\/(\w+)\s+[\d.]+\s+Tf|\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g;
  for (const match of stream.matchAll(tokens)) {
    if (match[1] !== undefined) {
      font = fonts.get(match[1]) ?? new Map();
      continue;
    }
    const hexes = match[2] !== undefined ? [...match[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((item) => item[1] ?? '') : [match[3] ?? ''];
    let text = '';
    for (const hex of hexes) {
      for (const unit of hex.match(/.{4}/g) ?? []) text += font.get(parseInt(unit, 16)) ?? '';
    }
    lines.push(text);
  }
  return lines.join('\n');
}
