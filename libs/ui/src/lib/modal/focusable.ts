const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

/** Tabbable descendants of `root` in DOM order (enabled, not hidden, not inert). */
export function tabbables(root: HTMLElement): HTMLElement[] {
  const view = root.ownerDocument.defaultView;
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => {
      if (el.tabIndex < 0) return false;
      if ((el as HTMLButtonElement).disabled) return false;
      if (el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
      const style = view?.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden'))
        return false;
      return true;
    },
  );
}
