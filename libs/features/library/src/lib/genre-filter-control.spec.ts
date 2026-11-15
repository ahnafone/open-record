import { TestBed } from '@angular/core/testing';
import type { GenreChip } from './genre-filter';
import { OrGenreFilter } from './genre-filter-control';

const OPTIONS: GenreChip[] = [
  { value: 'jazz', label: 'Jazz', count: 3 },
  { value: 'blues', label: 'Blues', count: 2 },
  { value: '', label: 'No genre', count: 1 },
];

function setup(selected: string[] = [], suggestions: GenreChip[] = OPTIONS.slice(0, 2)) {
  const fixture = TestBed.createComponent(OrGenreFilter);
  fixture.componentRef.setInput('options', OPTIONS);
  fixture.componentRef.setInput('suggestions', suggestions);
  fixture.componentRef.setInput('selected', selected);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const add = root.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  /** Click "+" and let the popup render and its input take focus. */
  const openPopup = async () => {
    add.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return root.querySelector('input') as HTMLInputElement;
  };
  const key = (input: HTMLInputElement, k: string) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    fixture.detectChanges();
  };
  const type = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  return { fixture, root, add, openPopup, key, type };
}

describe('OrGenreFilter', () => {
  it('+ opens the popup and focuses its input', async () => {
    const { root, add, openPopup } = setup();
    expect(root.querySelector('input')).toBeNull();
    const input = await openPopup();
    expect(add.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('placeholder')).toBe('Filter by genre');
    expect(document.activeElement).toBe(input);
  });

  it('Enter picks the top match of what was typed', async () => {
    const { fixture, openPopup, key, type } = setup();
    const input = await openPopup();
    type(input, 'BL');
    key(input, 'Enter');
    expect(fixture.componentInstance.selected()).toEqual(['blues']);
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape closes the popup and returns focus to +', async () => {
    const { fixture, root, add, openPopup, key } = setup();
    const input = await openPopup();
    key(input, 'Escape');
    fixture.detectChanges();
    expect(root.querySelector('input')).toBeNull();
    expect(add.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(add);
  });

  it('shows at most three suggestions, and none once a genre is selected', () => {
    const four: GenreChip[] = [
      ...OPTIONS,
      { value: 'funk', label: 'Funk', count: 1 },
    ];
    const { fixture, root } = setup([], four);
    expect(root.querySelectorAll('.suggest-chip')).toHaveLength(3);
    fixture.componentRef.setInput('selected', ['jazz']);
    fixture.detectChanges();
    expect(root.querySelectorAll('.suggest-chip')).toHaveLength(0);
  });

  it('picking a suggestion chip selects it without opening the popup', () => {
    const { fixture, root } = setup();
    (root.querySelector('.suggest-chip') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()).toEqual(['jazz']);
    expect(root.querySelector('input')).toBeNull();
  });

  it('pill X removes the genre without opening the popup', () => {
    const { fixture, root } = setup(['jazz', 'blues']);
    const x = root.querySelector('.pill-x') as HTMLButtonElement;
    x.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()).toEqual(['blues']);
    expect(root.querySelector('input')).toBeNull();
    expect(root.querySelector('button[aria-haspopup="dialog"]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('a press on the popup padding keeps it open', async () => {
    const { root, openPopup } = setup();
    const input = await openPopup();
    const menu = root.querySelector('.menu') as HTMLElement;
    expect(menu.getAttribute('role')).toBe('dialog');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    menu.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    const inputPress = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    input.dispatchEvent(inputPress);
    expect(inputPress.defaultPrevented).toBe(false);
  });

  it('Escape from + closes the popup', async () => {
    const { fixture, root, add, openPopup } = setup();
    await openPopup();
    add.focus();
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(root.querySelector('input')).toBeNull();
    expect(add.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(add);
  });

  it('keyboard pill X closes an open popup', async () => {
    const { fixture, root, openPopup } = setup(['jazz', 'blues']);
    await openPopup();
    const x = root.querySelector('.pill-x') as HTMLButtonElement;
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()).toEqual(['blues']);
    expect(root.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('button[aria-haspopup="dialog"]'));
  });

  it('keeps the highlight on the option toggled from the open list', async () => {
    const { fixture, openPopup, key } = setup();
    const input = await openPopup();
    key(input, 'ArrowDown'); // Blues
    key(input, 'Enter');
    expect(fixture.componentInstance.selected()).toEqual(['blues']);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-opt-1$/);
  });

  it('clamps the highlight when the options shrink', async () => {
    const { fixture, openPopup, key } = setup();
    const input = await openPopup();
    key(input, 'ArrowDown'); // Blues
    key(input, 'ArrowDown'); // No genre (index 2)
    fixture.componentRef.setInput('options', [OPTIONS[0]]);
    fixture.detectChanges();
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-opt-0$/);
  });
});
