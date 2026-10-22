// The Safari-tab warning (SPEC.md, iPad facts). A Home Screen app's storage
// is separate from Safari's, so a tab sees different progress. The shell and
// the recovery screen both show it, so it lives apart from the app.

export const SAFARI_TAB_WARNING = 'This is a Safari tab. Progress here is separate from the Home Screen app.';

/** iPadOS Safari, in a tab rather than the Home Screen app. */
export function isSafariTab(): boolean {
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
  return standalone === false && !matchMedia('(display-mode: standalone)').matches;
}
