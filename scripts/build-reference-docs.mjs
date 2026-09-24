/**
 * Build the generated reference documents in `docs/reference/`.
 *
 *   docs/reference/DATABASE-TABLES.md   every table, column, index and enum
 *   docs/reference/API-ENDPOINTS.md     every HTTP endpoint and who may call it
 *   docs/reference/ERROR-CODES.md       every error code the API can return
 *
 * They are read out of the code itself - `backend/prisma/schema.prisma`,
 * `backend/src/http/app.ts` and the route files, `backend/src/domain/errors.ts`
 * - because a hand-kept list of 226 tables and 800 endpoints is wrong within a
 * week and nobody notices. The hand-written guides beside them (PRD, database
 * design, API guide, screens) explain; these list.
 *
 *   npm run docs          rewrite the three files
 *   npm run docs:check    fail if any of them no longer matches the code
 *
 * Nothing here needs a database, a running server or the backend's
 * node_modules. It parses text, so it works on a fresh checkout and in CI.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'reference');
const SCHEMA = join(ROOT, 'backend', 'prisma', 'schema.prisma');
const HTTP_DIR = join(ROOT, 'backend', 'src', 'http');
const ERRORS = join(ROOT, 'backend', 'src', 'domain', 'errors.ts');
const API_PREFIX = '/api/v1';

const CHECK = process.argv.includes('--check');
/** List the routes that have no description, by file and line, and write nothing. */
const UNDOCUMENTED = process.argv.includes('--undocumented');

/** Read as text with line endings normalised - source files here are CRLF. */
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const GENERATED_NOTE = (source) =>
  [
    '> **Generated file - do not edit by hand.** It is rebuilt from',
    `> ${source} by \`scripts/build-reference-docs.mjs\`.`,
    '> After changing that code, run `cd scripts; npm run docs` and commit the result.',
    '> `npm run docs:check` fails when this file has fallen behind the code.',
  ].join('\n');

/** Markdown-table-safe text. */
const cell = (text) =>
  String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();

const anchor = (prefix, name) => `${prefix}-${name.toLowerCase()}`;

/** First paragraph of a doc comment, shortened to something a table can hold. */
function summarise(lines, max = 320) {
  const paragraph = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  let text = paragraph.join(' ');
  if (text.length > max) text = `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return text;
}

// ===========================================================================
// DATABASE
// ===========================================================================

function parseSchema(source) {
  const lines = source.split('\n');
  const sections = [];
  let section = { title: 'General', models: [], enums: [] };
  sections.push(section);

  let docBuffer = [];
  let pendingBanner = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // A banner is a `// ====` line followed by `// TITLE`.
    if (/^\/\/ ={10,}/.test(trimmed)) {
      pendingBanner = true;
      continue;
    }
    if (pendingBanner) {
      pendingBanner = false;
      let title = trimmed.replace(/^\/\/\s?/, '').trim();
      // A long title wraps onto the next comment lines, up to a blank `//`.
      while (/^\/\/\s*\S/.test(lines[i + 1]?.trim() ?? '') && !/^\/\/ =/.test(lines[i + 1].trim())) {
        i++;
        title += ` ${lines[i].trim().replace(/^\/\/\s?/, '')}`;
      }
      if (title !== '' && !/^=+$/.test(title) && i > 5) {
        const titled = sentenceCase(title);
        section = { title: titled, models: [], enums: [] };
        sections.push(section);
      }
      docBuffer = [];
      continue;
    }

    if (trimmed.startsWith('///')) {
      docBuffer.push(trimmed.replace(/^\/\/\/\s?/, ''));
      continue;
    }

    const block = /^(model|enum)\s+(\w+)\s*\{/.exec(trimmed);
    if (block !== null) {
      const [, kind, name] = block;
      const body = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '}') body.push(lines[j++]);
      const doc = summarise(docBuffer, 600);
      if (kind === 'model') section.models.push(parseModel(name, body, doc));
      else section.enums.push(parseEnum(name, body, doc));
      docBuffer = [];
      i = j;
      continue;
    }

    if (trimmed === '' || trimmed.startsWith('//')) {
      if (trimmed === '') continue;
      // An ordinary `//` comment between a `///` block and its declaration
      // does not break the attachment.
      continue;
    }
    docBuffer = [];
  }
  return sections.filter((s) => s.models.length + s.enums.length > 0);
}

const ACRONYMS = ['ERP', 'GDPR', 'EU', 'VAT', 'API', 'GPSR', 'MDR', 'FX', 'SLA', 'GST', 'MFA', 'SKU', 'QR', 'UI'];

