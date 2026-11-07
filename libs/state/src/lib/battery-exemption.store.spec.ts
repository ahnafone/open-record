import { TestBed } from '@angular/core/testing';
import { StoragePort, createInMemoryStorage } from '@open-record/storage';
import { BatteryExemptionStore } from './battery-exemption.store';
import { BackgroundWorkPort } from './ports';

/** Sets up the store; `exempt` is what the native side reports (null = unknown). */
function boot(exempt: boolean | null) {
  TestBed.resetTestingModule();
  const port = {
    start: () => Promise.resolve(),
    update: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    isIgnoringBatteryOptimizations: () => Promise.resolve(exempt),
    requestIgnoreBatteryOptimizations: vi.fn(() => Promise.resolve(true)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: createInMemoryStorage() },
      { provide: BackgroundWorkPort, useValue: port },
    ],
  });
  return { store: TestBed.inject(BatteryExemptionStore), port };
}

describe('BatteryExemptionStore', () => {
  it('prompts only when not exempt, and a decline neither rejects nor re-prompts during the cooldown', async () => {
    const exempt = boot(true);
    const askWhenExempt = vi.fn(() => Promise.resolve(true));
    await exempt.store.offerOnSwitchOn(askWhenExempt);
    expect(askWhenExempt).not.toHaveBeenCalled();

    const notExempt = boot(false);
    const ask = vi.fn(() => Promise.resolve(false));
    await expect(notExempt.store.offerOnSwitchOn(ask)).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(notExempt.port.requestIgnoreBatteryOptimizations).not.toHaveBeenCalled();

    await notExempt.store.offerOnSwitchOn(ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a system dialog the user denies counts as a decline: no re-ask during the cooldown', async () => {
    TestBed.resetTestingModule();
    // Still not exempt after the system dialog: the user denied it.
    const port = {
      start: () => Promise.resolve(),
      update: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      isIgnoringBatteryOptimizations: vi.fn(() => Promise.resolve(false)),
      requestIgnoreBatteryOptimizations: vi.fn(() => Promise.resolve(false)),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: BackgroundWorkPort, useValue: port },
      ],
    });
    const store = TestBed.inject(BatteryExemptionStore);
    const ask = vi.fn(() => Promise.resolve(true));
    await store.offerOnSwitchOn(ask);
    expect(port.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
    await store.offerOnSwitchOn(ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('never prompts when the platform cannot report exemption (web/iOS)', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: StoragePort, useValue: createInMemoryStorage() },
        { provide: BackgroundWorkPort, useValue: null },
      ],
    });
    const ask = vi.fn(() => Promise.resolve(true));
    await TestBed.inject(BatteryExemptionStore).offerOnSwitchOn(ask);
    expect(ask).not.toHaveBeenCalled();
  });
});
