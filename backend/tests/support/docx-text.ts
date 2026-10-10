/**
 * The paragraphs of a Word document, in order, with their style - enough to
 * compare a legal draft against the .docx it was taken from.
 *
 * A .docx is a zip; `word/document.xml` holds the text. Read with Node's own
 * zlib, so no dependency is added for a test helper. Tables are read cell by
 * cell, in document order.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

function zipEntry(zip: Buffer, name: string): Buffer {
  // End of central directory: the last 22+ bytes, signature 0x06054b50.
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('Not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entryName = zip.toString('utf8', at + 46, at + 46 + nameLength);
    if (entryName === name) {
      const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataAt, dataAt + compressed);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${name} is not in the zip`);
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export interface DocxParagraph {
  style: string;
  text: string;
}

export function docxParagraphs(path: string): DocxParagraph[] {
  const xml = zipEntry(readFileSync(path), 'word/document.xml').toString('utf8');
  const paragraphs: DocxParagraph[] = [];
  for (const block of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? '';
    const text = [...block.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)]
      .map((match) => (match[0] === '<w:tab/>' ? '\t' : decode(match[1] ?? '')))
      .join('');
    if (text.trim() !== '') paragraphs.push({ style, text });
  }
  return paragraphs;
}

/** Every word of a text, single-spaced: the comparison ignores layout and nothing else. */
export function normaliseWords(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
