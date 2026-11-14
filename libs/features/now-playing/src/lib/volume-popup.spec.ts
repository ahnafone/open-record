import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SessionStore } from '@open-record/state';
import { OrVolumePopup, VOLUME_POPUP_HIDE_MS } from './volume-popup';

function makeSession() {
  return {
    isControllingRemote: signal(true),
    remoteVolume: signal(0.4),
    remoteVolumeControllable: signal(true),
    volumeActivity: signal(0),
    setRemoteVolume: vi.fn(),
  };
}

describe('OrVolumePopup', () => {
  let fixture: ComponentFixture<OrVolumePopup>;
  let session: ReturnType<typeof makeSession>;
  let host: HTMLElement;

  beforeEach(async () => {
    vi.useFakeTimers();
    session = makeSession();
    await TestBed.configureTestingModule({
      imports: [OrVolumePopup],
      providers: [{ provide: SessionStore, useValue: session }],
    }).compileComponents();
    fixture = TestBed.createComponent(OrVolumePopup);
    host = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('shows on volume activity and hides after the window', () => {
    expect(host.classList.contains('shown')).toBe(false);

    session.volumeActivity.set(1);
    fixture.detectChanges();
    expect(host.classList.contains('shown')).toBe(true);

    vi.advanceTimersByTime(VOLUME_POPUP_HIDE_MS - 1);
    fixture.detectChanges();
    expect(host.classList.contains('shown')).toBe(true);

    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(host.classList.contains('shown')).toBe(false);
  });

  it('stays open while the pointer is over it', () => {
    session.volumeActivity.set(1);
    fixture.detectChanges();
    host.dispatchEvent(new PointerEvent('pointerenter'));

    vi.advanceTimersByTime(VOLUME_POPUP_HIDE_MS * 3);
    fixture.detectChanges();
    expect(host.classList.contains('shown')).toBe(true);

    host.dispatchEvent(new PointerEvent('pointerleave'));
    vi.advanceTimersByTime(VOLUME_POPUP_HIDE_MS);
    fixture.detectChanges();
    expect(host.classList.contains('shown')).toBe(false);
  });

  it('never shows when the remote is not controlled', () => {
    session.isControllingRemote.set(false);
    fixture.detectChanges();
    session.volumeActivity.set(1);
    fixture.detectChanges();
    expect(host.classList.contains('shown')).toBe(false);
  });
});
