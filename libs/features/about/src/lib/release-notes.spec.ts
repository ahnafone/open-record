import { isSafeReleaseLink, parseInline, parseReleaseNotes } from './release-notes';

describe('parseReleaseNotes', () => {
  it('keeps raw HTML as plain text, never as markup', () => {
    const [block] = parseReleaseNotes('<img src=x onerror=alert(1)> <script>bad()</script>');

    expect(block.kind).toBe('paragraph');
    const text = parseInline('<img src=x onerror=alert(1)>');
    expect(text).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
    expect(block).toEqual({
      kind: 'paragraph',
      inlines: [{ kind: 'text', text: '<img src=x onerror=alert(1)> <script>bad()</script>' }],
    });
  });

  it('drops javascript: and other non-https links, keeping the label as text', () => {
    expect(parseInline('[click](javascript:alert)')).toEqual([{ kind: 'text', text: 'click' }]);
    expect(parseInline('[plain](http://example.test)')).toEqual([{ kind: 'text', text: 'plain' }]);
    expect(parseInline('[rel](/docs)')).toEqual([{ kind: 'text', text: 'rel' }]);
    expect(isSafeReleaseLink('https://github.com/ahnafone/open-record')).toBe(true);
    expect(isSafeReleaseLink('JavaScript:alert(1)')).toBe(false);
  });

  it('parses headings, bullet and numbered lists, and bold', () => {
    const blocks = parseReleaseNotes(
      ['## What is new', '', '- **Faster** sync', '- Fixed *tags*', '', '1. First', '2. Second'].join(
        '\n',
      ),
    );

    expect(blocks).toEqual([
      { kind: 'heading', level: 2, inlines: [{ kind: 'text', text: 'What is new' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            { kind: 'strong', text: 'Faster' },
            { kind: 'text', text: ' sync' },
          ],
          [
            { kind: 'text', text: 'Fixed ' },
            { kind: 'em', text: 'tags' },
          ],
        ],
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'First' }], [{ kind: 'text', text: 'Second' }]],
      },
    ]);
  });

  it('keeps inline code literal and joins wrapped paragraph lines', () => {
    const blocks = parseReleaseNotes('Run `**not bold**` now\nand [docs](https://example.test/d).');

    expect(blocks).toEqual([
      {
        kind: 'paragraph',
        inlines: [
          { kind: 'text', text: 'Run ' },
          { kind: 'code', text: '**not bold**' },
          { kind: 'text', text: ' now and ' },
          { kind: 'link', text: 'docs', href: 'https://example.test/d' },
          { kind: 'text', text: '.' },
        ],
      },
    ]);
  });

  it('returns no blocks for empty notes', () => {
    expect(parseReleaseNotes('')).toEqual([]);
    expect(parseReleaseNotes('  \n\n ')).toEqual([]);
  });
});
