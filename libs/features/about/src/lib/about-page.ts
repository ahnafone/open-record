import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  APPS_URL,
  DOCS_URL,
  GITHUB_URL,
  OrIcon,
  OrSectionHead,
  type IconName,
} from '@open-record/ui';
import { APP_VERSION } from './app-version';
import { MUSIC_DISCLAIMER } from './credits';

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
 * the two ways to use it, project links and the music disclaimer. Settings
 * links here; `#music-disclaimer` scrolls to the disclaimer.
 */
@Component({
  selector: 'or-about-page',
  imports: [OrIcon, OrSectionHead],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="hero">
      <h1 class="app-name">Open Record</h1>
      <p class="version">v{{ version }}</p>
    </header>

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
    .way {
      padding: var(--spacing-md);
      background: var(--color-surface);
      border-radius: var(--rounded-md);
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
      .link-row {
        transition-duration: 1ms;
      }
    }
  `,
})
export class AboutPage {
  protected readonly version = APP_VERSION;
  protected readonly links = LINKS;
  protected readonly disclaimer = MUSIC_DISCLAIMER;

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
}