/** "EU VAT" stays "EU VAT"; "SEQUENCES" becomes "Sequences". */
function sentenceCase(title) {
  let text = title.toLowerCase().replace(/^./, (c) => c.toUpperCase());
  for (const a of ACRONYMS) text = text.replace(new RegExp(`\\b${a}\\b`, 'gi'), a);
  return text
    .replace(/\bmariadb\b/gi, 'MariaDB')
    .replace(/\bredis\b/gi, 'Redis')
    .replace(/\btallyprime\b/gi, 'TallyPrime');
}

function parseModel(name, body, doc) {
  const model = { name, doc, table: name, fields: [], indexes: [], relations: [] };
  let fieldDoc = [];
  for (const raw of body) {
    const line = raw.trim();
    if (line.startsWith('///')) {
      fieldDoc.push(line.replace(/^\/\/\/\s?/, ''));
      continue;
    }
    if (line === '' || line.startsWith('//')) {
      if (line === '') fieldDoc = fieldDoc.length > 0 ? fieldDoc : [];
      continue;
    }
    if (line.startsWith('@@')) {
      const map = /^@@map\("([^"]+)"\)/.exec(line);
      if (map) model.table = map[1];
      else model.indexes.push(line.replace(/\s*\/\/.*$/, ''));
      fieldDoc = [];
      continue;
    }
    const m = /^(\w+)\s+([\w]+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (m === null) continue;
    const [, fieldName, type, list, optional, rest] = m;
    const attrs = rest.replace(/\s*\/\/.*$/, '');
    const field = {
      name: fieldName,
      type,
      list: list !== undefined,
      optional: optional !== undefined,
      attrs,
      doc: summarise(fieldDoc),
    };
    fieldDoc = [];
    const column = /@map\("([^"]+)"\)/.exec(attrs);
    if (column) field.column = column[1];
    const relation = /@relation\(([^)]*)\)/.exec(attrs);
    field.relationArgs = relation ? relation[1] : null;
    model.fields.push(field);
  }
  return model;
}

function parseEnum(name, body, doc) {
  const values = [];
  let valueDoc = [];
  for (const raw of body) {
    const line = raw.trim();
    if (line.startsWith('///')) {
      valueDoc.push(line.replace(/^\/\/\/\s?/, ''));
      continue;
    }
    const inline = /^(\w+)\s*(?:\/\/\s?(.*))?$/.exec(line);
    if (inline && !line.startsWith('//')) {
      values.push({ name: inline[1], doc: summarise(valueDoc) || (inline[2] ?? '').trim() });
      valueDoc = [];
    } else if (line === '') {
      // keep a doc block attached across a blank line only if it is empty
    }
  }
  return { name, doc, values };
}

function describeType(field, typeKind) {
  let type = field.type;
  const db = /@db\.(\w+)(\(([^)]*)\))?/.exec(field.attrs);
  if (db) type += ` · ${db[1]}${db[2] ?? ''}`;
  if (typeKind === 'enum') type = `enum ${field.type}`;
  if (field.list) type += '[]';
  return type;
}

function keyFlags(field) {
  const flags = [];
  if (/@id\b/.test(field.attrs)) flags.push('PK');
  if (/@unique\b/.test(field.attrs)) flags.push('UNIQUE');
  if (/@updatedAt\b/.test(field.attrs)) flags.push('auto-updated');
  return flags;
}

function defaultOf(field) {
  const at = field.attrs.indexOf('@default(');
  if (at === -1) return '';
  let depth = 0;
  for (let i = at + 8; i < field.attrs.length; i++) {
    if (field.attrs[i] === '(') depth++;
    else if (field.attrs[i] === ')') {
      depth--;
      if (depth === 0) return field.attrs.slice(at + 9, i);
    }
  }
  return '';
}

