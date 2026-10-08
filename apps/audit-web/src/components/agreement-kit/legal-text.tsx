/**
 * The words of a legal document, laid out for reading.
 *
 * The same reading as `backend/src/domain/legal-document.ts`: `## ` a heading,
 * `- ` or `* ` a bullet, a blank line ends a paragraph, nothing else means
 * anything. Rendered as React text, so stored text can never become markup.
 * Headings are real headings, so a screen reader can move clause by clause.
 */
import { cx } from '@/lib/cx';
import { parseLegalBody } from './legal-blocks';

/**
 * A heading that starts a part ("Part A - ...", "Schedule 1 - ...") is drawn
 * one step louder than a clause heading, so a long document reads as parts
 * with clauses inside them rather than one flat run of headings.
 */
function isPartHeading(text: string): boolean {
  return /^(part|schedule|annex|appendix)\b/i.test(text);
}

export function LegalText({
  body,
  headingLevel = 3,
  className,
}: {
  body: string;
  /** One below whatever heading the surrounding dialog or page already has. */
  headingLevel?: 3 | 4;
  className?: string;
}): React.JSX.Element {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <div className={cx('space-y-3 text-[0.9375rem] leading-7 text-ink-muted', className)}>
      {parseLegalBody(body).map((block, index) => {
        const key = `${block.type}-${String(index)}`;
        if (block.type === 'heading') {
          return isPartHeading(block.text) ? (
            <Heading
              key={key}
              className="mt-6 border-b border-border-subtle pb-1.5 pt-2 text-base font-semibold tracking-tight text-ink first:mt-0"
            >
              {block.text}
            </Heading>
          ) : (
            <Heading key={key} className="pt-3 text-sm font-semibold text-ink">
              {block.text}
            </Heading>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={key} className="list-disc space-y-1.5 pl-6 marker:text-ink-subtle">
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
