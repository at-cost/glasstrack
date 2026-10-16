/** @jsxImportSource hono/jsx */
import { OPERATOR } from "./operator";
import { createHash } from "node:crypto";
import type { Child } from "hono/jsx";
import { assetUrl, hasAsset } from "./assets";
import { css } from "./styles";

export const GITHUB_URL = "https://github.com/transparent-ai-businesses/glasstrack";

/**
 * Runs before first paint so a saved theme never flashes. Shares the app's key:
 * the app's darker themes map to dark, the rest to light. Allowed by its CSP hash.
 */
export const THEME_BOOT =
  '(function(){try{var t=localStorage.getItem("glasstrack-theme");var d={dark:1,midnight:1},l={light:1,snow:1,contrast:1};if(d[t])document.documentElement.setAttribute("data-theme","dark");else if(l[t])document.documentElement.setAttribute("data-theme","light")}catch(e){}})()';
export const THEME_BOOT_HASH = `'sha256-${createHash("sha256").update(THEME_BOOT).digest("base64")}'`;

let styleCache: string | null = null;
const style = () => {
  styleCache ??= css.replace("__FONT__", assetUrl("fonts/ibm-plex-mono-500.woff2")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*\n\s*/g, "\n");
  return styleCache;
};

export interface PageMeta {
  path: string;
  title: string;
  description: string;
  /** OG image name in /og/<name>.png */
  og: string;
}

export interface SiteCtx {
  baseUrl: string;
  signedIn: boolean;
}

const NAV: [string, string][] = [
  ["/pricing", "Pricing"],
  ["/finances", "Finances"],
  ["/self-host", "Self-host"],
  ["/how-its-run", "How it's run"],
  ["/about", "About"],
];

export const Mark = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="8" fill="#2f5d50" />
    <path d="M9 11h14M9 16h10M9 21h6" stroke="#f6f3ec" stroke-width="2.6" stroke-linecap="round" />
  </svg>
);

const ThemeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8">
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
  </svg>
);

export function Layout(props: { meta: PageMeta; site: SiteCtx; scripts?: string[]; children: Child }) {
  const { meta, site } = props;
  const canonical = `${site.baseUrl}${meta.path === "/" ? "/" : meta.path}`;
  const ogImage = `${site.baseUrl}/og/${meta.og}.png`;
  const scripts = ["js/site.js", ...(props.scripts ?? [])].filter(hasAsset);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{meta.title}</title>
        <meta name="description" content={meta.description} />
        <link rel="canonical" href={canonical} />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#f7f6f2" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0e1113" media="(prefers-color-scheme: dark)" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Glasstrack" />
        <meta property="og:title" content={meta.title} />
        <meta property="og:description" content={meta.description} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={meta.title} />
        <meta name="twitter:description" content={meta.description} />
        <meta name="twitter:image" content={ogImage} />
        <link rel="preload" href={assetUrl("fonts/ibm-plex-mono-500.woff2")} as="font" type="font/woff2" crossorigin="anonymous" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <style dangerouslySetInnerHTML={{ __html: style() }} />
        {scripts.map((s) => (
          <script src={assetUrl(s)} defer />
        ))}
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class="top">
          <div class="wrap">
            <a class="brand" href="/" aria-label="Glasstrack home">
              <Mark />
              <span>Glasstrack</span>
            </a>
            <nav class="nav" aria-label="Main">
              {NAV.map(([href, label]) => (
                <a href={href} aria-current={meta.path === href ? "page" : undefined}>
                  {label}
                </a>
              ))}
            </nav>
            <div class="top-actions">
              <button type="button" class="btn btn-sm icon-btn" data-theme-toggle hidden aria-label="Theme: system">
                <ThemeIcon />
              </button>
              {site.signedIn ? (
                <a class="btn btn-sm btn-primary" href="/app">
                  Open app
                </a>
              ) : (
                <>
                  <a class="btn btn-sm" href="/login">
                    Sign in
                  </a>
                  <a class="btn btn-sm btn-primary hide-xs" href="/login?signup=1">
                    Start free
                  </a>
                </>
              )}
            </div>
          </div>
        </header>
        <main id="main" tabindex={-1}>
          {props.children}
        </main>
        <Footer />
      </body>
    </html>
  );
}

const FOOT: [string, string][] = [
  [GITHUB_URL, "GitHub"],
  ["/finances", "Finances"],
  ["/pricing", "Pricing"],
  ["/self-host", "Self-host"],
  ["/how-its-run", "How it's run"],
  ["/about", "About"],
  ["/terms", "Terms"],
  ["/privacy", "Privacy"],
  ["/dpa", "DPA"],
  ["/status", "Status"],
  ["/contact", "Contact"],
];

function Footer() {
  return (
    <footer class="foot">
      <div class="wrap">
        <nav aria-label="Footer">
          <ul>
            {FOOT.map(([href, label]) => (
              <li>
                <a href={href}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <p>Glasstrack is open source under the MIT licence.</p>
        <p>
          Operated by {OPERATOR.name}, {OPERATOR.place}. <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>
        </p>
      </div>
    </footer>
  );
}

/** A value the owner still has to fill in. Rendered visibly so it can't be missed. */
export const Placeholder = (p: { name: string }) => <span class="placeholder">[{p.name}]</span>;

/** "Example" badge plus the explanation, shown wherever example figures appear. */
export function ExampleNote(p: { example: boolean }) {
  if (!p.example) return null;
  return (
    <p class="example-note">
      <span class="example">Example</span> These are example figures. Real figures appear here once costs are recorded.
    </p>
  );
}

export const ExampleBadge = (p: { example: boolean }) => (p.example ? <span class="example">Example</span> : null);

/** Server-rendered HTML document string. */
export async function renderPage(el: unknown): Promise<string> {
  return `<!doctype html>${await Promise.resolve(String(await el))}`;
}