function buildDatabaseDoc(sections) {
  const models = new Map();
  const enums = new Map();
  for (const s of sections) {
    for (const m of s.models) models.set(m.name, m);
    for (const e of s.enums) enums.set(e.name, e);
  }

  // Foreign keys: the side of a relation that holds `fields: [...]`.
  for (const model of models.values()) {
    for (const field of model.fields) {
      if (!models.has(field.type) || field.relationArgs === null) continue;
      const fk = /fields:\s*\[([^\]]*)\]/.exec(field.relationArgs);
      if (!fk) continue;
      const refs = /references:\s*\[([^\]]*)\]/.exec(field.relationArgs);
      const onDelete = /onDelete:\s*(\w+)/.exec(field.relationArgs);
      const onUpdate = /onUpdate:\s*(\w+)/.exec(field.relationArgs);
      const fkFields = fk[1].split(',').map((x) => x.trim());
      const fkOptional = fkFields.some(
        (name) => model.fields.find((f) => f.name === name)?.optional,
      );
      const fkUnique =
        fkFields.length === 1 &&
        (model.fields.find((f) => f.name === fkFields[0])?.attrs.includes('@unique') ?? false);
      model.relations.push({
        field: field.name,
        target: field.type,
        fkFields,
        references: refs ? refs[1].split(',').map((x) => x.trim()) : [],
        onDelete: onDelete ? onDelete[1] : 'default',
        onUpdate: onUpdate ? onUpdate[1] : 'default',
        optional: fkOptional,
        oneToOne: fkUnique,
      });
    }
  }

  const totalModels = models.size;
  const totalEnums = enums.size;
  const totalIndexes = [...models.values()].reduce((n, m) => n + m.indexes.length, 0);
  const out = [];
  out.push('# Database reference: every table, column, index and enum');
  out.push('');
  out.push(GENERATED_NOTE('`backend/prisma/schema.prisma`'));
  out.push('');
  out.push(
    'This is the complete list. For **why** the database is shaped this way - the ' +
      'principles, the domains, the life of an order in rows - read ' +
      '[`../DATABASE-DESIGN.md`](../DATABASE-DESIGN.md) first.',
  );
  out.push('');
  out.push(
    `**${totalModels} tables · ${totalEnums} enums · ${totalIndexes} extra indexes and ` +
      `unique keys**, in ${sections.length} groups. The groups follow the section banners in the schema file.`,
  );
  out.push('');
  out.push('## How to read this file');
  out.push('');
  out.push('- **Model** is the name the code uses. **Table** is the name in MariaDB.');
  out.push('- **Type** is the Prisma type, then the exact database type after the dot, e.g. `String · Char(26)`.');
  out.push('  - `Char(26)` holding an id is a **ULID**: a sortable, 26-character unique id.');
  out.push('  - `BigInt` holding money (a name ending in `Minor`) is an amount in **minor units** - paise, cents. `12345` in INR is ₹123.45. Money is never a decimal fraction here.');
  out.push('  - `DateTime · DateTime(3)` is an instant in **UTC**, to the millisecond.');
  out.push('- **Null?** "yes" means the column may be empty.');
  out.push('- **Key**: `PK` primary key, `FK →` foreign key (points at another table), `UNIQUE` no two rows may share it.');
  out.push('- **List** rows (a type ending `[]`) are not columns. They are the other side of a relation: "this row has many of those".');
  out.push('- In each diagram, `||--o{` means "one to many", `||--o|` "one to zero-or-one", `}o--||` "many to one".');
  out.push('');
  out.push('## Groups');
  out.push('');
  out.push('| Group | Tables | Enums |');
  out.push('|---|---|---|');
  for (const s of sections) {
    out.push(
      `| [${cell(s.title)}](#${anchor('group', slug(s.title))}) | ${s.models.length} | ${s.enums.length} |`,
    );
  }
  out.push('');

  for (const s of sections) {
    out.push(`<a id="${anchor('group', slug(s.title))}"></a>`);
    out.push('');
    out.push(`## ${s.title}`);
    out.push('');
    if (s.models.length > 0) {
      out.push(s.models.map((m) => `[${m.name}](#${anchor('model', m.name)})`).join(' · '));
      out.push('');
      const diagram = erDiagram(s.models, models);
      if (diagram !== null) {
        out.push('```mermaid');
        out.push(diagram);
        out.push('```');
        out.push('');
      }
    }
    for (const model of s.models) out.push(...modelSection(model, models, enums));
    if (s.enums.length > 0) {
      out.push(`### Enums in ${s.title}`);
      out.push('');
      for (const e of s.enums) out.push(...enumSection(e));
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function erDiagram(sectionModels, allModels) {
  const lines = ['erDiagram'];
  const seen = new Set();
  for (const model of sectionModels) {
    for (const rel of model.relations) {
      const key = `${model.name}>${rel.target}>${rel.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // parent ||--o{ child : "field"
      const parentSide = rel.optional ? '|o' : '||';
      const childSide = rel.oneToOne ? 'o|' : 'o{';
      lines.push(`    ${rel.target} ${parentSide}--${childSide} ${model.name} : "${rel.field}"`);
    }
  }
  for (const model of sectionModels) {
    const cols = model.fields
      .filter((f) => !allModels.has(f.type) && !f.list)
      .filter(
        (f) =>
          /@id\b/.test(f.attrs) ||
          model.relations.some((r) => r.fkFields.includes(f.name)) ||
          /status$/i.test(f.name) ||
          /Minor$/.test(f.name),
      )
      .slice(0, 14);
    const body = cols.map((f) => {
      const isPk = /@id\b/.test(f.attrs);
      const isFk = model.relations.some((r) => r.fkFields.includes(f.name));
      const key = isPk && isFk ? ' PK, FK' : isPk ? ' PK' : isFk ? ' FK' : '';
      return `        ${f.type.replace(/\W/g, '')} ${f.name}${key}`;
    });
    lines.push(`    ${model.name} {`);
    lines.push(...(body.length > 0 ? body : ['        String id PK']));
    lines.push('    }');
  }
  if (lines.length === 1) return null;
  return lines.join('\n');
}

function modelSection(model, models, enums) {
  const out = [];
  out.push(`<a id="${anchor('model', model.name)}"></a>`);
  out.push('');
  out.push(`### ${model.name}`);
  out.push('');
  out.push(`Table \`${model.table}\``);
  out.push('');
  if (model.doc) {
    out.push(model.doc);
    out.push('');
  }
  out.push('| Column | Type | Null? | Key | Default | Notes |');
  out.push('|---|---|---|---|---|---|');
  const lists = [];
  for (const field of model.fields) {
    if (models.has(field.type)) {
      if (field.list) lists.push(field);
      else if (field.relationArgs === null || !/fields:/.test(field.relationArgs)) lists.push(field);
      continue;
    }
    const kind = enums.has(field.type) ? 'enum' : 'scalar';
    const keys = keyFlags(field);
    const rel = model.relations.find((r) => r.fkFields.includes(field.name));
    if (rel) {
      keys.push(`FK → [${rel.target}](#${anchor('model', rel.target)})`);
    }
    let type = cell(describeType(field, kind));
    if (kind === 'enum') type = `[${type}](#${anchor('enum', field.type)})`;
    let note = field.doc;
    if (rel) note = `${note}${note ? ' ' : ''}(on delete: ${rel.onDelete})`.trim();
    out.push(
      `| \`${field.column ?? field.name}\` | ${type} | ${field.optional ? 'yes' : ''} | ${keys.join(', ')} | ${cell(defaultOf(field))} | ${cell(note)} |`,
    );
  }
  out.push('');

  const refs = model.relations;
  if (refs.length > 0 || lists.length > 0) {
    out.push('**Relations**');
    out.push('');
    for (const r of refs) {
      out.push(
        `- \`${r.field}\` → [${r.target}](#${anchor('model', r.target)}) via \`${r.fkFields.join(', ')}\`` +
          ` - ${r.oneToOne ? 'one-to-one' : 'many-to-one'}, ${r.optional ? 'optional' : 'required'}, on delete **${r.onDelete}**` +
          (r.onUpdate !== 'default' ? `, on update **${r.onUpdate}**` : ''),
      );
    }
    for (const l of lists) {
      out.push(
        `- \`${l.name}\` ← [${l.type}](#${anchor('model', l.type)}) - ${l.list ? 'has many' : 'has zero or one'}`,
      );
    }
    out.push('');
  }

  if (model.indexes.length > 0) {
    out.push('**Indexes and keys**');
    out.push('');
    for (const index of model.indexes) out.push(`- \`${index}\``);
    out.push('');
  }
  return out;
}

function enumSection(e) {
  const out = [];
  out.push(`<a id="${anchor('enum', e.name)}"></a>`);
  out.push('');
  out.push(`#### enum ${e.name}`);
  out.push('');
  if (e.doc) {
    out.push(e.doc);
    out.push('');
  }
  out.push('| Value | Meaning |');
  out.push('|---|---|');
  for (const v of e.values) out.push(`| \`${v.name}\` | ${cell(v.doc)} |`);
  out.push('');
  return out;
}

// ===========================================================================
// API
// ===========================================================================

/** `registerX` (or `authRoutes('ADMIN')`) -> the prefix it is mounted under. */
function parseMounts(appSource) {
  const imports = new Map();
  for (const m of appSource.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/routes\/([\w.-]+)\.js'/g)) {
    for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      imports.set(name.replace(/^type\s+/, ''), `${m[2]}.ts`);
    }
  }
  const mounts = [];
  const re = /app\.register\(\s*(\w+)(\(\s*'(\w+)'\s*\))?\s*(?:,\s*\{\s*prefix:\s*(`[^`]*`|'[^']*'|API_PREFIX)\s*,?\s*\})?\s*\)/g;
  for (const m of appSource.matchAll(re)) {
    const fn = m[1];
    if (!imports.has(fn)) continue;
    let prefix = m[4] ?? "''";
    prefix = prefix === 'API_PREFIX' ? API_PREFIX : prefix.slice(1, -1).replace('${API_PREFIX}', API_PREFIX);
    mounts.push({ fn, audience: m[3] ?? null, file: imports.get(fn), prefix });
  }
  return mounts;
}

/** Split a route file into its exported register functions. */
function functionsOf(source) {
  const starts = [];
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    starts.push({ name: m[1], index: m.index });
  }
  for (const m of source.matchAll(/export\s+const\s+(\w+)\s*=/g)) {
    starts.push({ name: m[1], index: m.index });
  }
  starts.sort((a, b) => a.index - b.index);
  return starts.map((s, i) => ({
    name: s.name,
    start: s.index,
    end: i + 1 < starts.length ? starts[i + 1].index : source.length,
  }));
}

function precedingComment(source, index) {
  const before = source.slice(0, index).split('\n');
  before.pop(); // the partial line the call starts on
  const lines = [];
  while (before.length > 0) {
    const line = before[before.length - 1].trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/**') || line.endsWith('*/')) {
      lines.unshift(line);
      before.pop();
    } else break;
  }
  const text = lines
    .map((l) =>
      l
        .replace(/^\/\*\*?\s?/, '')
        .replace(/\*\/$/, '')
        .replace(/^\*\s?/, '')
        .replace(/^\/\/\s?/, ''),
    )
    .map((l) => l.trim());
  // Drop decorative rules like `// --- Orders ---`
  return summarise(text.filter((l) => !/^[-=]{3,}/.test(l)), 400);
}

const GUARD_RE =
  /\b(requireAdmin|requireSeller|requireSellerBeforeLock|requireTradingSeller|requireLogistics|requireLogisticsSession|requireCustomer|requireAuthenticated|optionalCustomer|requireFeature)\b(\(([^)]*)\))?/g;

function guardsIn(text) {
  const found = [];
  for (const g of text.matchAll(GUARD_RE)) {
    const args = (g[3] ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => a.replace(/^(Permission|SellerPermission|LogisticsPermission)\./, ''));
    found.push({ name: g[1], args });
  }
  return found;
}

function audienceOf(guards, url, mount) {
  const names = guards.map((g) => g.name);
  if (names.includes('requireAdmin')) return 'Staff';
  if (names.some((n) => n.startsWith('requireSeller') || n === 'requireTradingSeller')) return 'Seller';
  if (names.some((n) => n.startsWith('requireLogistics'))) return 'Logistics';
  if (names.includes('requireCustomer')) return 'Customer';
  if (names.includes('requireAuthenticated')) return 'Signed in';
  if (names.includes('optionalCustomer')) return 'Public (customer optional)';
  if (mount.audience) return `Public (${mount.audience.toLowerCase()} sign-in)`;
  if (/webhook/i.test(url)) return 'Webhook (signature)';
  return 'Public';
}

function parseRoutes(mount, source) {
  const fns = functionsOf(source);
  const fn = fns.find((f) => f.name === mount.fn);
  const start = fn ? fn.start : 0;
  const end = fn ? fn.end : source.length;
  const body = source.slice(start, end);

  // Hooks applied to every route registered after them in this function.
  const hooks = [];
  for (const h of body.matchAll(/app\.addHook\(\s*'(?:preHandler|onRequest)'\s*,\s*([^;]+?)\);/g)) {
    hooks.push({ index: h.index, guards: guardsIn(h[1]) });
  }

  // `authRoutes(kind)` registers some routes for one audience only, behind an
  // `if (kind === 'ADMIN' && env.FEATURE_X) {` block. Find those blocks so a
  // route is listed only under the audiences that really have it.
  const conditions = [];
  for (const c of body.matchAll(/\bif \(([^{]*\bkind\b[^{]*)\)\s*\{/g)) {
    const open = c.index + c[0].length - 1;
    conditions.push({ start: open, end: matchingBrace(body, open), test: c[1] });
  }

  const routes = [];
  const call = /\bapp\.(get|post|put|patch|delete)\s*(<)?/g;
  for (const m of body.matchAll(call)) {
    let i = m.index + m[0].length;
    if (m[2] === '<') {
      let depth = 1;
      while (i < body.length && depth > 0) {
        if (body[i] === '<') depth++;
        else if (body[i] === '>') depth--;
        i++;
      }
    }
    const open = /^\s*\(\s*(['"`])([^'"`]*)\1/.exec(body.slice(i));
    if (open === null) continue;
    const path = open[2];
    const afterPath = i + open[0].length;
    const tail = body.slice(afterPath, afterPath + 2000);
    const handlerAt = tail.search(/\basync\b|=>|\bfunction\b/);
    const options = handlerAt === -1 ? '' : tail.slice(0, handlerAt);
    const guards = guardsIn(options);
    for (const h of hooks) if (h.index < m.index) guards.unshift(...h.guards);

    const flags = [];
    let registered = true;
    for (const c of conditions) {
      if (m.index < c.start || m.index > c.end) continue;
      for (const part of c.test.split('&&').map((p) => p.trim())) {
        const is = /^kind\s*(===|!==)\s*'(\w+)'$/.exec(part);
        if (is) {
          const same = mount.audience === is[2];
          if ((is[1] === '===') !== same) registered = false;
        }
        const flag = /^env\.(\w+)$/.exec(part);
        if (flag) flags.push(flag[1]);
      }
    }
    if (!registered) continue;

    const url = (path === '/' && mount.prefix !== '' ? mount.prefix : `${mount.prefix}${path}`) || '/';
    const written = precedingComment(body, m.index);
    let comment = written;
    if (flags.length > 0) comment = `${comment} *Only when \`${flags.join('`, `')}\` is on.*`.trim();
    routes.push({
      method: m[1].toUpperCase(),
      url,
      guards,
      comment,
      written,
      line: source.slice(0, start + m.index).split('\n').length,
      file: mount.file,
      audience: audienceOf(guards, url, mount),
    });
  }
  return routes;
}

/** Index of the `}` closing the `{` at `open`, skipping strings and comments. */
function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) return text.length;
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

function parseOpenApiSummaries(source) {
  const map = new Map();
  for (const m of source.matchAll(/'(GET|POST|PUT|PATCH|DELETE) ([^']+)':\s*\{\s*summary:\s*'((?:[^'\\]|\\.)*)'/g)) {
    map.set(`${m[1]} ${m[2]}`, m[3].replace(/\\'/g, "'"));
  }
  return map;
}

function areaOf(url) {
  const rest = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url;
  const parts = rest.split('/').filter(Boolean);
  if (parts.length === 0) return 'Root';
  if (['admin', 'seller', 'logistics', 'account', 'integrations'].includes(parts[0]) && parts[1]) {
    return `${parts[0]}/${parts[1].startsWith(':') ? '' : parts[1]}`.replace(/\/$/, '');
  }
  return parts[0];
}

const under = (url, part) => url === `${API_PREFIX}/${part}` || url.startsWith(`${API_PREFIX}/${part}/`);

/** First match wins, so the order matters: the URL decides before the guard. */
const ZONES = [
  ['Admin panel (staff)', (u) => under(u, 'admin')],
  ['Logistics partner portal', (u) => under(u, 'logistics')],
  ['Seller Hub', (u, a) => under(u, 'seller') || under(u, 'sellers') || a === 'Seller'],
  [
    'Webhooks, integrations and health',
    (u, a) => a.startsWith('Webhook') || under(u, 'integrations') || !u.startsWith(API_PREFIX),
  ],
  ['Customer account', (u, a) => a === 'Customer' || a === 'Signed in'],
  ['Public and storefront', () => true],
];

const ACTION_WORDS = new Set([
  'approve', 'reject', 'cancel', 'submit', 'publish', 'unpublish', 'pause', 'resume', 'archive',
  'restore', 'retry', 'confirm', 'verify', 'invite', 'accept', 'decline', 'test', 'sync', 'refund',
  'suspend', 'reactivate', 'activate', 'deactivate', 'complete', 'dispatch', 'close', 'reopen',
  'skip', 'preview', 'import', 'export', 'duplicate', 'claim', 'release', 'assign', 'pair',
  'heartbeat', 'resend', 'check', 'rotate-token', 'rotate', 'revoke', 'disconnect', 'connect',
]);

const words = (segment) => segment.replace(/-/g, ' ');

/**
 * A plain description read from the method and path, for a route with no
 * comment. Shown in italics so a reader knows it was inferred, not written.
 */
function inferDescription(method, url) {
  const parts = url.replace(API_PREFIX, '').split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  const nouns = parts.filter((p) => !p.startsWith(':'));
  const thing = words(nouns[nouns.length - 1] ?? 'resource');
  const owner = nouns.length > 1 ? words(nouns[nouns.length - 2]) : '';
  if (ACTION_WORDS.has(last)) {
    const verb = words(last);
    return `${verb[0].toUpperCase()}${verb.slice(1)}${owner ? ` the ${owner.replace(/s$/, '')}` : ''}`;
  }
  const one = last.startsWith(':');
  switch (method) {
    case 'GET':
      return one ? `Read one ${thing.replace(/s$/, '')}` : `Read ${thing}`;
    case 'POST':
      if (!one && thing.endsWith('s')) return `Create a new ${thing.replace(/s$/, '')}`;
      return `Run "${[owner, thing].filter(Boolean).join(' ')}"`;
    case 'PUT':
      return one ? `Replace one ${thing.replace(/s$/, '')}` : `Replace ${thing}`;
    case 'PATCH':
      return one ? `Change one ${thing.replace(/s$/, '')}` : `Change ${thing}`;
    case 'DELETE':
      return one ? `Remove one ${thing.replace(/s$/, '')}` : `Remove ${thing}`;
    default:
      return '';
  }
}

function buildApiDoc() {
  const appSource = read(join(HTTP_DIR, 'app.ts'));
  const mounts = parseMounts(appSource);
  const summaries = parseOpenApiSummaries(read(join(HTTP_DIR, 'openapi.ts')));
  const routes = [];
  const cache = new Map();
  for (const mount of mounts) {
    const path = join(HTTP_DIR, 'routes', mount.file);
    if (!cache.has(path)) cache.set(path, read(path));
    routes.push(...parseRoutes(mount, cache.get(path)));
  }
  // Mounted by the health plugin without a prefix.
  const seen = new Set();
  const unique = routes.filter((r) => {
    const k = `${r.method} ${r.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (UNDOCUMENTED) {
    // A route with neither a comment above it nor an OpenAPI summary.
    const missing = unique.filter((r) => r.written === '' && !summaries.has(`${r.method} ${r.url}`));
    for (const r of missing) {
      console.log(`backend/src/http/routes/${r.file}:${r.line}  ${r.method} ${r.url}`);
    }
    console.log(`\n${missing.length} of ${unique.length} endpoints have no description.`);
  }

  const zones = ZONES.map(([title]) => ({ title, routes: [] }));
  for (const r of unique) {
    const at = ZONES.findIndex(([, test]) => test(r.url, r.audience));
    zones[at].routes.push(r);
  }

  const out = [];
  out.push('# API reference: every endpoint');
  out.push('');
  out.push(GENERATED_NOTE('the route files in `backend/src/http/routes/` and `backend/src/http/app.ts`'));
  out.push('');
  out.push(
    'This is the complete list. For **how** to call the API - signing in, cookies, money, ' +
      'errors, webhooks, worked examples - read [`../API.md`](../API.md) first.',
  );
  out.push('');
  out.push(`**${unique.length} endpoints** in ${mounts.length} route groups. Every path starts from the backend's own address, for example \`http://localhost:4000\`.`);
  out.push('');
  out.push('## How to read this file');
  out.push('');
  out.push('- **Who** is who may call it:');
  out.push('  - **Public** - nobody needs to be signed in.');
  out.push('  - **Customer** - a signed-in storefront customer. **Signed in** - any signed-in user of the named kind.');
  out.push('  - **Seller** - a customer who is also a marketplace seller, with the seller permission shown.');
  out.push('  - **Staff** - a member of the operator\'s staff, signed in to the admin panel, with the permission shown.');
  out.push('  - **Logistics** - a person from a logistics partner company, signed in to the partner portal.');
  out.push('  - **Webhook (signature)** - called by another system (a payment gateway, a carrier, an ERP). It proves who it is with a signature, not a sign-in.');
  out.push('- **Guard** is the exact check in the code, and the permission it asks for. `TradingSeller` means the seller must be approved and trading, not just applied.');
  out.push('- `:id` in a path is a placeholder: put the real value there.');
  out.push('- **What it does** comes from the comment above the route in the code, or from the OpenAPI summary. Text in *italics* had neither, so it is read from the method and the path - a rough guide, not a promise. [`../API.md`](../API.md) explains the important ones properly.');
  out.push('- A path shown without a trailing slash, such as `/api/v1/cart`, also answers with one (`/api/v1/cart/`).');
  out.push('');
  out.push('## Zones');
  out.push('');
  out.push('| Zone | Endpoints |');
  out.push('|---|---|');
  for (const z of zones) out.push(`| [${z.title}](#${slug(z.title)}) | ${z.routes.length} |`);
  out.push('');

  for (const z of zones) {
    out.push(`## ${z.title}`);
    out.push('');
    const byArea = new Map();
    for (const r of z.routes) {
      const a = areaOf(r.url);
      if (!byArea.has(a)) byArea.set(a, []);
      byArea.get(a).push(r);
    }
    for (const [area, list] of [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`### \`${area}\``);
      out.push('');
      const files = [...new Set(list.map((r) => r.file))].map((f) => `\`backend/src/http/routes/${f}\``);
      out.push(`Defined in ${files.join(', ')}.`);
      out.push('');
      out.push('| Method | Path | Who | Guard | What it does |');
      out.push('|---|---|---|---|---|');
      for (const r of list) {
        const guard = r.guards
          .map((g) => `${g.name.replace(/^require/, '')}${g.args.length ? `(${g.args.join(', ')})` : ''}`)
          .join(' + ');
        const written = summaries.get(`${r.method} ${r.url}`) ?? r.comment;
        const text = /^\*Only when/.test(written) || written === ''
          ? `*${inferDescription(r.method, r.url)}.*${written ? ` ${written}` : ''}`
          : written;
        out.push(
          `| ${r.method} | \`${cell(r.url).replace(/`/g, '')}\` | ${r.audience} | ${cell(guard)} | ${cell(text)} |`,
        );
      }
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// ===========================================================================
// ERROR CODES
// ===========================================================================

function buildErrorDoc() {
  const source = read(ERRORS);
  const start = source.indexOf('export const ErrorCode = {');
  const end = source.indexOf('} as const', start) === -1 ? source.indexOf('\n};', start) : source.indexOf('} as const', start);
  const body = source.slice(start, end).split('\n').slice(1);
  const groups = [];
  let group = { title: 'General', codes: [] };
  groups.push(group);
  let doc = [];
  for (const raw of body) {
    const line = raw.trim();
    const heading = /^\/\/\s*-{2,}\s*(.+?)\s*-{2,}\s*$/.exec(line);
    if (heading) {
      group = { title: heading[1], codes: [] };
      groups.push(group);
      doc = [];
      continue;
    }
    if (line.startsWith('///') || line.startsWith('//')) {
      doc.push(line.replace(/^\/\/\/?\s?/, ''));
      continue;
    }
    const code = /^(\w+):\s*'(\w+)'/.exec(line);
    if (code) {
      group.codes.push({ code: code[2], doc: summarise(doc, 500) });
      doc = [];
    } else if (line === '') doc = [];
  }
  const nonEmpty = groups.filter((g) => g.codes.length > 0);
  const total = nonEmpty.reduce((n, g) => n + g.codes.length, 0);

  const out = [];
  out.push('# Error codes: every code the API can return');
  out.push('');
  out.push(GENERATED_NOTE('`backend/src/domain/errors.ts`'));
  out.push('');
  out.push(
    `**${total} codes.** Every failure from the API has the same shape, and \`code\` is one of the values below. ` +
      'The codes are a **published contract**: both storefront and admin panel turn each one into a message in eight ' +
      'languages. A new situation gets a new code; an existing code is never renamed or given a new meaning.',
  );
  out.push('');
  out.push('```json');
  out.push('{');
  out.push('  "error": {');
  out.push('    "code": "CART_ITEM_UNAVAILABLE",');
  out.push('    "message": "Some items need attention before you can check out.",');
  out.push('    "details": [{ "code": "QUANTITY_BELOW_MINIMUM", "message": "...", "meta": { "minimum": 10 } }],');
  out.push('    "correlationId": "01J..."');
  out.push('  }');
  out.push('}');
  out.push('```');
  out.push('');
  out.push('`message` is English and meant for logs and developers; show the user the translated text for `code`.');
  out.push('Quote `correlationId` when reporting a problem - it finds the request in the server log.');
  out.push('How codes map to HTTP statuses is explained in [`../API.md`](../API.md).');
  out.push('');
  out.push('| Group | Codes |');
  out.push('|---|---|');
  for (const g of nonEmpty) out.push(`| [${cell(g.title)}](#${slug(g.title)}) | ${g.codes.length} |`);
  out.push('');
  for (const g of nonEmpty) {
    out.push(`## ${g.title}`);
    out.push('');
    out.push('| Code | Meaning |');
    out.push('|---|---|');
    for (const c of g.codes) out.push(`| \`${c.code}\` | ${cell(c.doc)} |`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// ===========================================================================

const outputs = [
  ['DATABASE-TABLES.md', buildDatabaseDoc(parseSchema(read(SCHEMA)))],
  ['API-ENDPOINTS.md', buildApiDoc()],
  ['ERROR-CODES.md', buildErrorDoc()],
];

if (UNDOCUMENTED) process.exit(0);

let stale = 0;
if (!CHECK) mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of outputs) {
  const target = join(OUT_DIR, name);
  const current = existsSync(target) ? read(target) : null;
  if (CHECK) {
    if (current !== content) {
      stale++;
      console.error(`STALE  docs/reference/${name}`);
    } else console.log(`ok     docs/reference/${name}`);
  } else {
    writeFileSync(target, content, 'utf8');
    console.log(`wrote  docs/reference/${name}  (${content.split('\n').length} lines)`);
  }
}
if (stale > 0) {
  console.error('\nThe reference docs no longer match the code. Run: cd scripts; npm run docs');
  process.exit(1);
}
