/**
 * Minimal, safe markdown for release notes. Produces a typed tree that the
 * template renders with interpolation (never `innerHTML`), so raw HTML in a
 * release body is shown as plain text. Supported: `#`..`###` headings,
 * paragraphs, `-`/`*`/`+` bullet lists, `1.` numbered lists, `**bold**` or
 * `__bold__`, `*italic*`, `` `code` ``, and `[label](https://…)` links.
 * Only `https:` links are kept; any other link renders as its label.
 */

export type InlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

export type ReleaseNotesBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly inlines: readonly InlineNode[] }
  | { readonly kind: 'paragraph'; readonly inlines: readonly InlineNode[] }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly InlineNode[])[];
    };

const HEADING = /^(#{1,3})[ \t]+(.*)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const NUMBERED = /^[ \t]*\d+[.)][ \t]+(.*)$/;

/**
 * One scan over the inline syntax. Alternatives are tried left to right, so
 * code spans win over everything inside them.
 */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*/g;

/** True for an absolute `https:` URL and nothing else (no `javascript:`, `http:`, relative). */
export function isSafeReleaseLink(href: string): boolean {
  try {
    return new URL(href).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Splits one line of text into inline nodes. */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(source); match !== null; match = INLINE.exec(source)) {
    if (match.index > last) nodes.push({ kind: 'text', text: source.slice(last, match.index) });
    const [whole, code, label, href, bold, boldUnderscore, italic] = match;
    if (code !== undefined) {
      nodes.push({ kind: 'code', text: code });
    } else if (label !== undefined && href !== undefined) {
      nodes.push(
        isSafeReleaseLink(href)
          ? { kind: 'link', text: label, href }
          : { kind: 'text', text: label },
      );
    } else if (bold !== undefined) {
      nodes.push({ kind: 'strong', text: bold });
    } else if (boldUnderscore !== undefined) {
      nodes.push({ kind: 'strong', text: boldUnderscore });
    } else if (italic !== undefined) {
      nodes.push({ kind: 'em', text: italic });
    } else {
      nodes.push({ kind: 'text', text: whole });
    }
    last = match.index + whole.length;
  }
  if (last < source.length) nodes.push({ kind: 'text', text: source.slice(last) });
  return nodes;
}

/** Parses a release body into blocks. Never throws; empty input gives no blocks. */
export function parseReleaseNotes(markdown: string): ReleaseNotesBlock[] {
  const blocks: ReleaseNotesBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item)),
      });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);

    if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        inlines: parseInline(heading[2]),
      });
    } else if (bullet || numbered) {
      const ordered = numbered !== null;
      const text = (bullet ?? numbered)?.[1] ?? '';
      flushParagraph();
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(text);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
