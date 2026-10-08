/**
 * One legal-document draft file: a header, a line `---`, then the body.
 * Read by `import-drafts.cli.ts`; see that file for the format.
 */
import {
  LEGAL_BODY_MAX,
  LEGAL_TITLE_MAX,
  LEGAL_VERSION_PATTERN,
  normaliseLegalText,
  type LegalDocumentKindName,
} from '../../domain/legal-document.js';
import { isSupportedLanguage } from '../identity/language.service.js';
import { isLegalDocumentKind } from './legal-document.service.js';

export interface DraftFile {
  kind: LegalDocumentKindName;
  version: string;
  locale: string;
  title: string;
  body: string;
}

/** The header and body of one draft file. Throws with the file's name on anything malformed. */
export function parseDraftFile(name: string, text: string): DraftFile {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const split = normalised.indexOf('\n---\n');
  if (split < 0) throw new Error(`${name}: no "---" line between the header and the text`);

  const header = new Map<string, string>();
  for (const line of normalised.slice(0, split).split('\n')) {
    const match = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (match !== null) header.set(match[1] ?? '', (match[2] ?? '').trim());
  }

  const kind = header.get('kind') ?? '';
  if (!isLegalDocumentKind(kind)) throw new Error(`${name}: unknown kind "${kind}"`);

  const draft: DraftFile = {
    kind,
    version: header.get('version') ?? '',
    locale: header.get('locale') ?? '',
    title: normaliseLegalText(header.get('title') ?? ''),
    body: normaliseLegalText(normalised.slice(split + 5)),
  };

  if (!LEGAL_VERSION_PATTERN.test(draft.version)) throw new Error(`${name}: version "${draft.version}" is not valid`);
  if (!isSupportedLanguage(draft.locale)) throw new Error(`${name}: language "${draft.locale}" is not supported`);
  if (draft.title.length === 0 || draft.title.length > LEGAL_TITLE_MAX) throw new Error(`${name}: title is empty or too long`);
  if (draft.body.length === 0 || draft.body.length > LEGAL_BODY_MAX) throw new Error(`${name}: text is empty or too long`);
  return draft;
}
