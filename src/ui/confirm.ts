// DOM helpers shared by the extension's pages (the app tab, the stop dialog). Not src/lib: these
// touch the DOM. Not src/app: the stop dialog is its own bundle and must not pull the app in.

/** How long a two-step button stays armed before it quietly disarms. */
export const ARM_MS = 8000;
/** A confirming click sooner than this after arming is ignored: a double-click must not delete. */
export const ARM_GUARD_MS = 350;

/**
 * A destructive action as an in-page two-step: the first click arms the button (its label becomes
 * the question), the second runs it; a click anywhere else, or ARM_MS, disarms. Never
 * window.confirm, which blocks the page and any automation driving it.
 */
export function confirmButton(
  label: string,
  question: string,
  cls: string,
  run: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  let timer: number | undefined;
  let armedAt = 0;
  const onOutside = (e: Event): void => {
    if (e.target !== b) disarm();
  };
  const disarm = (): void => {
    b.classList.remove('armed');
    b.textContent = label;
    window.clearTimeout(timer);
    document.removeEventListener('click', onOutside, true);
  };
  b.addEventListener('click', () => {
    if (!b.classList.contains('armed')) {
      b.classList.add('armed');
      b.textContent = question;
      armedAt = performance.now();
      timer = window.setTimeout(disarm, ARM_MS);
      // Deferred: the arming click is still propagating and would disarm at once.
      window.setTimeout(() => document.addEventListener('click', onOutside, true), 0);
      return;
    }
    if (performance.now() - armedAt < ARM_GUARD_MS) return; // the second half of a double-click
    disarm();
    run();
  });
  return b;
}
