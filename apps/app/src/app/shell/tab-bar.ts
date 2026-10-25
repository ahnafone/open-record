import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { type IconName, OrIcon } from '@open-record/ui';

interface Tab {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
}

/** Three equal 48px tabs; the current tab gets a text-colour label and coral icon. */
@Component({
  selector: 'or-tab-bar',
  imports: [OrIcon, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'navigation', 'aria-label': 'Sections' },
  template: `
    @for (tab of tabs; track tab.path) {
      <a
        class="tab"
        [routerLink]="tab.path"
        routerLinkActive
        ariaCurrentWhenActive="page"
      >
        <or-icon [name]="tab.icon" />
        <span>{{ tab.label }}</span>
      </a>
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--spacing-xs);
      padding: var(--spacing-xs) var(--spacing-sm)
        calc(6px + env(safe-area-inset-bottom, 0px));
      background: var(--color-background);
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 50%, transparent);
    }
    .tab {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-xxs);
      min-height: 48px;
      color: var(--color-muted);
      text-decoration: none;
      font-family: var(--type-tab-label-font-family);
      font-size: var(--type-tab-label-font-size);
      line-height: var(--type-tab-label-line-height);
      letter-spacing: var(--type-tab-label-letter-spacing);
      border-radius: var(--rounded-md);
      transition:
        color var(--duration-fast) var(--ease-standard),
        background var(--duration-fast) var(--ease-standard);
    }
    .tab:hover {
      color: var(--color-text);
      background: color-mix(in srgb, var(--color-text) 4%, transparent);
    }
    .tab[aria-current='page'] {
      color: var(--color-text);
    }
    .tab[aria-current='page'] or-icon {
      color: var(--color-primary);
    }
  `,
})
export class OrTabBar {
  protected readonly tabs: readonly Tab[] = [
    { path: '/browse', label: 'Browse', icon: 'disc' },
    { path: '/search', label: 'Search', icon: 'search' },
    { path: '/library', label: 'Library', icon: 'bookmark' },
  ];
}
