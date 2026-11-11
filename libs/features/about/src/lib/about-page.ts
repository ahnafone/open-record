import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { UpdateStore } from '@open-record/state';
import {
  APPS_URL,
  DOCS_URL,
  GITHUB_URL,
  OrButton,
  OrIcon,
  OrSectionHead,
  OrSwitch,
  OrTag,
  type IconName,
} from '@open-record/ui';
import { APP_VERSION } from './app-version';
import { MUSIC_DISCLAIMER } from './credits';
import { parseReleaseNotes } from './release-notes';

interface ExternalLink {
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
}

const LINKS: readonly ExternalLink[] = [
  { label: 'Download App', href: APPS_URL, icon: 'download' },
  { label: 'GitHub', href: GITHUB_URL, icon: 'github' },
  { label: 'Official Site', href: DOCS_URL, icon: 'globe' },
];

/**
 * About screen (`/about`, every platform, signed in or not): what the app is,
 * the two ways to use it, app updates, project links and the music
 * disclaimer. Settings links here; `#music-disclaimer` scrolls to the disclaimer.
 */
@Component({
  selector: 'or-about-page',
  imports: [NgTemplateOutlet, OrButton, OrIcon, OrSectionHead, OrSwitch, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Inline markdown. Text is always interpolated, never HTML. -->
    <ng-template #inlines let-nodes>
      @for (node of nodes; track $index) {
        @if (node.kind === 'strong') {
          <strong>{{ node.text }}</strong>
        } @else if (node.kind === 'em') {
          <em>{{ node.text }}</em>
        } @else if (node.kind === 'code') {
          <code>{{ node.text }}</code>
        } @else if (node.kind === 'link') {
          <a [href]="node.href" target="_blank" rel="noopener noreferrer">{{ node.text }}</a>
        } @else {
          {{ node.text }}
        }
      }
    </ng-template>

    <header class="hero">
      <h1 class="app-name">Open Record</h1>
      <p class="version">v{{ version }}</p>
    </header>

    <or-section-head heading="Updates" />
    <div class="updates">
      <p class="installed">Installed version: v{{ version }}</p>
      <or-switch
        label="Check for updates"
        description="Look for new versions when the app starts and every 6 hours."
        [checked]="updates.checkForUpdates()"
        (checkedChange)="updates.setCheckForUpdates($event)"
      />
      @if (updates.canSelfUpdate()) {
        <or-switch
          label="Install updates automatically"
          description="Download new versions in the background. They install when you restart the app."
          [checked]="updates.autoUpdate()"
          [disabled]="!updates.checkForUpdates()"
          (checkedChange)="updates.setAutoUpdate($event)"
        />
      }

      <div class="check-row">
        <or-button
          size="sm"
          [disabled]="updates.checking()"
          (click)="checkNow()"
        >{{ updates.checking() ? 'Checking…' : 'Check for updates' }}</or-button>
        @if (updates.error(); as err) {
          <p class="status error" role="alert">{{ err }}</p>
        } @else {
          <p class="status" aria-live="polite">{{ status() }}</p>
        }
      </div>

      @if (updates.phase() === 'ready') {
        <div class="restart">
          <p class="status">The update is downloaded. Restart to install it.</p>
          <or-button variant="primary" (click)="restart()">Restart now</or-button>
        </div>
      }

      @if (updates.release(); as rel) {
        <section class="release" aria-labelledby="release-title">
          <div class="release-head">
            <h3 id="release-title" class="release-title">Version {{ rel.version }}</h3>
            @if (rel.prerelease) {
              <or-tag>Pre-release</or-tag>
            }
            @if (isSkipped()) {
              <or-tag>Skipped</or-tag>
            }
          </div>
          @if (notes().length > 0) {
            <div class="notes">
              @for (block of notes(); track $index) {
                @if (block.kind === 'heading') {
                  @if (block.level === 1) {
                    <h4 class="note-heading note-heading-1"><ng-container [ngTemplateOutlet]="inlines" [ngTemplateOutletContext]="{ $implicit: block.inlines }" /></h4>
                  } @else if (block.level === 2) {
                    <h5 class="note-heading note-heading-2"><ng-container [ngTemplateOutlet]="inlines" [ngTemplateOutletContext]="{ $implicit: block.inlines }" /></h5>
                  } @else {
                    <h6 class="note-heading note-heading-3"><ng-container [ngTemplateOutlet]="inlines" [ngTemplateOutletContext]="{ $implicit: block.inlines }" /></h6>
                  }
                } @else if (block.kind === 'paragraph') {
                  <p><ng-container [ngTemplateOutlet]="inlines" [ngTemplateOutletContext]="{ $implicit: block.inlines }" /></p>
                } @else if (block.ordered) {
                  <ol>
                    @for (item of block.items; track $index) {
                      <li><ng-container [ngTemplateOutlet]="inlines" [ngTemplateOutletContext]="{ $implicit: item }" /></li>
                    }
                  </ol>
                } @else {
                  <ul>
                    @for (item of block.items; track $index) {
                      <li><ng-container [ngTemplateOutlet]="inlines" [ngTemplateOutletContext]="{ $implicit: item }" /></li>
                    }
                  </ul>
                }
              }
            </div>
          }

          @if (updates.phase() === 'downloading') {
            <div
              class="progress"
              role="progressbar"
              aria-label="Downloading update"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuenow]="percent()"
            >
              <span class="fill" [style.transform]="'scaleX(' + (updates.progress() ?? 0) + ')'"></span>
            </div>
            <p class="status">Downloading… {{ percent() }}%</p>
          } @else if (updates.phase() !== 'ready') {
            <div class="actions">
              @if (canDownload()) {
                <or-button variant="primary" size="sm" (click)="download()">{{ downloadLabel() }}</or-button>
              } @else {
                <a
                  class="text-link"
                  [href]="rel.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >View release</a>
              }
            </div>
          }

          @if (updates.phase() !== 'downloading') {
            <div class="actions">
              @if (isSkipped()) {
                <or-button size="sm" (click)="unskip()">Unskip this version</or-button>
              } @else {
                <or-button size="sm" (click)="skip()">Skip this version</or-button>
              }
            </div>
          }
        </section>
      }
    </div>

    <or-section-head heading="How it works" />
    <p class="lede">
      Open Record is a music player. It fetches music with a downloader and
      saves it on your device, so you play it like a streaming app.
    </p>
    <div class="ways">
      <section class="way" aria-labelledby="way-public">
        <h3 id="way-public" class="way-title">Public server</h3>
        <p>
          Use the app straight away with no setup. It connects to Open Record's
          public server. You can optionally create an account to keep your
          library across devices.
        </p>
      </section>
      <section class="way" aria-labelledby="way-self">
        <h3 id="way-self" class="way-title">Self-host</h3>
        <p>
          Run your own Open Record server and point the app at it in Settings.
        </p>
      </section>
    </div>

    <or-section-head heading="Links" />
    <nav class="links" aria-label="Project links">
      @for (link of links; track link.href) {
        <a
          class="link-row"
          [href]="link.href"
          target="_blank"
          rel="noopener noreferrer"
        >
          <or-icon [name]="link.icon" [size]="20" />
          <span>{{ link.label }}</span>
        </a>
      }
    </nav>

    <or-section-head heading="Music disclaimer" />
    <p #disclaimerEl id="music-disclaimer" class="disclaimer" tabindex="-1">
      {{ disclaimer }}
    </p>
  `,
  styles: `
    :host {
      display: block;
    }
    .hero {
      display: grid;
      gap: var(--spacing-xxs);
      padding-top: var(--spacing-xs);
    }
    .app-name {
      margin: 0;
      font-family: var(--type-display-font-family);
      font-size: var(--type-display-font-size);
      font-weight: var(--type-display-font-weight);
      line-height: var(--type-display-line-height);
      color: var(--color-text);
    }
    .version {
      margin: 0;
      font-size: 12px;
      letter-spacing: 0.02em;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .updates {
      display: grid;
      gap: var(--spacing-xs);
    }
    .installed {
      margin: 0;
      font-size: 12px;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .check-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-sm) var(--spacing-md);
    }
    .status {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--color-muted);
    }
    .status.error {
      color: var(--color-primary);
    }
    .restart {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm) var(--spacing-md);
      padding: var(--spacing-md);
      background: color-mix(in srgb, var(--color-primary) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-primary) 42%, transparent);
      border-radius: var(--rounded-md);
    }
    .restart .status {
      color: var(--color-text);
    }
    .release {
      display: grid;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      background: var(--color-surface);
      border-radius: var(--rounded-md);
    }
    .release-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-xs);
    }
    .release-title {
      margin: 0;
      font-family: var(--type-section-font-family);
      font-size: var(--type-section-font-size);
      font-weight: var(--type-section-font-weight);
      line-height: var(--type-section-line-height);
      color: var(--color-text);
    }
    .notes {
      display: grid;
      gap: var(--spacing-xs);
      max-block-size: 240px;
      overflow: auto;
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
      color: var(--color-muted);
      overflow-wrap: anywhere;
    }
    .notes p,
    .notes ul,
    .notes ol {
      margin: 0;
    }
    .notes ul,
    .notes ol {
      padding-inline-start: var(--spacing-lg);
      display: grid;
      gap: var(--spacing-xxs);
    }
    .note-heading {
      margin: var(--spacing-xs) 0 0;
      font-family: var(--type-row-title-font-family);
      font-weight: var(--type-row-title-font-weight);
      line-height: var(--type-row-title-line-height);
      color: var(--color-text);
    }
    .note-heading-1 {
      font-size: var(--type-section-font-size);
    }
    .note-heading-2 {
      font-size: var(--type-row-title-font-size);
    }
    .note-heading-3 {
      font-size: var(--type-body-sm-font-size);
    }
    .notes strong {
      font-weight: 600;
      color: var(--color-text);
    }
    .notes code {
      padding: 0 var(--spacing-xxs);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.92em;
      color: var(--color-text);
      background: var(--color-surface-raised);
      border-radius: var(--rounded-sleeve);
    }
    .notes a {
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .notes a:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-sm);
    }
    .text-link {
      display: inline-flex;
      align-items: center;
      min-block-size: 44px;
      font-size: 14px;
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .progress {
      block-size: 4px;
      overflow: hidden;
      background: color-mix(in srgb, var(--color-border) 50%, transparent);
      border-radius: var(--rounded-full);
    }
    /* Scaled, not resized: a compositor-only change on every progress event. */
    .fill {
      display: block;
      block-size: 100%;
      inline-size: 100%;
      background: var(--color-primary);
      transform-origin: left center;
      transition: transform var(--duration-fast) var(--ease-standard);
    }
    .way {
      padding: var(--spacing-md);
      background: var(--color-surface);
      border-radius: var(--rounded-md);
    }
    .lede {
      margin: 0;
      font-size: var(--type-body-font-size);
      line-height: var(--type-body-line-height);
      color: var(--color-text);
    }
    .ways {
      display: grid;
      gap: var(--spacing-sm);
      margin-block-start: var(--spacing-md);
    }
    .way-title {
      margin: 0;
      font-family: var(--type-section-font-family);
      font-size: var(--type-section-font-size);
      font-weight: var(--type-section-font-weight);
      line-height: var(--type-section-line-height);
      color: var(--color-text);
    }
    .way p {
      margin: var(--spacing-xxs) 0 0;
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
      color: var(--color-muted);
    }
    .links {
      display: grid;
      gap: var(--spacing-sm);
    }
    .link-row {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      min-block-size: var(--spacing-touch);
      padding: 0 var(--spacing-md);
      font-size: var(--type-row-title-font-size);
      font-weight: var(--type-row-title-font-weight);
      color: var(--color-text);
      text-decoration: none;
      background: var(--color-surface);
      border-radius: var(--rounded-md);
      transition: background-color var(--duration-fast) var(--ease-standard);
    }
    .link-row or-icon {
      color: var(--color-muted);
    }
    .link-row:hover {
      background: var(--color-surface-raised);
    }
    .link-row:focus-visible,
    .text-link:focus-visible,
    .disclaimer:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .disclaimer {
      margin: 0;
      padding: var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
      border: 1px dashed
        color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-md);
    }
    @media (prefers-reduced-motion: reduce) {
      .link-row,
      .fill {
        transition-duration: 1ms;
      }
    }
  `,
})
export class AboutPage {
  protected readonly version = APP_VERSION;
  protected readonly links = LINKS;
  protected readonly disclaimer = MUSIC_DISCLAIMER;
  protected readonly updates = inject(UpdateStore);

  /** Whole percent of the running download. */
  protected readonly percent = computed(() =>
    Math.round((this.updates.progress() ?? 0) * 100),
  );
  /** One-line status under the check button (errors are shown separately). */
  protected readonly status = computed(() => {
    if (this.updates.checking()) return 'Checking…';
    const rel = this.updates.release();
    if (this.updates.phase() === 'downloading' && rel) return `Downloading version ${rel.version}…`;
    if (rel) {
      return this.isSkipped()
        ? `Version ${rel.version} is available (skipped).`
        : `Version ${rel.version} is available.`;
    }
    return this.updates.upToDate() ? "You're up to date." : '';
  });
  /** True when this platform can download the current release in the app. */
  protected readonly canDownload = computed(() => {
    const rel = this.updates.release();
    if (!rel) return false;
    return this.updates.canSelfUpdate() || (this.updates.canInstallApk() && rel.apkUrl !== null);
  });
  protected readonly downloadLabel = computed(() => {
    if (this.updates.phase() === 'error') return 'Try again';
    return this.updates.canInstallApk() && !this.updates.canSelfUpdate()
      ? 'Download and install'
      : 'Download update';
  });
  /** The offered release's notes as safe, typed blocks (see `release-notes.ts`). */
  protected readonly notes = computed(() =>
    parseReleaseNotes(this.updates.release()?.notes ?? ''),
  );
  /** The offered release is the one the user chose to skip. */
  protected readonly isSkipped = computed(() => {
    const rel = this.updates.release();
    return rel !== null && rel.version === this.updates.skippedVersion();
  });

  private readonly route = inject(ActivatedRoute);
  private readonly disclaimerEl =
    viewChild.required<ElementRef<HTMLElement>>('disclaimerEl');
  /** Tracks the fragment, so same-page navigation to `#music-disclaimer` scrolls too. */
  private readonly fragment = toSignal(this.route.fragment, {
    requireSync: true,
  });

  constructor() {
    // Re-runs only when the fragment changes (or after the first render).
    afterRenderEffect(() => {
      if (this.fragment() !== 'music-disclaimer') return;
      const el = this.disclaimerEl().nativeElement;
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
    });
  }

  protected checkNow(): void {
    void this.updates.check({ manual: true });
  }

  protected download(): void {
    void this.updates.download();
  }

  protected restart(): void {
    void this.updates.restartAndInstall();
  }

  protected skip(): void {
    this.updates.skipVersion();
  }

  protected unskip(): void {
    this.updates.clearSkip();
  }
}
