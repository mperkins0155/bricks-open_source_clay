/**
 * Enrichment recipes — one-click column presets.
 *
 * Each recipe maps a few input columns (auto-detected from CSV headers) to one
 * or more output columns with ready-to-run formulas, built from the user's
 * current AI configuration. This is the "feels like Clay" layer: pick a recipe,
 * confirm the input columns, and get working enrichment columns instantly.
 */

import { generateAIFormulaCode, generateFirecrawlFormulaCode } from '@/lib/generators/formulaGenerators';
import { aiConfigStorage } from '@/lib/storage/aiConfigStorage';
import { STORAGE_KEYS } from '@/lib/constants/aiModels';

export interface RecipeInput {
  id: string;
  label: string;
  /** Lowercase substrings used to auto-match an existing header. */
  match: string[];
  optional?: boolean;
}

export interface RecipeColumnDef {
  name: string;
  /** Build the formula given the resolved input→header map. */
  build: (cols: Record<string, string>) => string;
  /** Shown to the user, e.g. ordering caveats for dependent columns. */
  note?: string;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** Which API key this recipe needs, for a pre-flight hint. */
  needs?: 'openai-or-gemini' | 'firecrawl' | 'none';
  inputs: RecipeInput[];
  columns: RecipeColumnDef[];
}

export interface ResolvedRecipeColumn {
  name: string;
  formula: string;
  note?: string;
}

/** Build an AI-mode formula from a prompt using the saved AI settings. */
const buildAIFormula = (prompt: string): string => {
  const cfg = aiConfigStorage.loadAll();
  const num = (key: string, fallback: number) => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    const n = raw === null ? fallback : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return generateAIFormulaCode({
    prompt,
    message: '',
    model: cfg.model,
    provider: cfg.provider,
    temperature: num(STORAGE_KEYS.AI_TEMPERATURE, 0.4),
    maxTokens: num(STORAGE_KEYS.AI_MAX_TOKENS, 512),
    topK: num(STORAGE_KEYS.AI_TOP_K, 40),
    thinkingMode:
      typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEYS.THINKING_MODE) === 'true',
    ollamaBaseUrl: cfg.ollamaBaseUrl,
    customSettings: { hasCustomTemperature: true, hasCustomMaxTokens: true, hasCustomTopK: true },
  });
};

/** Deterministic, no-API email guesser. */
const buildEmailFormula = (cols: Record<string, string>): string => `
const first = (row["${cols.first}"] || "").toLowerCase().replace(/[^a-z]/g, '');
const last = (row["${cols.last}"] || "").toLowerCase().replace(/[^a-z]/g, '');
let domain = (row["${cols.domain}"] || "").toLowerCase().trim();
domain = domain.replace(/^https?:\\/\\//, '').replace(/^www\\./, '').split('/')[0];
if (domain.includes('@')) domain = domain.split('@').pop();
if (!first || !domain) return '';
return last ? first + '.' + last + '@' + domain : first + '@' + domain;
`;

/** Deterministic company-name guess from an email address. */
const buildCompanyFromEmailFormula = (cols: Record<string, string>): string => `
const at = ((row["${cols.email}"] || "").split('@')[1] || "").trim().toLowerCase().split('/')[0];
if (!at) return '';
const free = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com','proton.me','protonmail.com','live.com','msn.com'];
if (free.includes(at)) return '';
const core = at.split('.').slice(0, -1).join(' ').replace(/[-_]/g, ' ').trim();
return core.replace(/\\b\\w/g, (c) => c.toUpperCase());
`;

