/**
 * All CSS for the console, inline and dependency-free by design (see the note at the top of
 * server.ts). Colors are CSS variables so the dark palette is a single overridden block rather
 * than a parallel set of rules that can drift out of sync with the light one.
 *
 * Contrast was chosen by eye against both a white and a near-black ground, not just tuned for
 * light mode and left to chance in dark -- `color-scheme: light dark` means either can render with
 * no user action, so both have to hold up on their own.
 *
 * Type: prose is set in the reading face, machine data in the mono face, and the two never swap.
 * The whole console used to be monospace, which made a page of ordinary English sentences read as
 * a wall of code -- uniform letterforms give the eye no word shapes to land on. Monospace is now
 * reserved for the things that earn it: ids, hashes, amounts, SKUs, constraint type names, raw
 * JSON. Everything a person reads as a sentence is proportional.
 */
export const STYLE = `
  :root {
    color-scheme: light dark;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --fg: #16181d;
    --bg: #ffffff;
    --muted: rgba(22,24,29,.62);
    /* .58, not .42: this is the color the "1080p, paused, watched at a distance" test failed on.
       Event counts and hashes need to survive that even though they are the least important text
       on the page. */
    --faint: rgba(22,24,29,.58);
    --border: rgba(22,24,29,.16);
    --border-strong: rgba(22,24,29,.32);
    --surface: rgba(22,24,29,.045);
    --surface-strong: rgba(22,24,29,.09);
    --ok: #187a3c;
    --bad: #c31432;
    --hold: #a15c07;
    --tint-ok: rgba(24,122,60,.10);
    --tint-bad: rgba(195,20,50,.09);
    --tint-hold: rgba(161,92,7,.11);
    --accent: #2454c7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e8eaed;
      --bg: #101214;
      --muted: rgba(232,234,237,.66);
      --faint: rgba(232,234,237,.54);
      --border: rgba(232,234,237,.18);
      --border-strong: rgba(232,234,237,.34);
      --surface: rgba(232,234,237,.055);
      --surface-strong: rgba(232,234,237,.10);
      --ok: #4fd581;
      --bad: #ff7a86;
      --hold: #ffb454;
      --tint-ok: rgba(79,213,129,.12);
      --tint-bad: rgba(255,122,134,.13);
      --tint-hold: rgba(255,180,84,.13);
      --accent: #6ea1ff;
    }
  }

  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    font: 15.5px/1.65 var(--sans);
    background: var(--bg); color: var(--fg);
    margin: 0; padding: 32px 32px 72px; max-width: 1120px;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  a.plain { color: inherit; text-decoration: none; }
  a.plain:hover { text-decoration: underline; }

  /* Machine data. Anything an id, hash, amount or type name lands in. */
  .mono, .hash, .chip, pre, code, .pill-origin, .sim-badge, td.num { font-family: var(--mono); }
  /* Mono runs about 15% wider than the reading face at the same size, so it is stepped down to
     keep a type name like checkout.allowed_merchants on one line in its column. */
  td.mono, td.num { font-size: 13.5px; }

  /* Prose is capped near 78 characters. The page is wider than that so tables can breathe, but a
     paragraph running the full width is measurably harder to track back from at a distance. */
  .sub, .notice p, .instruction, .step-note, .measure { max-width: 78ch; }

  /* overflow-wrap: anywhere is a backstop only -- ids are broken deliberately at underscores
     via <wbr> wherever they're rendered, so this should rarely be what actually fires. */
  h1 { font-family: var(--mono); font-size: 22px; margin: 0 0 6px; letter-spacing: -.01em;
       overflow-wrap: anywhere; }
  /* Sentence case, not uppercase. Six shouted headings down one page read as six alarms. */
  h2 { font-size: 15px; margin: 42px 0 12px; letter-spacing: 0; color: var(--fg);
       font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 7px; }
  h3 { font-size: 13px; margin: 0; letter-spacing: 0; color: var(--muted); font-weight: 700; }

  .sub { color: var(--muted); margin: 0 0 20px; }
  .faint { color: var(--faint); }
  .empty { color: var(--faint); padding: 24px 0; }
  .stat-strip { display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: baseline; margin: 0 0 26px;
                font-size: 14px; }
  .stat-strip .hash { font-size: 12.5px; }

  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  td, th { text-align: left; padding: 9px 14px 9px 0; vertical-align: top;
           border-bottom: 1px solid var(--border); overflow-wrap: break-word; }
  th { font-weight: 600; color: var(--faint); font-size: 12.5px; letter-spacing: 0; }
  pre { white-space: pre-wrap; overflow-wrap: break-word; margin: 0; font-size: 12.5px; line-height: 1.55; }
  code { font-size: .92em; }
  .hash { color: var(--faint); font-size: 12.5px; }
  td.num { white-space: nowrap; }

  /* ---- decision / status pills, used on the index table and the transaction verdict ---- */
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-weight: 700;
          font-size: 11px; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
  .pill-allow, .pill-satisfied { background: var(--tint-ok); color: var(--ok); }
  .pill-deny, .pill-violated   { background: var(--tint-bad); color: var(--bad); }
  .pill-hold, .pill-unevaluated, .pill-running { background: var(--tint-hold); color: var(--hold); }
  .pill-origin { background: var(--surface); color: var(--muted); font-weight: 600;
                 text-transform: none; letter-spacing: 0; font-size: 11.5px; }
  .pill-origin.ext { color: var(--accent); border: 1px solid var(--accent); background: transparent; }

  .ok { color: var(--ok); font-weight: 700; }
  .bad { color: var(--bad); font-weight: 700; }
  .hold { color: var(--hold); font-weight: 700; }

  /* ---- the headline of a transaction page: what was asked, and the ruling on it ---- */
  .instruction { font-size: 21px; line-height: 1.45; font-weight: 600; margin: 22px 0 6px;
                 letter-spacing: -.005em; }
  .goal { font-size: 13.5px; color: var(--muted); margin: 0 0 20px; }
  .goal span { color: var(--faint); }

  .verdict { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
             margin: 0 0 24px; padding: 16px 20px; border-radius: 8px; background: var(--surface);
             border: 1px solid var(--border); }
  .verdict-badge { font-size: 22px; font-weight: 800; letter-spacing: .02em; padding: 4px 4px; }
  .verdict-meta { color: var(--muted); font-size: 13.5px; line-height: 1.5; }
  .verdict-meta strong { color: var(--fg); font-weight: 600; }

  /* ---- honesty labels: restyled freely, never shrunk or hidden ---- */
  .sim-badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .05em;
               text-transform: uppercase; padding: 3px 9px; margin-left: 2px;
               border: 1.5px solid var(--hold); color: var(--hold); border-radius: 4px;
               white-space: nowrap; }
  .notice { border: 1px solid var(--border-strong); border-left: 4px solid var(--hold);
            background: var(--tint-hold); padding: 14px 18px; margin: 16px 0; border-radius: 0 6px 6px 0; }
  .notice strong { color: var(--fg); }
  .notice.danger { border-left-color: var(--bad); background: var(--tint-bad); }
  .notice p { margin: 7px 0 0; font-size: 14.5px; }
  .notice p:first-child { margin-top: 0; }

  tr.violated td { background: var(--tint-bad); }
  tr.held td { background: var(--tint-hold); }
  td.st { white-space: nowrap; font-weight: 600; }
  td.origin { white-space: nowrap; }

  /* ---- the pipeline step indicator ---- */
  .steps { display: flex; margin: 20px 0 24px; border: 1px solid var(--border); border-radius: 8px;
           overflow: hidden; }
  .step { flex: 1 1 0; padding: 11px 4px; text-align: center; font-size: 12px;
          letter-spacing: .01em; font-weight: 600;
          color: var(--faint); background: var(--surface); border-right: 1px solid var(--border);
          position: relative; }
  .step:last-child { border-right: none; }
  .step .n { display: block; font-size: 10px; font-weight: 700; opacity: .6; margin-bottom: 3px;
             font-family: var(--mono); }
  .step.done { color: var(--ok); background: var(--tint-ok); }
  .step.active { color: var(--hold); background: var(--tint-hold); animation: pulse 1.6s ease-in-out infinite; }
  .step.skipped { color: var(--faint); background: var(--surface); text-decoration: line-through;
                  text-decoration-color: var(--border-strong); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
  .step-note { font-size: 13px; color: var(--muted); margin: -14px 0 24px; }

  form { margin: 0 0 8px; }
  textarea, input[type=text], input[type=number], select {
    font: inherit; font-size: 14.5px; padding: 9px 11px; width: 100%; box-sizing: border-box;
    border: 1px solid var(--border-strong); border-radius: 5px; background: transparent;
    color: inherit; }
  button { font: inherit; font-size: 14.5px; font-weight: 600; padding: 10px 20px; cursor: pointer;
           border: 1px solid var(--border-strong); border-radius: 5px;
           background: var(--surface-strong); color: inherit; }
  button:hover { background: var(--surface); filter: brightness(1.08); }
  label { display: block; font-size: 13px; letter-spacing: 0;
          color: var(--muted); margin: 16px 0 6px; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; }
  .row > * { flex: 1 1 220px; }
  .banner { border-left: 4px solid var(--border-strong); padding: 14px 18px; margin: 16px 0;
            background: var(--surface); border-radius: 0 6px 6px 0; }
  .banner.running { border-left-color: var(--hold); background: var(--tint-hold); }
  .banner.error { border-left-color: var(--bad); background: var(--tint-bad); }

  /* ---- events table: a friendly summary per row, raw JSON tucked behind <details> ---- */
  .ev-type { font-family: var(--mono); font-size: 13px; font-weight: 600; }
  .ev-summary { line-height: 1.55; }
  .ev-summary .row-line { margin: 0 0 4px; }
  .ev-summary .row-line:last-child { margin-bottom: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
  .chip { display: inline-block; padding: 1px 7px; border: 1px solid var(--border);
          border-radius: 4px; font-size: 12px; color: var(--muted); background: var(--surface); }
  details.raw { margin-top: 7px; }
  details.raw > summary { cursor: pointer; font-size: 12px; color: var(--faint); letter-spacing: 0; }
  details.raw > summary:hover { color: var(--muted); }
  details.raw pre { margin-top: 6px; border-left: 3px solid var(--border); padding-left: 12px;
                     color: var(--muted); }

  /* ---- evidence pack: sectioned instead of one undifferentiated block ---- */
  .pack { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin: 0 0 8px; }
  .pack-section { padding: 16px 20px; border-top: 1px solid var(--border); }
  .pack-section:first-child { border-top: none; }
  .pack-section h3 { margin-bottom: 8px; }
  .pack-line-notice { display: block; font-weight: 600; }

  details.evidence-raw { margin: 10px 0 0; }
  details.evidence-raw > summary { cursor: pointer; color: var(--faint); font-size: 13px;
                                    letter-spacing: 0; }
  details.evidence-raw pre { margin-top: 8px; border-left: 3px solid var(--border); padding-left: 12px;
                              color: var(--muted); }
`;
