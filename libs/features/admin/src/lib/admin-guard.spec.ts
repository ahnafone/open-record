import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  UrlTree,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { AuthStore } from '@open-record/state';
import { adminGuard } from './admin-guard';

function run(isAdmin: boolean) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: AuthStore,
        useValue: { start: async () => undefined, whenAdminResolved: async () => undefined, isAdmin: signal(isAdmin) },
      },
    ],
  });
  return TestBed.runInInjectionContext(() =>
    adminGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
  );
}

describe('adminGuard', () => {
  it('denies a non-admin and redirects to Browse', async () => {
    const result = await run(false);
    expect(result).toBeInstanceOf(UrlTree);
    expect(String(result)).toBe('/browse');
  });

  it('allows the admin', async () => {
    expect(await run(true)).toBe(true);
  });
});
