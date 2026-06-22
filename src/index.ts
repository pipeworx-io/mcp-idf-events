interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Île-de-France (Greater Paris) Events MCP.
 *
 * Public events across the entire Île-de-France region — Paris plus its suburbs
 * (Versailles, Saint-Denis, Le Kremlin-Bicêtre, …) — from the region's open-data
 * portal (data.iledefrance.fr, "evenements-publics-cibul" dataset, OpenAgenda
 * schema, Opendatasoft v2.1). Keyless, ~190k events (~1,800 upcoming). Broader
 * than the Paris-city pack; content is in French.
 */


const BASE = 'https://data.iledefrance.fr/api/explore/v2.1/catalog/datasets/evenements-publics-cibul/records';
const UA = 'pipeworx-mcp-idf-events/1.0 (+https://pipeworx.io)';
const MAX_LIMIT = 50;

const tools: McpToolExport['tools'] = [
  {
    name: 'events',
    description:
      'Find upcoming events across the Île-de-France / Greater Paris region (Paris + suburbs). Filter by keyword, city/commune, free admission, and date window. Returns events sorted by start date. Titles/descriptions are in French.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword (full-text), e.g. "concert", "exposition", "théâtre".' },
        city: { type: 'string', description: 'Filter to one commune, e.g. "Paris", "Versailles", "Saint-Denis".' },
        free_only: { type: 'boolean', description: 'If true, best-effort free events (conditions mention "gratuit").' },
        from: { type: 'string', description: 'Include events on/after this date YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'Include events starting on/before this date YYYY-MM-DD.' },
        limit: { type: 'number', description: `Max events (1-${MAX_LIMIT}, default 20).` },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'events') throw new Error(`Unknown tool: ${name}`);

  const from = dateArg(args.from) || todayISO();
  const to = dateArg(args.to);
  const conds: string[] = [`(firstdate_begin >= date'${from}' or lastdate_end >= date'${from}')`];
  if (to) conds.push(`firstdate_begin <= date'${to}'`);
  if (typeof args.city === 'string' && args.city.trim()) conds.push(`location_city = "${args.city.trim().replace(/"/g, '')}"`);
  if (args.free_only === true) conds.push(`search(conditions_fr, "gratuit")`);
  if (typeof args.query === 'string' && args.query.trim()) conds.push(`"${args.query.trim().replace(/"/g, '')}"`);

  const qs = new URLSearchParams();
  qs.set('where', conds.join(' and '));
  qs.set('order_by', 'firstdate_begin');
  qs.set('limit', String(clamp(numArg(args.limit, 20), 1, MAX_LIMIT)));
  qs.set('offset', String(Math.max(0, numArg(args.offset, 0))));

  const res = await fetch(`${BASE}?${qs.toString()}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Île-de-France events: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 160))}`);
  const data = (await res.json()) as { total_count?: number; results?: IdfEvent[] };

  return {
    region: 'Île-de-France (Greater Paris)',
    country: 'France',
    source: 'data.iledefrance.fr',
    date_from: from,
    date_to: to || null,
    total_matching: data.total_count ?? 0,
    count: data.results?.length ?? 0,
    events: (data.results ?? []).map(normalize),
  };
}

interface IdfEvent {
  uid?: string | number;
  title_fr?: string;
  description_fr?: string;
  daterange_fr?: string;
  firstdate_begin?: string;
  lastdate_end?: string;
  keywords_fr?: string[] | string | null;
  conditions_fr?: string | null;
  canonicalurl?: string;
  location_name?: string;
  location_address?: string;
  location_city?: string;
  location_postalcode?: string;
  location_coordinates?: { lat?: number; lon?: number } | null;
  age_min?: number | null;
  age_max?: number | null;
  registration?: unknown;
  image?: string | null;
}

function normalize(e: IdfEvent): Record<string, unknown> {
  const c = e.location_coordinates;
  const free = !!e.conditions_fr && /gratuit/i.test(e.conditions_fr);
  return {
    id: e.uid,
    title: e.title_fr,
    url: e.canonicalurl,
    summary: strip(e.description_fr)?.slice(0, 600) || undefined,
    date_start: e.firstdate_begin || undefined,
    date_end: e.lastdate_end || undefined,
    when: strip(e.daterange_fr ?? undefined) || undefined,
    is_free: free,
    conditions: strip(e.conditions_fr ?? undefined) || undefined,
    venue: e.location_name || e.location_city
      ? {
          name: e.location_name,
          address: [e.location_address, e.location_postalcode, e.location_city].filter((p) => p && String(p).trim()).join(', ') || undefined,
          city: e.location_city,
          latitude: c?.lat,
          longitude: c?.lon,
        }
      : undefined,
    keywords: Array.isArray(e.keywords_fr) ? e.keywords_fr : e.keywords_fr ? [e.keywords_fr] : [],
    age_min: typeof e.age_min === 'number' ? e.age_min : undefined,
    image: e.image || undefined,
  };
}

function strip(html?: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&#39;|&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function dateArg(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function todayISO(): string {
  const d = new Date(Date.now() + 2 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
