// The app's shared context, and the shell that mounts one screen at a time.
// Screens get the context; nothing else reaches them. The shell owns what
// outlives a screen: the hash route, the banners, and the resume handler.

import { cards as allCards, packs } from './cards/bundle.ts';
import type { Card } from './cards/types.ts';
import { buildFormIndex, type FormIndex } from './check/answer.ts';
import { localZone, type Zone } from './day.ts';
import { Db, NotSavedError } from './db/db.ts';
import { recordError } from './errors.ts';
import type { LanguagePack } from './pack/types.ts';
import { h, replace } from './ui/dom.ts';
import { parseRoute, routeHash, type Route } from './ui/router.ts';
import { SAFARI_TAB_WARNING, isSafariTab } from './ui/safari.ts';

export interface App {
  db: Db;
  /** This deployment's cards, in introduction order, retired ones included. */
  cards: readonly Card[];
  pack: LanguagePack;
  /** Every corpus form, for naming a wrong form. */
  forms: FormIndex;
  buildId: string;
  /** The highest lesson bundled in this build. */
  newestLesson: number;
  zone: Zone;
  now(): number;
  go(route: Route): void;
  /** A short message that fades: a skipped card, a saved backup. */
  notice(text: string): void;
  /** Report an error from a write or a render; a NotSavedError blocks the screen. */
  fail(error: unknown): void;
}

export interface Screen {
  el: HTMLElement;
  /** The app came back to the foreground (SPEC.md, Days and the clock). */
  resume?(): void;
  dispose?(): void;
}

export type ScreenFactory = (app: App) => Promise<Screen>;

declare const __BUILD_ID__: string;

/**
 * One deployment teaches one target language (SPEC.md, Core concepts), so
 * the language is whichever the bundled cards are in.
 */
function bundledLanguage(): { language: string; pack: LanguagePack } {
  const languages = [...new Set(allCards.map((c) => c.language))];
  if (languages.length !== 1) throw new Error(`expected cards in one language, found ${languages.length}`);
  const language = languages[0]!;
  const pack = packs[language];
  if (!pack) throw new Error(`no language pack for ${language}`);
  return { language, pack };
}

export class Shell {
  readonly app: App;
  #screens: Record<Route, ScreenFactory>;
  #banners = h('div', { class: 'banners' });
  #main = h('div', { class: 'screen' });
  #toasts = h('div', { class: 'toasts', attrs: { 'aria-live': 'polite' } });
  #current: Screen | null = null;
  #mounting = 0;
  #blocked = false;
  /** Settles start(); null once a first screen has shown or startup failed. */
  #startup: { resolve: () => void; reject: (e: unknown) => void } | null = null;

  constructor(root: HTMLElement, screens: Record<Route, ScreenFactory>) {
    this.#screens = screens;
    const { pack } = bundledLanguage();
    const cards = allCards.filter((c) => c.language === pack.code);
    const db = new Db({ onBlocking: () => this.#block('A newer version of Corvus needs this page to reload.') });
    this.app = {
      db,
      cards,
      pack,
      forms: buildFormIndex(cards),
      buildId: __BUILD_ID__,
      newestLesson: Math.max(0, ...cards.map((c) => c.lesson)),
      zone: localZone,
      now: () => Date.now(),
      go: (route) => {
        if (location.hash === routeHash(route)) void this.#mount();
        else location.hash = routeHash(route);
      },
      notice: (text) => this.#notice(text),
      fail: (error) => this.#fail(error),
    };
    replace(root, this.#banners, this.#main, this.#toasts);
    if (isSafariTab()) {
      this.#banners.append(h('p', { class: 'banner', text: SAFARI_TAB_WARNING }));
    }
  }

  /**
   * Show the first screen and follow navigation from then on. Rejects if no
   * screen could be shown, so startup can fall back to the recovery screen;
   * once one has shown, failures are reported on the screen instead. If the
   * user navigates before the first screen shows, the newer screen decides.
   */
  start(): Promise<void> {
    const started = new Promise<void>((resolve, reject) => (this.#startup = { resolve, reject }));
    addEventListener('hashchange', () => void this.#mount());
    // iPadOS often resumes a Home Screen app rather than relaunching it.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.#current?.resume?.();
    });
    addEventListener('pageshow', (e) => {
      if (e.persisted) this.#current?.resume?.();
    });
    void this.#mount();
    return started;
  }

  async #mount(): Promise<void> {
    if (this.#blocked) return;
    const ticket = ++this.#mounting;
    this.#current?.dispose?.();
    this.#current = null;
    const route = parseRoute(location.hash);
    try {
      const screen = await this.#screens[route](this.app);
      // A later navigation won the race, or a block was raised while this
      // screen loaded; either way it is no longer wanted.
      if (ticket !== this.#mounting || this.#blocked) return screen.dispose?.();
      this.#current = screen;
      replace(this.#main, screen.el);
      document.title = route === 'home' ? 'Corvus' : `Corvus · ${route[0]!.toUpperCase()}${route.slice(1)}`;
      this.#startup?.resolve();
      this.#startup = null;
    } catch (e) {
      // The block banner already owns the screen (the database it closed may
      // be why this mount failed).
      if (this.#blocked) return recordError(e);
      const startup = this.#startup;
      if (!startup) return this.#fail(e);
      // Still starting, and a newer mount is under way: it decides the outcome.
      if (ticket !== this.#mounting) return recordError(e);
      // No screen has shown. The recovery screen takes over the page, and
      // this shell stops mounting.
      this.#blocked = true;
      this.#startup = null;
      startup.reject(e);
    }
  }

  #notice(text: string): void {
    const toast = h('p', { class: 'toast', text });
    this.#toasts.append(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  #fail(error: unknown): void {
    recordError(error);
    console.error(error);
    if (error instanceof NotSavedError) this.#block('Not saved. Reload.');
    else this.#notice(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Cover the screen with a red banner that only a reload clears. */
  #block(text: string): void {
    if (this.#blocked) return;
    this.#blocked = true;
    // A block during startup is still a started app: the banner, not the
    // recovery screen, is what the user needs.
    this.#startup?.resolve();
    this.#startup = null;
    this.#current?.dispose?.();
    this.#current = null;
    replace(
      this.#main,
      h('div', { class: 'blocked', attrs: { role: 'alert' } },
        h('p', { text }),
        h('button', { class: 'primary', text: 'Reload', on: { click: () => location.reload() } }),
      ),
    );
  }
}
