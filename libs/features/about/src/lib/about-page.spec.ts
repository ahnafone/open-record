import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AboutPage } from './about-page';
import { APP_VERSION } from './app-version';

describe('AboutPage', () => {
  it('renders the app version', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(AboutPage);
    fixture.detectChanges();

    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(fixture.nativeElement.textContent).toContain(`v${APP_VERSION}`);
  });

  it('labels the project links Download App, GitHub and Official Site', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(AboutPage);
    fixture.detectChanges();

    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('.link-row span'),
      (el) => (el as HTMLElement).textContent?.trim(),
    );
    expect(labels).toEqual(['Download App', 'GitHub', 'Official Site']);
  });
});
