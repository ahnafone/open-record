import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { OrSlider } from './slider';

@Component({
  imports: [OrSlider],
  template: `<or-slider
    label="Seek"
    [max]="100"
    [(value)]="value"
    (committed)="committed.push($event)"
  />`,
})
class Host {
  readonly value = signal(50);
  readonly committed: number[] = [];
}

describe('OrSlider keyboard', () => {
  it('moves by step, page step and jumps to the ends', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const slider = fixture.nativeElement.querySelector(
      'or-slider',
    ) as HTMLElement;
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('tabindex')).toBe('0');

    const press = async (key: string) => {
      const ev = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      slider.dispatchEvent(ev);
      await fixture.whenStable();
      return ev;
    };

    expect((await press('ArrowRight')).defaultPrevented).toBe(true);
    expect(fixture.componentInstance.value()).toBe(51);
    await press('ArrowLeft');
    await press('ArrowDown');
    expect(fixture.componentInstance.value()).toBe(49);
    await press('PageUp');
    expect(fixture.componentInstance.value()).toBe(59);
    await press('End');
    expect(fixture.componentInstance.value()).toBe(100);
    await press('ArrowUp');
    expect(fixture.componentInstance.value()).toBe(100);
    await press('Home');
    expect(fixture.componentInstance.value()).toBe(0);
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    expect(fixture.componentInstance.committed).toEqual([
      51, 50, 49, 59, 100, 100, 0,
    ]);
  });
});
