import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthStore } from '@open-record/state';
import { OrButton, OrModal } from '@open-record/ui';
import { AccountSection } from './account-section';

/**
 * App-shell "Sign in to continue" modal, opened by `AuthStore.requireAccount`
 * / `promptSignIn` when a signed-out user tries an account-only action. It
 * reuses the Account sign-in form and closes itself once signed in.
 */
@Component({
  selector: 'or-sign-in-prompt',
  imports: [OrModal, OrButton, AccountSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal
      [open]="!!auth.signInPrompt()"
      heading="Sign in to continue"
      (dismissed)="auth.closeSignInPrompt()"
    >
      <p class="message">{{ auth.signInPrompt() }}</p>
      <or-account-section compact />
      <div orModalActions>
        <or-button block (click)="auth.closeSignInPrompt()">Not now</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    .message {
      margin: 0 0 var(--spacing-sm);
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
export class OrSignInPrompt {
  protected readonly auth = inject(AuthStore);
}
