import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { computed, signal } from '@angular/core';
import type {
  SessionDevice,
  SessionState,
  SessionTarget,
} from '@open-record/models';
import { SessionStore } from '@open-record/state';
import { DevicePickerService, OrDevicePicker } from './device-picker';

const DEVICES: SessionDevice[] = [
  {
    id: 'client-a',
    deviceId: 'install-1',
    name: 'Pixel 8',
    platform: 'android',
    online: true,
    lastSeenAt: 0,
    capabilities: { cast: false, localFiles: true },
  },
  {
    id: 'client-b',
    deviceId: 'install-1',
    name: 'Pixel 8',
    platform: 'web',
    online: true,
    lastSeenAt: 0,
    capabilities: { cast: true, localFiles: false },
  },
  {
    id: 'cast-1',
    deviceId: 'cast-1',
    name: 'Living room',
    platform: 'cast',
    online: true,
    castId: 'cast-1',
    model: 'Google Home Mini',
    lastSeenAt: 0,
    capabilities: { cast: true, localFiles: false },
  },
  {
    id: 'cast-2',
    deviceId: 'cast-2',
    name: 'Office',
    platform: 'cast',
    online: false,
    castId: 'cast-2',
    model: 'Nest Mini',
    lastSeenAt: 0,
    capabilities: { cast: true, localFiles: false },
  },
];

function sessionState(target: SessionTarget): SessionState {
  return {
    revision: 1,
    target,
    order: [],
    cursor: -1,
    positionSec: 0,
    playing: true,
    shuffle: false,
    repeat: 'off',
    updatedAt: 0,
    updatedBy: 'client-a',
  };
}

function makeSession() {
  const state = signal<SessionState | null>(
    sessionState({ kind: 'device', clientId: 'client-a', deviceId: 'install-1' }),
  );
  return {
    available: signal(true),
    devices: signal<readonly SessionDevice[]>(DEVICES),
    session: state,
    clientId: signal('client-a'),
    target: computed(() => state()?.target ?? null),
    targetStale: computed(() => state()?.targetStale === true),
    error: signal<string | null>(null),
    transferTo: vi.fn(async () => true),
    takeOver: vi.fn(async () => true),
    command: vi.fn(async () => ({ ok: true })),
  };
}

function key(target: Element, k: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('OrDevicePicker', () => {
  let fixture: ComponentFixture<OrDevicePicker>;
  let session: ReturnType<typeof makeSession>;
  let picker: DevicePickerService;
  let root: HTMLElement;

  async function setup(): Promise<HTMLButtonElement[]> {
    session = makeSession();
    await TestBed.configureTestingModule({
      imports: [OrDevicePicker],
      providers: [
        provideRouter([]),
        { provide: SessionStore, useValue: session },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(OrDevicePicker);
    picker = TestBed.inject(DevicePickerService);
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    picker.show();
    fixture.detectChanges();
    await fixture.whenStable();
    return Array.from(
      root.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
  }

  afterEach(() => {
    root?.remove();
  });

  it('renders one row per client, marks the target and labels this tab', async () => {
    const rows = await setup();
    expect(rows).toHaveLength(4);
    // Two tabs share one install: only the current client gets the suffix.
    expect(rows[0].textContent).toContain('· this tab');
    expect(rows[1].textContent).not.toContain('· this tab');
    expect(rows[0].getAttribute('aria-checked')).toBe('true');
    expect(rows[1].getAttribute('aria-checked')).toBe('false');
    expect(rows[0].textContent).toContain('Android · playing');
    expect(rows[2].textContent).toContain('Cast');
    expect(rows[2].textContent).toContain('Google Home Mini · synced');
    // An offline cast row keeps its reason and is disabled.
    expect(rows[3].disabled).toBe(true);
    expect(rows[3].textContent).toContain('Nest Mini · Offline');
  });

  it('roves focus with arrows/Home/End and transfers on select', async () => {
    const rows = await setup();
    expect(document.activeElement).toBe(rows[0]);

    key(rows[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1], 'End');
    // The offline cast row is skipped.
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2], 'Home');
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'ArrowUp');
    expect(document.activeElement).toBe(rows[2]);

    rows[1].click();
    await fixture.whenStable();
    expect(session.transferTo).toHaveBeenCalledWith({
      kind: 'device',
      clientId: 'client-b',
      deviceId: 'install-1',
    });
    expect(picker.open()).toBe(false);

    picker.show();
    fixture.detectChanges();
    await fixture.whenStable();
    const castRows = root.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    castRows[2].click();
    await fixture.whenStable();
    expect(session.transferTo).toHaveBeenLastCalledWith({
      kind: 'cast',
      castId: 'cast-1',
    });
  });
});
