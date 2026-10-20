// The language pack, as described by languages/schema.json. Everything the
// code knows about the target language and the learner's language is here.

export interface Axis {
  id: string;
  label: string;
}

export interface Grid {
  label: string;
  rows: Axis[];
  cols: Axis[];
}

export interface SpeechRule {
  match: string;
  replace: string;
  why?: string;
}

export interface Variant {
  variant: string;
  standard: string;
}

export interface LanguagePack {
  code: string;
  name: string;
  grids: Record<string, Grid>;
  defaultGrid: string;
  paradigms: Record<string, { label: string; grid: string }>;
  inputKeys: string[];
  inputHelp?: string;
  speech: {
    lang: string;
    rules: SpeechRule[];
    tests: { text: string; spoken: string }[];
  };
  learner: { lang: string; ignoreWords: string[] };
  spellingVariants: { letters: Variant[]; words: Variant[] };
}
