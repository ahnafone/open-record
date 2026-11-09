import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  type Signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AuthStatus } from '@open-record/state';
import { APPS_URL, DOCS_URL, GITHUB_URL, OrIcon } from '@open-record/ui';

/**
 * Whether the bottom link strip shows: web build only, never when signed in,
 * and never while the account restore is still loading for the first time.
 * `resolved` is true once any non-loading status has been seen; after that a
 * `loading` status keeps the strip as it was, so it does not flicker.
 */
export function linkStripShown(
  webBuild: boolean,
  status: AuthStatus,
  resolved: boolean,
): boolean {
  if (!webBuild || status === 'signedIn') return false;
  return status !== 'loading' || resolved;
}

/**
 * The single source of the strip's visibility. The shell calls this once and
 * passes the result to both the strip and the layout (`link-strip-shown`).
 */
export function linkStripVisibility(
  webBuild: boolean,
  status: Signal<AuthStatus>,
): Signal<boolean> {
  // Latches: once a non-loading status has been read, stays resolved.
  const resolved = linkedSignal<AuthStatus, boolean>({
    source: status,
    computation: (current, previous) =>
      previous?.value === true || current !== 'loading',
  });
  return computed(() => linkStripShown(webBuild, status(), resolved()));
}

/**
 * Slim, non-dismissible coral bar of project links at the very bottom of the
 * web shell. Lives in its own grid row below the dock (see app.css).
 */
@Component({
  selector: 'or-link-strip',
  imports: [OrIcon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown()) {
      <nav class="strip" aria-label="Project links">
        <a
          class="link"
          [href]="appsUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <or-icon name="download" [size]="14" />
          <span>Download App</span>
        </a>
        <a
          class="link"
          [href]="githubUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <or-icon name="github" [size]="14" />
          <span>GitHub</span>
        </a>
        <a
          class="link"
          [href]="docsUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <or-icon name="globe" [size]="14" />
          <span>Official Site</span>
        </a>
        <a class="link" routerLink="/about">
          <or-icon name="info" [size]="14" />
          <span>About</span>
        </a>
      </nav>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    /* Coral bar: dark brown text on coral (7.9:1), per DESIGN.md. */
    .strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      column-gap: var(--spacing-xs);
      min-block-size: var(--spacing-touch);
      /* Own bottom safe-area inset; the tab bar gives its inset up while this shows. */
      padding: 0 var(--spacing-sm) env(safe-area-inset-bottom, 0px);
      background: var(--color-primary);
      color: var(--color-on-primary);
    }
    .link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-xs);
      min-block-size: var(--spacing-touch);
      padding-inline: var(--spacing-sm);
      color: var(--color-on-primary);
      font-family: var(--type-button-font-family);
      font-size: 13px;
      font-weight: 600;
      line-height: var(--type-meta-line-height);
      /* Underline always shows (not colour alone); subtle until hover. */
      text-decoration-line: underline;
      text-decoration-thickness: 1px;
      text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
      text-underline-offset: 3px;
      border-radius: var(--rounded-md);
      transition:
        background-color var(--duration-fast) var(--ease-standard),
        text-decoration-color var(--duration-fast) var(--ease-standard);
    }
    .link:hover {
      background: var(--color-primary-hover);
      text-decoration-color: currentColor;
      text-decoration-thickness: 2px;
    }
    .link:focus-visible {
      outline: 2px solid var(--color-on-primary);
      outline-offset: -4px;
    }
    /* Desktop (900px+): a thin bar under the player bar; no safe-area inset. */
    @media (min-width: 900px) {
      .strip {
        min-block-size: 36px;
        padding-bottom: 0;
      }
      .link {
        min-block-size: 36px;
      }
    }
    /* Phones: text only, so all four links fit on one 44px row. */
    @media (max-width: 599px) {
      .link or-icon {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .link {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrLinkStrip {
  /** From the shell (`linkStripVisibility`), so strip and layout always agree. */
  readonly shown = input.required<boolean>();

  protected readonly appsUrl = APPS_URL;
  protected readonly githubUrl = GITHUB_URL;
  protected readonly docsUrl = DOCS_URL;
}