export const RECIPES: Recipe[] = [
  {
    id: 'lead-score',
    name: 'Lead Score',
    description:
      'Score each prospect 0–100 on fit and seniority, with a one-line rationale. Pure AI — no scraping.',
    needs: 'openai-or-gemini',
    inputs: [
      { id: 'title', label: 'Job Title', match: ['title', 'role', 'position', 'job'] },
      { id: 'company', label: 'Company', match: ['company', 'organization', 'organisation', 'account', 'employer'] },
    ],
    columns: [
      {
        name: 'Lead Score',
        build: (c) =>
          buildAIFormula(
            `You are a B2B lead-scoring engine. Given the prospect's job title "{${c.title}}" at company "{${c.company}}", respond with ONLY an integer from 0 to 100 representing fit, seniority and likely buying power. Output the number only — no words, no symbols.`,
          ),
      },
      {
        name: 'Score Reason',
        build: (c) =>
          buildAIFormula(
            `In one concise sentence (max 20 words), explain the sales-readiness of a "{${c.title}}" at "{${c.company}}" for a B2B SaaS seller. No preamble.`,
          ),
      },
    ],
  },
  {
    id: 'icebreaker',
    name: 'Personalized Icebreaker',
    description: 'Generate a specific, one-line cold-outreach opener for each lead. Pure AI.',
    needs: 'openai-or-gemini',
    inputs: [
      { id: 'name', label: 'Contact Name', match: ['name', 'first', 'contact', 'full name'] },
      { id: 'company', label: 'Company', match: ['company', 'organization', 'account', 'employer'] },
      { id: 'title', label: 'Job Title (optional)', match: ['title', 'role', 'position', 'job'], optional: true },
    ],
    columns: [
      {
        name: 'Icebreaker',
        build: (c) =>
          buildAIFormula(
            `Write a single friendly, specific cold-outreach opener (max 25 words) for {${c.name}}${
              c.title ? `, who works as a {${c.title}}` : ''
            } at {${c.company}}. Output only the opener line — no greeting, no sign-off, no quotes.`,
          ),
      },
    ],
  },
  {
    id: 'email-guess',
    name: 'Likely Work Email',
    description:
      'Guess a probable work email from name + domain using the common first.last@domain pattern. Deterministic, no API needed.',
    needs: 'none',
    inputs: [
      { id: 'first', label: 'First Name', match: ['first', 'first name', 'fname', 'given'] },
      { id: 'last', label: 'Last Name', match: ['last', 'last name', 'lname', 'surname', 'family'] },
      { id: 'domain', label: 'Domain / Website', match: ['domain', 'website', 'url', 'site', 'company domain', 'web'] },
    ],
    columns: [{ name: 'Likely Email', build: buildEmailFormula }],
  },
  {
    id: 'company-insights',
    name: 'Website → Company Insights',
    description:
      'Scrape each company website, then extract industry, size and a plain-English summary of what they do. Needs Firecrawl + AI.',
    needs: 'firecrawl',
    inputs: [{ id: 'website', label: 'Website / URL', match: ['website', 'url', 'domain', 'site', 'web', 'homepage'] }],
    columns: [
      {
        name: 'Site Content',
        note: 'Run this column FIRST (it scrapes the site); then run the columns below.',
        build: (c) => generateFirecrawlFormulaCode(`{${c.website}}`),
      },
      {
        name: 'Industry',
        note: 'Run after "Site Content" is populated.',
        build: () =>
          buildAIFormula(
            `Based on this scraped company website content:\n\n{Site Content}\n\nReply with ONLY the company's primary industry (2–4 words). No other text.`,
          ),
      },
      {
        name: 'Company Size',
        note: 'Run after "Site Content" is populated.',
        build: () =>
          buildAIFormula(
            `Based on this scraped website content:\n\n{Site Content}\n\nEstimate the company size as one of: Solo, 2-10, 11-50, 51-200, 201-1000, 1000+. Reply with ONLY that bucket.`,
          ),
      },
      {
        name: 'What They Do',
        note: 'Run after "Site Content" is populated.',
        build: () =>
          buildAIFormula(
            `Summarize what this company does in one clear sentence (max 25 words), based on:\n\n{Site Content}\n\nOutput only the sentence.`,
          ),
      },
    ],
  },
  {
    id: 'company-from-email',
    name: 'Company from Email',
    description:
      'Extract the email domain and a guessed company name from an email address. Skips free providers (gmail, etc.). Deterministic, no API.',
    needs: 'none',
    inputs: [{ id: 'email', label: 'Email', match: ['email', 'e-mail', 'mail', 'work email'] }],
    columns: [
      {
        name: 'Email Domain',
        build: (c) =>
          `return ((row["${c.email}"] || "").split('@')[1] || "").trim().toLowerCase().split('/')[0];`,
      },
      { name: 'Company (from email)', build: buildCompanyFromEmailFormula },
    ],
  },
  {
    id: 'sentiment',
    name: 'Sentiment Analysis',
    description: 'Classify any text column as Positive, Neutral, or Negative. Pure AI.',
    needs: 'openai-or-gemini',
    inputs: [
      { id: 'text', label: 'Text Column', match: ['review', 'comment', 'feedback', 'message', 'text', 'note', 'description'] },
    ],
    columns: [
      {
        name: 'Sentiment',
        build: (c) =>
          buildAIFormula(
            `Classify the sentiment of the following text as exactly one word — Positive, Neutral, or Negative. Output only that word.\n\nText: "{${c.text}}"`,
          ),
      },
    ],
  },
  {
    id: 'categorize',
    name: 'Auto-Categorize',
    description: 'Assign a short category/tag to any text column (e.g. support tickets, products, leads). Pure AI.',
    needs: 'openai-or-gemini',
    inputs: [
      { id: 'text', label: 'Text Column', match: ['description', 'text', 'title', 'subject', 'name', 'comment', 'product', 'ticket'] },
    ],
    columns: [
      {
        name: 'Category',
        build: (c) =>
          buildAIFormula(
            `Assign a single short category label (1–3 words, Title Case) that best describes the following. Output only the label — no punctuation, no explanation.\n\n"{${c.text}}"`,
          ),
      },
    ],
  },
  {
    id: 'normalize-title',
    name: 'Normalize Job Title',
    description: 'Standardize messy job titles into seniority + function (e.g. "Sr. Director, Marketing"). Pure AI.',
    needs: 'openai-or-gemini',
    inputs: [{ id: 'title', label: 'Job Title', match: ['title', 'role', 'position', 'job'] }],
    columns: [
      {
        name: 'Title (normalized)',
        build: (c) =>
          buildAIFormula(
            `Normalize this job title to the format "<Seniority>, <Function>" using standard terms (e.g. C-Level, VP, Director, Manager, IC; Engineering, Sales, Marketing, Finance, Ops, Product). Output only the normalized title.\n\nTitle: "{${c.title}}"`,
          ),
      },
      {
        name: 'Seniority',
        build: (c) =>
          buildAIFormula(
            `From the job title "{${c.title}}", output ONLY the seniority tier as one of: C-Level, VP, Director, Manager, Senior, Junior, IC, Unknown. One word/phrase only.`,
          ),
      },
    ],
  },
];

/** Auto-match a recipe's inputs to existing CSV headers (best-effort). */
export const autoMapInputs = (recipe: Recipe, headers: string[]): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const input of recipe.inputs) {
    const found = headers.find((h) => {
      const lower = h.toLowerCase().trim();
      return input.match.some((m) => lower === m || lower.includes(m) || m.includes(lower));
    });
    map[input.id] = found ?? '';
  }
  return map;
};

/** Build the concrete output columns for a recipe given the input→header map. */
export const resolveRecipe = (recipe: Recipe, inputMap: Record<string, string>): ResolvedRecipeColumn[] =>
  recipe.columns.map((col) => ({
    name: col.name,
    note: col.note,
    formula: col.build(inputMap),
  }));
