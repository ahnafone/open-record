import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
} from '@angular/core';
import { Router } from '@angular/router';
import { type IconName, OrIconButton } from '@open-record/ui';

/**
 * Top bar. Root (tab) screens show the brand mark, serif wordmark and tagline;
 * pushed screens show a back button and a serif title.
 */
@Component({
  selector: 'or-top-bar',
  imports: [OrIconButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (root()) {
      <span class="brand-mark" aria-hidden="true"></span>
      <div class="brand-txt">
        <span class="brand-name">OpenRecord</span>
        <span class="brand-tag">Vintage records · listening room</span>
      </div>
      <or-icon-button
        class="settings"
        label="Settings"
        icon="settings"
        (click)="openSettings()"
      />
    } @else {
      <or-icon-button
        [label]="backLabel()"
        [icon]="backIcon()"
        (click)="back.emit()"
      />
      <h1 class="title">{{ title() }}</h1>
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-width: 0;
      min-height: 56px;
      padding: env(safe-area-inset-top, 0px) var(--spacing-sm) 0;
      box-sizing: content-box;
      background: var(--color-background);
      border-bottom: 1px solid
        color-mix(in srgb, var(--color-border) 50%, transparent);
    }
    .brand-mark {
      flex: none;
      position: relative;
      inline-size: 30px;
      block-size: 30px;
      border-radius: 50%;
      border: 1px solid var(--color-border);
      background: radial-gradient(
        circle at 50% 50%,
        var(--color-vinyl) 0 30%,
        color-mix(in srgb, var(--color-surface) 80%, var(--color-text)) 31% 60%,
        var(--color-vinyl) 61%
      );
    }
    .brand-mark::after {
      content: '';
      position: absolute;
      inset: 38%;
      border-radius: 50%;
      background: var(--color-primary);
    }
    .brand-txt {
      display: grid;
      flex: 1;
      min-width: 0;
    }
    .settings {
      flex: none;
    }
    .brand-name {
      font-family: var(--font-display);
      font-size: 20px;
      line-height: 1.15;
    }
    .brand-tag {
      font-size: 10.5px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .title {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-family: var(--type-title-font-family);
      font-size: var(--type-title-font-size);
      font-weight: 400;
      line-height: var(--type-title-line-height);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  `,
})
export class OrTopBar {
  readonly root = input(true);
  readonly title = input('');
  readonly backIcon = input<IconName>('back');
  readonly backLabel = input('Back');
  readonly back = output<void>();

  private readonly router = inject(Router);

  protected openSettings(): void {
    void this.router.navigateByUrl('/settings');
  }
}
