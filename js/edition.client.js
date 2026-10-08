// Client edition of js/edition.js: `node scripts/build.mjs --client` ships
// this file as js/edition.js. No dataset vintages, internal tooling or
// diagnostics; errors the user can fix are shown, everything else is generic.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const CLIENT = true;

export const FOOTER = 'Model year 2027, 15-minute intervals. Rates from the Con Edison P.S.C. No. 10 tariff and the statements in force. Estimates are illustrative: actual bills depend on the rates in effect and on metered usage.';

// ---------------------------------------------------------------- diagnostics
export const logError = () => {};
export const logWarn = () => {};
export const loadFailedHtml = () => '<p class="bad">The rate data could not be loaded. Check your connection and reload the page.</p>';
export const errorHtml = () => '<p class="bad">This step could not be displayed. Reload the page and try again.</p>';
export const railErrorHtml = () => '';
export const runFailedHtml = (e) => `<p class="bad">${e.user ? esc(e.message) : 'The simulation could not be completed. Check the inputs and try again.'}</p>`;
export const SOLVING = 'Optimising the battery dispatch over the full year. This takes 5 to 20 seconds.';
export const solvedIn = () => '';

// ---------------------------------------------------------------- provenance (HTML)
export const rateProvenance = () => '';
export const rateProvenanceClause = () => '';
export const UNLISTED_STATEMENTS = 'Other statements (CES delivery surcharge, DLM surcharge, EV make-ready, arrears recovery) are not included: add them to the per-kWh figure if you want them.';
export const MSC_BLURB = 'Observed billed Market Supply Charge (12 months to Aug 2026) plus the MSC capacity charge on the monthly maximum.';
export const PRESET_NOTE = 'Synthetic profiles: evening-peaking residential redistribution load with a temperature-driven cooling (and, for the heat-pump case, heating) component.';

// ---------------------------------------------------------------- engine text (plain; the UI escapes it)
export const mscProvenance = () => '';
export const lbmpSource = (lbmp) => lbmp.source_span.map((x) => x.slice(0, 10)).join(' to ');
export const aggregatorNote = (id, pledge, minKw) => `${id}: the ${pledge} kW pledge counts toward an Aggregator's ${minKw} kW minimum per network.`;
export const PLEDGE_MISSING = 'Enter the pledged load relief (kW) to size the program payments.';
