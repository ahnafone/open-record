/**
 * Copies `text` to the clipboard. Uses the async Clipboard API when available
 * and falls back to a hidden textarea + `document.execCommand('copy')` (for
 * insecure contexts or denied permissions). Resolves `true` on success and
 * `false` otherwise; never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context: try the legacy path below.
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const previous = document.activeElement as HTMLElement | null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  // Inside an open dialog so its focus trap (focusin) doesn't pull focus away
  // before execCommand('copy') runs.
  const container =
    (previous?.closest?.('[role="dialog"]') as HTMLElement | null) ??
    document.body;
  container.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    previous?.focus?.();
  }
}
