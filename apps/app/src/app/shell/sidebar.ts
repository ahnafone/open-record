import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthStore, PlaylistsStore } from '@open-record/state';
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

const MORE: readonly NavItem[] = [
  { path: '/import', label: 'Import from Spotify', icon: 'upload' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];

/**
 * Desktop sidebar (900px+): brand, the three tab destinations, import and
 * settings, then the user's playlists. Replaces the phone tab bar.
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
      <ul class="nav">
        @for (item of more; track item.path) {
          <li>
            <a class="link" [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">
              <or-icon [name]="item.icon" [size]="22" />{{ item.label }}
            </a>
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
    @if (auth.available) {
      <div class="account">
        @if (auth.user(); as user) {
          <a class="link" routerLink="/settings" [attr.title]="user.email">
            <or-icon name="users" [size]="22" /><span class="acct-text">{{ user.email }}</span>
          </a>
        } @else if (!auth.accountsReady()) {
          <a class="link" routerLink="/settings" title="Accounts are not set up on this server">
            <or-icon name="users" [size]="22" />Sign in
          </a>
        } @else {
          <button type="button" class="link signin" (click)="signIn()">
            <or-icon name="users" [size]="22" />Sign in / Sign up
          </button>
        }
      </div>
    }
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
    .nav + .nav {
      padding-top: var(--spacing-sm);
      border-top: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent);
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
    .account {
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
  protected readonly auth = inject(AuthStore);
  protected readonly nav = NAV;
  protected readonly more = MORE;

  protected signIn(): void {
    this.auth.promptSignIn('Sign in to like songs and import your library.');
  }
}
