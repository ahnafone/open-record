import { copyText } from './copy-text';

/** Clipboard API rejects (denied), so copyText must take the execCommand path. */
const denyClipboard = () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn().mockRejectedValue(new Error('denied')),
    },
  });
};

describe('copyText', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('falls back to execCommand and resolves true when it succeeds', async () => {
    denyClipboard();
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    });
    await expect(copyText('https://example.com/a')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('copies inside an open dialog even when its focusin trap steals focus', async () => {
    denyClipboard();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const opener = document.createElement('button');
    const first = document.createElement('button');
    dialog.append(opener, first);
    document.body.appendChild(dialog);
    // Mimics OrModal: pull focus back to the dialog on any outside focusin.
    const trap = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) first.focus();
    };
    document.addEventListener('focusin', trap);
    // jsdom's select() doesn't move focus, so assert where the textarea lives
    // when execCommand runs (browsers focus it, which the trap would undo if
    // it were outside the dialog).
    let textareaInDialog = false;
    const exec = vi.fn(() => {
      const textarea = document.querySelector('textarea');
      textareaInDialog = !!textarea && dialog.contains(textarea);
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    });
    try {
      opener.focus();
      await expect(copyText('https://example.com/a')).resolves.toBe(true);
      expect(exec).toHaveBeenCalledWith('copy');
      expect(textareaInDialog).toBe(true);
      // Focus is restored and the hidden textarea is removed afterwards.
      expect(document.activeElement).toBe(opener);
      expect(dialog.querySelector('textarea')).toBeNull();
    } finally {
      document.removeEventListener('focusin', trap);
      dialog.remove();
    }
  });

  it('resolves false when the execCommand fallback fails', async () => {
    denyClipboard();
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    await expect(copyText('https://example.com/a')).resolves.toBe(false);
  });
});
