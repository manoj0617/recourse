/**
 * The two primitives every view builds on: escaping, and the page shell.
 *
 * `escapeHtml` runs on every interpolation that carries untrusted text -- item descriptions and
 * model output reach these pages as untrusted text, and there is no templating layer here to do it
 * automatically. See the note in server.ts.
 */
import { STYLE } from './style.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function page(title: string, body: string, refreshSeconds?: number): string {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}
