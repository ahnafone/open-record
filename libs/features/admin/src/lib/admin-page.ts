import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  type ConfirmOptions,
  OrButton,
  OrDialog,
  OrEmptyState,
  OrIcon,
  OrSectionHead,
  OrSpinner,
  OrTag,
  OrToast,
  type IconName,
} from '@open-record/ui';
import type {
  AccessAction,
  AccessRequest,
  AccessStatus,
} from '@open-record/models';
import {
  ACTION_DONE,
  STATUS_LABEL,
  absoluteTime,
  emptyMessage,
  newestFirst,
  relativeTime,
} from './admin-format';
import { AdminRequestsStore } from './admin-requests.store';

const FILTERS: readonly { value: AccessStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
  { value: 'revoked', label: 'Revoked' },
];

/**
 * Admin screen (`/admin`): review access requests. Filter by status, approve,
 * deny or revoke. Only reachable through `adminGuard`; the server enforces the
 * same rule on every call.
 */
@Component({
  selector: 'or-admin-page',
  imports: [OrButton, OrEmptyState, OrIcon, OrSectionHead, OrSpinner, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="Access requests" />
    <p class="lede">
      People who asked for access to Open Record. Approve, deny or revoke them
      here.
    </p>

    <div class="toolbar">
      <div class="filters" role="group" aria-label="Show requests with status">
        @for (f of filters; track f.value) {
          <button
            type="button"
            class="chip"
            [attr.aria-pressed]="filter() === f.value"
            (click)="filter.set(f.value)"
          >
            {{ f.label }}
            <span
              class="count"
              [attr.aria-label]="counts()[f.value] + ' requests'"
              >{{ counts()[f.value] }}</span
            >
          </button>
        }
      </div>
      <or-button size="sm" [disabled]="store.loading()" (click)="refresh()">
        {{ store.loading() ? 'Refreshing…' : 'Refresh' }}
      </or-button>
    </div>

    <p class="status" role="status" aria-live="polite">
      @if (store.loading()) {
        <span class="muted"><or-spinner [size]="14" />Loading requests…</span>
      } @else if (store.loadError(); as e) {
        <span class="bad"
          ><or-icon name="alert" [size]="14" />Could not refresh: {{ e }}</span
        >
      }
    </p>

    @if (!store.loaded()) {
      @if (store.loadError(); as e) {
        <or-empty-state>
          <p class="bad block"><or-icon name="alert" [size]="14" />{{ e }}</p>
          <or-button size="sm" (click)="refresh()">Try again</or-button>
        </or-empty-state>
      } @else {
        <ul class="list" aria-hidden="true">
          <li class="skeleton"></li>
          <li class="skeleton"></li>
          <li class="skeleton"></li>
        </ul>
      }
    } @else if (visible().length === 0) {
      <or-empty-state>{{ emptyText() }}</or-empty-state>
    } @else {
      <ul
        class="list"
        [attr.aria-busy]="store.loading()"
        [attr.aria-label]="filterLabel()"
      >
        @for (r of visible(); track r.id) {
          <li class="row">
            <div class="info">
              <div class="head">
                <span class="email">{{ r.email }}</span>
                <or-tag
                  [icon]="statusIcon(r.status)"
                  [ivory]="r.status === 'approved'"
                  [class.bad]="r.status === 'denied'"
                  >{{ statusLabel[r.status] }}</or-tag
                >
              </div>
              @if (r.note) {
                <p class="note">{{ r.note }}</p>
              }
              <p class="meta">
                <time
                  [attr.datetime]="r.requested_at"
                  [attr.title]="absolute(r.requested_at)"
                  >Requested {{ relative(r.requested_at) }}</time
                >
                @if (r.decided_at) {
                  <span aria-hidden="true"> · </span>
                  <time
                    [attr.datetime]="r.decided_at"
                    [attr.title]="absolute(r.decided_at)"
                    >Decided {{ relative(r.decided_at) }}</time
                  >
                }
              </p>
            </div>

            <div class="actions">
              @switch (r.status) {
                @case ('pending') {
                  <or-button
                    variant="primary"
                    size="sm"
                    [disabled]="isBusy(r.id)"
                    [ariaLabel]="'Approve ' + r.email"
                    (click)="act(r, 'approve')"
                    >{{ isBusy(r.id) ? 'Saving…' : 'Approve' }}</or-button
                  >
                  <or-button
                    variant="danger"
                    size="sm"
                    [disabled]="isBusy(r.id)"
                    [ariaLabel]="'Deny ' + r.email"
                    (click)="act(r, 'deny')"
                    >Deny</or-button
                  >
                }
                @case ('approved') {
                  <or-button
                    variant="danger"
                    size="sm"
                    [disabled]="isBusy(r.id)"
                    [ariaLabel]="'Revoke access for ' + r.email"
                    (click)="act(r, 'revoke')"
                    >{{ isBusy(r.id) ? 'Saving…' : 'Revoke' }}</or-button
                  >
                }
                @default {
                  <or-button
                    size="sm"
                    [disabled]="isBusy(r.id)"
                    [ariaLabel]="'Approve ' + r.email"
                    (click)="act(r, 'approve')"
                    >{{ isBusy(r.id) ? 'Saving…' : 'Approve' }}</or-button
                  >
                }
              }
            </div>

            @if (rowError(r.id); as e) {
              <p class="row-error" role="alert">
                <or-icon name="alert" [size]="14" />{{ e }}
              </p>
            }
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
      max-inline-size: 800px;
    }
    .lede {
      margin: var(--spacing-xs) 0 var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }
    .chip {
      appearance: none;
      min-block-size: var(--spacing-touch);
      padding: 0 var(--spacing-md);
      font: inherit;
      font-size: 13px;
      color: var(--color-muted);
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-full);
      cursor: pointer;
      transition: background var(--duration-fast) var(--ease-standard);
    }
    .chip:hover {
      background: var(--color-surface);
    }
    .chip[aria-pressed='true'] {
      color: var(--color-ink);
      background: var(--color-ivory);
      border-color: transparent;
      font-weight: 600;
    }
    .chip:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .count {
      margin-inline-start: 6px;
      font-variant-numeric: tabular-nums;
    }
    /* Reserved status line so the list does not jump. */
    .status {
      margin: var(--spacing-xs) 0 0;
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
    }
    .muted,
    .bad {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .muted {
      color: var(--color-muted);
    }
    .bad {
      color: var(--color-primary);
    }
    .block {
      display: flex;
      justify-content: center;
      margin: 0 0 var(--spacing-sm);
    }
    .list {
      display: grid;
      gap: var(--spacing-sm);
      margin: var(--spacing-sm) 0 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: grid;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent);
      border-radius: var(--rounded-md);
    }
    @media (min-width: 560px) {
      .row {
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
      }
      .row-error {
        grid-column: 1 / -1;
      }
    }
    .info {
      display: grid;
      gap: 4px;
      min-inline-size: 0;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-xs) var(--spacing-sm);
      min-inline-size: 0;
    }
    .email {
      min-inline-size: 0;
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .note {
      margin: 0;
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
      overflow-wrap: anywhere;
    }
    .meta {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    or-tag.bad {
      color: var(--color-primary);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }
    .actions or-button {
      flex: 1 1 120px;
    }
    .row-error {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--color-primary);
    }
    .skeleton {
      block-size: 96px;
      background: var(--color-surface);
      border-radius: var(--rounded-md);
      opacity: 0.6;
      animation: or-admin-pulse 1.2s ease-in-out infinite;
    }
    @keyframes or-admin-pulse {
      50% {
        opacity: 0.3;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .skeleton {
        animation: none;
      }
      .chip {
        transition-duration: 1ms;
      }
    }
  `,
})
export class AdminPage {
  protected readonly store = inject(AdminRequestsStore);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);

  protected readonly filters = FILTERS;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly filter = signal<AccessStatus>('pending');
  protected readonly counts = this.store.counts;
  protected readonly visible = computed(() =>
    newestFirst(
      this.store.requests().filter((r) => r.status === this.filter()),
    ),
  );
  protected readonly emptyText = computed(() => emptyMessage(this.filter()));
  protected readonly filterLabel = computed(
    () =>
      `${FILTERS.find((f) => f.value === this.filter())?.label ?? ''} requests`,
  );

  constructor() {
    void this.store.load();
  }

  protected refresh(): void {
    void this.store.load();
  }

  protected isBusy(id: string): boolean {
    return this.store.busy().has(id);
  }

  protected rowError(id: string): string | null {
    return this.store.rowErrors()[id] ?? null;
  }

  protected relative(iso: string): string {
    return relativeTime(iso);
  }

  protected absolute(iso: string): string {
    return absoluteTime(iso);
  }

  protected statusIcon(status: AccessStatus): IconName | null {
    switch (status) {
      case 'approved':
        return 'check';
      case 'denied':
        return 'alert';
      case 'revoked':
        return 'lock';
      case 'pending':
        return null;
    }
  }

  /** Deny and revoke ask first; approve goes straight through. */
  protected async act(
    request: AccessRequest,
    action: AccessAction,
  ): Promise<void> {
    if (this.isBusy(request.id)) return;
    if (action !== 'approve') {
      const ok = await this.dialog.confirm(confirmFor(request, action));
      if (!ok) return;
    }
    const updated = await this.store.decide(request.id, action);
    if (updated) this.toast.show(`${ACTION_DONE[action]} for ${updated.email}`);
  }
}

function confirmFor(
  request: AccessRequest,
  action: 'deny' | 'revoke',
): ConfirmOptions {
  if (action === 'deny') {
    return {
      title: 'Deny access?',
      message: `${request.email} will not get access until you approve them.`,
      confirmLabel: 'Deny',
      danger: true,
    };
  }
  return {
    title: 'Revoke access?',
    message: `${request.email} will lose access until you approve them again.`,
    confirmLabel: 'Revoke',
    danger: true,
  };
}
