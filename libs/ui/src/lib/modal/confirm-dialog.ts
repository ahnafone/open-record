import {
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  EnvironmentInjector,
  Injectable,
  createComponent,
  inject,
  input,
  output,
} from '@angular/core';
import { OrButton } from '../button/button';
import { OrModal } from './modal';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Destructive action: the confirm button uses the danger style. */
  danger?: boolean;
}

/** Internal: the confirm dialog rendered by `OrDialog.confirm`. */
@Component({
  selector: 'or-confirm-dialog',
  imports: [OrModal, OrButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal
      [open]="true"
      [heading]="options().title"
      (dismissed)="resolved.emit(false)"
    >
      <p class="message">{{ options().message }}</p>
      <div orModalActions>
        <or-button
          block
          [variant]="options().danger ? 'danger' : 'primary'"
          (click)="resolved.emit(true)"
        >
          {{ options().confirmLabel || 'Confirm' }}
        </or-button>
        <or-button block (click)="resolved.emit(false)">{{
          options().cancelLabel || 'Cancel'
        }}</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    .message {
      margin: 0;
      color: var(--color-muted);
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
    }
    [orModalActions] {
      display: grid;
      gap: var(--spacing-sm);
    }
  `,
})
export class OrConfirmDialog {
  readonly options = input.required<ConfirmOptions>();
  readonly resolved = output<boolean>();
}

/** Imperative dialogs rendered at the end of <body>. */
@Injectable({ providedIn: 'root' })
export class OrDialog {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);
  private readonly document = inject(DOCUMENT);

  /**
   * Opens a confirm dialog. Resolves `true` on confirm, `false` on cancel,
   * Escape or backdrop. Focus returns to the previously focused element.
   */
  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const ref = createComponent(OrConfirmDialog, {
        environmentInjector: this.injector,
      });
      ref.setInput('options', options);
      let done = false;
      const sub = ref.instance.resolved.subscribe((value) => {
        if (done) return;
        done = true;
        sub.unsubscribe();
        this.appRef.detachView(ref.hostView);
        ref.destroy();
        ref.location.nativeElement.remove();
        resolve(value);
      });
      this.document.body.appendChild(ref.location.nativeElement);
      this.appRef.attachView(ref.hostView);
      ref.changeDetectorRef.detectChanges();
    });
  }
}
