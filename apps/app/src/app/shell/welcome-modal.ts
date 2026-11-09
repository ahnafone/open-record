import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { AuthStore, WEB_BUILD } from '@open-record/state';
import {
  APPS_URL,
  DOCS_URL,
  GITHUB_URL,
  OrIcon,
  OrModal,
} from '@open-record/ui';
import { readWelcomeDismissed, writeWelcomeDismissed } from './welcome-prefs';

/**
 * First-visit welcome on the web build, for signed-out visitors. Shown once
 * (dismissal is remembered per device); never on native or desktop builds.
 * Waits for the account restore so a signed-in user never sees it.
 */
@Component({
  selector: 'or-welcome-modal',
  imports: [OrModal, OrIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal
      ariaLabel="Welcome to Open Record"
      [closable]="true"
      [(open)]="open"
      (dismissed)="remember()"
    >
      <div class="welcome">
        <header class="intro">
          <div class="mark">
            <img src="assets/favicon.svg" alt="" width="84" height="84" />
          </div>
          <p class="eyebrow">Open source music player</p>
          <h2 class="title">Welcome to Open Record</h2>
          <p class="blurb">
            A music player that downloads tracks to your device and plays them
            like a streaming app.
          </p>
        </header>

        <div class="preview">
          <div class="frame">
            <img
              src="assets/welcome-preview.webp"
              alt=""
              width="600"
              height="260"
              loading="lazy"
            />
          </div>
        </div>

        <div class="actions-group">
          <a
            class="btn btn-primary"
            [href]="appsUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <or-icon name="download" [size]="18" />
            <span>Download App</span>
          </a>
          <div class="pair">
            <a
              class="btn"
              [href]="githubUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              <or-icon name="github" [size]="18" />
              <span>GitHub</span>
            </a>
            <a
              class="btn"
              [href]="docsUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              <or-icon name="globe" [size]="18" />
              <span>Official Site</span>
            </a>
          </div>
          <button type="button" class="ghost" (click)="getStarted()">
            Get started
          </button>
        </div>
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    /*
     * The modal reserves room for its close X on the right of its body
     * (no heading), which would push this content off-centre; the negative
     * margin hands that room back so the header stays centred.
     */
    .welcome {
      display: grid;
      gap: var(--spacing-md);
      margin-inline-end: calc(-1 * (var(--spacing-touch) + var(--spacing-sm)));
    }
    .intro {
      display: grid;
      justify-items: center;
      gap: var(--spacing-xs);
      text-align: center;
    }
    .mark {
      position: relative;
      display: grid;
      place-items: center;
      margin-block-end: var(--spacing-xxs);
    }
    /* Soft coral light behind the disc; decorative only. */
    .mark::before {
      content: '';
      position: absolute;
      inset: -28px;
      background: radial-gradient(
        closest-side,
        color-mix(in srgb, var(--color-primary) 30%, transparent),
        transparent
      );
      pointer-events: none;
    }
    .mark img {
      position: relative;
      display: block;
      inline-size: 84px;
      block-size: 84px;
      border-radius: 50%;
      box-shadow: 0 0 0 1px
        color-mix(in srgb, var(--color-border) 60%, transparent);
    }
    .eyebrow {
      margin: 0;
      font-size: 11px;
      line-height: 1.4;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .title {
      margin: 0;
      font-family: var(--type-title-font-family);
      font-size: var(--type-title-font-size);
      font-weight: var(--type-title-font-weight);
      line-height: var(--type-title-line-height);
      color: var(--color-text);
    }
    .blurb {
      max-inline-size: 30ch;
      margin: 0;
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
      color: var(--color-muted);
    }
    /* Screenshot crop (600x260, matches the image), faded into the modal. */
    .preview {
      margin: 0;
    }
    .frame {
      position: relative;
      aspect-ratio: 600 / 260;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
      border-radius: var(--rounded-md);
      background: var(--color-background);
      box-shadow: 0 10px 22px
        color-mix(in srgb, var(--color-vinyl) 45%, transparent);
    }
    .frame img {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      object-fit: cover;
      object-position: 50% 30%;
    }
    .frame::after {
      content: '';
      position: absolute;
      inset-inline: 0;
      inset-block-end: 0;
      block-size: 55%;
      background: linear-gradient(to bottom, transparent, var(--color-surface));
      pointer-events: none;
    }
    .actions-group {
      display: grid;
      gap: var(--spacing-sm);
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--spacing-sm);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      padding: 0 var(--spacing-md);
      color: var(--color-text);
      background: var(--color-surface-raised);
      border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-md);
      font-family: var(--type-button-font-family);
      font-size: var(--type-button-font-size);
      font-weight: var(--type-button-font-weight);
      line-height: var(--type-button-line-height);
      text-decoration: none;
      transition:
        background-color var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard);
    }
    .btn:hover {
      background: var(--color-surface);
    }
    .btn:active {
      transform: scale(0.97);
    }
    .btn-primary {
      background: var(--color-primary);
      border-color: var(--color-primary);
      color: var(--color-on-primary);
      font-weight: 600;
    }
    .btn-primary:hover {
      background: var(--color-primary-hover);
    }
    .ghost {
      min-block-size: var(--spacing-touch);
      padding: 0 var(--spacing-md);
      color: var(--color-muted);
      background: none;
      border: 0;
      border-radius: var(--rounded-md);
      font: inherit;
      font-family: var(--type-button-font-family);
      font-size: var(--type-button-font-size);
      font-weight: var(--type-button-font-weight);
      cursor: pointer;
      transition: color var(--duration-fast) var(--ease-standard);
    }
    .ghost:hover {
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .btn:focus-visible,
    .ghost:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    /* Short viewports: drop the screenshot so the dialog fits without scrolling. */
    @media (max-height: 779px) {
      .preview {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .btn {
        transition-duration: 1ms;
      }
      .btn:active {
        transform: none;
      }
    }
  `,
})
export class OrWelcomeModal {
  private readonly auth = inject(AuthStore);
  private readonly webBuild = inject(WEB_BUILD);

  protected readonly appsUrl = APPS_URL;
  protected readonly githubUrl = GITHUB_URL;
  protected readonly docsUrl = DOCS_URL;

  protected readonly open = signal(false);
  /** Shown at most once per app load, even when storage cannot remember it. */
  private shown = false;

  constructor() {
    effect(() => {
      const status = this.auth.status();
      if (!this.webBuild) return;
      // Signed in once means not a first visit: remember it, so signing out
      // later does not bring the welcome back.
      if (status === 'signedIn') {
        untracked(() => {
          writeWelcomeDismissed();
          // Also covers blocked storage: a later sign-out in this session
          // must not show the welcome.
          this.shown = true;
          this.open.set(false);
        });
        return;
      }
      if (this.open() || this.shown || status === 'loading') return;
      untracked(() => {
        if (readWelcomeDismissed()) return;
        this.shown = true;
        this.open.set(true);
      });
    });
  }

  /** Persist the dismissal (Escape, backdrop, X or "Get started"). */
  protected remember(): void {
    writeWelcomeDismissed();
  }

  protected getStarted(): void {
    this.open.set(false);
    this.remember();
  }
}
