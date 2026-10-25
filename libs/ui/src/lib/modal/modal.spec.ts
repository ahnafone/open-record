import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OrModal } from './modal';

@Component({
  imports: [OrModal],
  template: `
    <button id="opener" (click)="open.set(true)">Open</button>
    <or-modal heading="Delete playlist" [(open)]="open">
      <button id="first">First</button>
      <button id="last">Last</button>
    </or-modal>
  `,
})
class Host {
  readonly open = signal(false);
}

const key = (target: Element, k: string, shiftKey = false) => {
  const ev = new KeyboardEvent('keydown', {
    key: k,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
};

describe('OrModal focus management', () => {
  it('traps Tab inside the dialog and returns focus on close', async () => {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const opener = root.querySelector<HTMLButtonElement>(
      '#opener',
    ) as HTMLElement;
    opener.focus();
    opener.click();
    await fixture.whenStable();

    const dialog = root.querySelector('[role="dialog"]') as HTMLElement;
    const first = root.querySelector<HTMLButtonElement>(
      '#first',
    ) as HTMLElement;
    const last = root.querySelector<HTMLButtonElement>('#last') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(first);

    last.focus();
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(key(first, 'Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    key(last, 'Escape');
    await fixture.whenStable();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    fixture.nativeElement.remove();
  });
});
