import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type ActivatedRouteSnapshot, type RouterStateSnapshot, type UrlTree } from '@angular/router';
import { AuthStore, WEB_BUILD } from '@open-record/state';
import { requireWebAccount } from './web-account.guard';

function setup(opts: { web: boolean; signedIn?: boolean; accountsReady?: boolean }) {
  const auth = {
    start: vi.fn(async () => undefined),
    signedIn: () => opts.signedIn ?? false,
    accountsReady: () => opts.accountsReady ?? true,
    promptSignIn: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: AuthStore, useValue: auth }, { provide: WEB_BUILD, useValue: opts.web }],
  });
  const run = () =>
    TestBed.runInInjectionContext(() => requireWebAccount({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot));
  return { auth, run, router: TestBed.inject(Router) };
}

describe('requireWebAccount', () => {
  it('web build, signed out: opens the sign-in prompt and sends a direct visit to Browse', async () => {
    const { auth, run, router } = setup({ web: true });
    expect(router.navigated).toBe(false);

    const result = await run();

    expect(auth.promptSignIn).toHaveBeenCalledTimes(1);
    expect((result as UrlTree).toString()).toBe('/browse');
  });

  it('web build, signed in: the page opens', async () => {
    const { auth, run } = setup({ web: true, signedIn: true });

    await expect(run()).resolves.toBe(true);
    expect(auth.promptSignIn).not.toHaveBeenCalled();
  });

  it('native or desktop (not the web build): the page opens without a prompt, even signed out', async () => {
    const { auth, run } = setup({ web: false });

    await expect(run()).resolves.toBe(true);
    expect(auth.promptSignIn).not.toHaveBeenCalled();
  });

  it('web build with no account service configured: stays anonymous and opens', async () => {
    const { auth, run } = setup({ web: true, accountsReady: false });

    await expect(run()).resolves.toBe(true);
    expect(auth.promptSignIn).not.toHaveBeenCalled();
  });
});
