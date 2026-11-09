import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';

/** One name in a credit; `commands` null renders plain text. */
export interface CreditLinkView {
  readonly name: string;
  readonly commands: string[] | null;
}

/** Credit as built by `artistCredit` in @open-record/state (structurally typed here). */
export interface ArtistCreditView {
  readonly artists: readonly CreditLinkView[];
  readonly album: CreditLinkView | null;
}

/**
 * Inline artist credit: each artist links to its artist page, separated by
 * ", ", and the album (when present) links to its album page after " · ".
 * Set `showArtist` false to render only the album link. Place this beside a
 * row's stretched play button (a sibling, never inside a `<button>` or other
 * clickable ancestor): links are positioned above that overlay, while plain
 * text stays inert under it, so a link tap never reaches the play action.
 */
@Component({
  selector: 'or-artist-links',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (showArtist()) {
      @for (artist of credit().artists; track $index; let last = $last) {
        @if (artist.commands; as commands) {
          <a class="link" [routerLink]="commands">{{ artist.name }}</a>
        } @else {
          <span>{{ artist.name }}</span>
        }
        @if (!last) {
          <span>, </span>
        }
      }
    }
    @if (credit().album; as album) {
      @if (showArtist() && credit().artists.length) {
        <span> · </span>
      }
      @if (album.commands; as commands) {
        <a class="link" [routerLink]="commands">{{ album.name }}</a>
      } @else {
        <span>{{ album.name }}</span>
      }
    }
  `,
  styles: `
    :host {
      display: inline;
    }
    .link {
      /* Positioned + z-index so the link paints above a row's stretched
         overlay play button (position: absolute; inset: 0, z-index auto). */
      position: relative;
      z-index: 1;
      color: inherit;
      text-decoration: none;
      border-radius: 2px;
      /* Rows set pointer-events: none on their text; re-enable taps on links. */
      pointer-events: auto;
    }
    .link:hover {
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    /* Inset ring: consumers clip with overflow: hidden (ellipsis lines), which
       would cut an outside ring. Still the 2px coral outline from DESIGN.md. */
    .link:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
  `,
})
export class OrArtistLinks {
  /** Built with `| artistCredit` from @open-record/state. */
  readonly credit = input.required<ArtistCreditView>();
  /** Render the artist names; set false to show only the album link. */
  readonly showArtist = input(true, { transform: booleanAttribute });
}
