import type { BackgroundWorkPort } from './ports';

/** Notification text for `left` downloads still to go. */
export function downloadsLeftText(left: number): string {
  return `Downloading · ${left} left`;
}

/**
 * Drives a `BackgroundWorkPort` from the number of downloads left: starts
 * the hold when work appears, updates the text while it runs and stops it
 * when nothing is left. Calls are chained so the native side always sees
 * start, update..., stop in order.
 */
export class BackgroundWorkHold {
  private held = false;
  private text = '';
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: BackgroundWorkPort,
    private readonly title = 'Open Record',
  ) {}

  sync(left: number): void {
    if (left > 0) {
      const text = downloadsLeftText(left);
      if (!this.held) {
        this.held = true;
        this.text = text;
        this.enqueue(() => this.port.start({ title: this.title, text }));
      } else if (text !== this.text) {
        this.text = text;
        this.enqueue(() => this.port.update({ text }));
      }
    } else if (this.held) {
      this.held = false;
      this.text = '';
      this.enqueue(() => this.port.stop());
    }
  }

  /** Resolves once every queued native call has settled. */
  settled(): Promise<void> {
    return this.chain;
  }

  private enqueue(call: () => Promise<void>): void {
    this.chain = this.chain.then(call).catch(() => undefined);
  }
}
