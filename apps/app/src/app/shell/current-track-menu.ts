import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { SourceFixService } from '@open-record/state';
import {
  OrButton,
  OrIconButton,
  OrModal,
  OrToast,
  copyText,
  isHttpUrl,
} from '@open-record/ui';

/**
 * Options (⋯) for the record that is loaded in the shell's player bar or mini
 * player: Fix source and Copy source link. Renders nothing when the record has
 * no source link (the same rule that decides whether Fix source is offered).
 * The parent sets the host's opacity to reveal it on hover or focus; the host
 * stays focusable while transparent.
 */
@Component({
  selector: 'or-current-track-menu',
  imports: [OrButton, OrIconButton, OrModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-empty]': '!hasSource()',
  },
  template: `
    @if (hasSource()) {
      <or-icon-button
        icon="more"
        [label]="'Options for ' + track().title"
        (click)="optionsOpen.set(true)"
      />
      <or-modal
        [open]="optionsOpen()"
        [heading]="track().title"
        closable
        (dismissed)="optionsOpen.set(false)"
      >
        <div orModalActions>
          <or-button block (click)="fixSource()">Fix source</or-button>
          @if (httpUrl()) {
            <or-button block (click)="copySource()">Copy source link</or-button>
          }
        </div>
      </or-modal>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: none;
      transition: opacity var(--duration-fast) var(--ease-standard);
    }
    :host(.is-empty) {
      display: none;
    }
    @media (prefers-reduced-motion: reduce) {
      :host {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrCurrentTrackMenu {
  readonly track = input.required<Track>();

  private readonly sourceFix = inject(SourceFixService);
  private readonly toast = inject(OrToast);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly optionsOpen = signal(false);
  protected readonly hasSource = computed(() => !!this.track().source?.url);
  protected readonly httpUrl = computed(() =>
    isHttpUrl(this.track().source?.url ?? ''),
  );
  private readonly trackId = computed(() => this.track().id);

  constructor() {
    // A different record must not inherit an open options modal.
    effect(() => {
      this.trackId();
      untracked(() => this.optionsOpen.set(false));
    });
  }

  /** Close the modal, then open the shared Fix source dialog for this record. */
  protected fixSource(): void {
    this.optionsOpen.set(false);
    // Focus returns to this menu's ⋯ button when the Fix source dialog closes.
    const button =
      this.host.nativeElement.querySelector<HTMLElement>('button') ?? undefined;
    this.sourceFix.open(this.track(), button);
  }

  /** Copy while the modal is still open, then close it and report the result. */
  protected async copySource(): Promise<void> {
    const url = this.track().source?.url;
    if (!url || !isHttpUrl(url)) return;
    const copied = await copyText(url);
    this.optionsOpen.set(false);
    this.toast.show(copied ? 'Source link copied' : 'Could not copy link');
  }
}
