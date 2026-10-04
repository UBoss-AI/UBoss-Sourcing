/**
 * The words of a legal document, laid out for reading.
 *
 * The same blocks the PDF and the admin preview use, so every copy of a
 * document has the same headings in the same places. Headings are real
 * headings, so a screen reader can move clause by clause; the text is React
 * text, never HTML.
 */
import { parseLegalBody } from '@/lib/legal-documents';
import { cx } from '@/lib/cx';

export function LegalDocumentBody({
  body,
  headingLevel = 3,
  className,
}: {
  body: string;
  /** One below whatever heading the surrounding page or dialog already has. */
  headingLevel?: 2 | 3;
  className?: string;
}): React.JSX.Element {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={cx('space-y-4 text-sm leading-relaxed text-ink-muted', className)}>
      {parseLegalBody(body).map((block, index) => {
        const key = `${block.type}-${String(index)}`;
        if (block.type === 'heading') {
          return (
            <Heading key={key} className="pt-1 text-sm font-semibold text-ink">
              {block.text}
            </Heading>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={key} className="list-disc space-y-1 pl-6">
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${String(itemIndex)}`}>{item}</li>
              ))}
            </ul>
          );
        }
        return <p key={key}>{block.text}</p>;
      })}
    </div>
  );
}
