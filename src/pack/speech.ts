import type { SpeechRule } from './types.ts';

// Respell text for the speech engine. Only what is spoken changes, never what
// is displayed. The order matches the pack schema: decompose (NFD) so marks
// are separate characters a rule can match, apply each rule as a global,
// case-insensitive pattern, then recompose (NFC).
export function respell(text: string, rules: SpeechRule[]): string {
  let s = text.normalize('NFD');
  for (const rule of rules) {
    // A function replacement keeps `$` in the replacement literal.
    s = s.replace(new RegExp(rule.match, 'giu'), () => rule.replace);
  }
  return s.normalize('NFC');
}
