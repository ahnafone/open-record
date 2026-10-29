import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthStore, CuratedStore, PlaylistsStore } from '@open-record/state';
import { type IconName, OrIcon } from '@open-record/ui';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
}

const NAV: readonly NavItem[] = [
  { path: '/browse', label: 'Browse', icon: 'disc' },
  { path: '/search', label: 'Search', icon: 'search' },
  { path: '/library', label: 'Library', icon: 'bookmark' },
];

/**
 * Desktop sidebar (900px+): brand, the three tab destinations, the app-curated
 * lists, the user's playlists, then the account row, Import and Settings at the
 * bottom. The phone drawer reuses this content.
 */
@Component({
  selector: 'or-sidebar',
  imports: [RouterLink, RouterLinkActive, OrIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="brand" routerLink="/browse" aria-label="OpenRecord, browse">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-txt">
        <span class="brand-name">OpenRecord</span>
        <span class="brand-tag">Listening room</span>
      </span>
    </a>
    <nav aria-label="Main">
      <ul class="nav">
        @for (item of nav; track item.path) {
          <li>
            <a class="link" [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">
              <or-icon [name]="item.icon" [size]="22" />{{ item.label }}
            </a>
          </li>
        }
      </ul>
    </nav>
    <nav class="curated" aria-labelledby="or-side-curated">
      <h2 class="eyebrow" id="or-side-curated">Curated</h2>
      <ul class="pl">
        @for (c of curated.playlists; track c.id) {
          <li>
            <a
              class="pl-link"
              [routerLink]="['/curated', c.id]"
              routerLinkActive="active"
              ariaCurrentWhenActive="page"
              >{{ c.name }}</a
            >
          </li>
        }
      </ul>
    </nav>
    <section class="playlists" aria-labelledby="or-side-playlists">
      <h2 class="eyebrow" id="or-side-playlists">Playlists</h2>
      @if (playlists.playlists().length) {
        <ul class="pl">
          @for (p of playlists.playlists(); track p.id) {
            <li>
              <a
                class="pl-link"
                [routerLink]="['/playlist', p.id]"
                routerLinkActive="active"
                ariaCurrentWhenActive="page"
                >{{ p.name }}</a
              >
            </li>
          }
        </ul>
      } @else {
        <p class="empty">Make one from your Library.</p>
      }
    </section>
    <nav class="account" aria-label="Account">
      @if (auth.available) {
        @if (auth.user(); as user) {
          <a
            class="link small"
            routerLink="/account"
            routerLinkActive="active"
            ariaCurrentWhenActive="page"
            [attr.title]="user.email"
            [attr.aria-label]="'Account, ' + (user.email || 'signed in')"
          >
            <or-icon name="users" [size]="20" /><span class="acct-text">{{
              user.email || 'Account'
            }}</span>
          </a>
        } @else if (!auth.accountsReady()) {
          <a
            class="link small"
            routerLink="/account"
            routerLinkActive="active"
            ariaCurrentWhenActive="page"
            title="Accounts are not set up on this server"
          >
            <or-icon name="users" [size]="20" />Sign in
          </a>
        } @else {
          <button type="button" class="link small signin" (click)="signIn()">
            <or-icon name="users" [size]="20" />Sign in / Sign up
          </button>
        }
      }
      <a
        class="link small"
        routerLink="/import"
        routerLinkActive="active"
        ariaCurrentWhenActive="page"
      >
        <or-icon name="upload" [size]="20" />Import
      </a>
      <a
        class="link small"
        routerLink="/settings"
        routerLinkActive="active"
        ariaCurrentWhenActive="page"
      >
        <or-icon name="settings" [size]="20" />Settings
      </a>
    </nav>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      min-height: 0;
      padding: var(--spacing-md) var(--spacing-sm) var(--spacing-md);
      background: var(--color-background);
      border-right: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
    }
    a {
      color: inherit;
      text-decoration: none;
    }
    a:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-height: var(--spacing-touch);
      padding: 0 var(--spacing-sm);
      border-radius: var(--rounded-md);
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
      min-width: 0;
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
    nav {
      display: grid;
      gap: var(--spacing-sm);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .nav {
      display: grid;
      gap: var(--spacing-xxs);
    }
    .link {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      min-height: var(--spacing-touch);
      padding: 0 var(--spacing-md);
      border-radius: var(--rounded-md);
      font-size: 15px;
      font-weight: 600;
      color: var(--color-muted);
      transition: background-color var(--duration-fast) var(--ease-standard),
        color var(--duration-fast) var(--ease-standard);
    }
    button.link {
      inline-size: 100%;
      border: 0;
      background: transparent;
      font-family: inherit;
      text-align: start;
      cursor: pointer;
    }
    button.link:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .link.small {
      gap: var(--spacing-sm);
      font-size: 13px;
    }
    .account {
      display: grid;
      gap: var(--spacing-xxs);
      padding-top: var(--spacing-sm);
      border-top: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .acct-text {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .link:hover,
    .pl-link:hover {
      color: var(--color-text);
      background: var(--color-surface-raised);
    }
    .link.active {
      color: var(--color-text);
      background: var(--color-surface);
    }
    .link.active or-icon {
      color: var(--color-primary);
    }
    .curated {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      padding-top: var(--spacing-sm);
      border-top: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .playlists {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      min-height: 0;
      flex: 1;
      padding-top: var(--spacing-sm);
      border-top: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .eyebrow {
      margin: 0;
      padding: 0 var(--spacing-md);
      font-size: 11px;
      font-weight: 400;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .pl {
      overflow-y: auto;
      min-height: 0;
      scrollbar-width: thin;
    }
    .pl-link {
      display: flex;
      align-items: center;
      min-height: 40px;
      padding: 0 var(--spacing-md);
      border-radius: var(--rounded-md);
      font-family: var(--font-display);
      font-size: 15px;
      color: var(--color-muted);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      transition: background-color var(--duration-fast) var(--ease-standard),
        color var(--duration-fast) var(--ease-standard);
    }
    .pl-link.active {
      color: var(--color-text);
      background: var(--color-surface);
    }
    .empty {
      margin: 0;
      padding: 0 var(--spacing-md);
      font-size: 12px;
      color: var(--color-muted);
    }
    @media (prefers-reduced-motion: reduce) {
      .link,
      .pl-link {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrSidebar {
  protected readonly playlists = inject(PlaylistsStore);
  protected readonly curated = inject(CuratedStore);
  protected readonly auth = inject(AuthStore);
  protected readonly nav = NAV;

  protected signIn(): void {
    this.auth.promptSignIn('Sign in to like songs and import your library.');
  }
}
