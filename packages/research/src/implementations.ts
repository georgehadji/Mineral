import { RecipeSchema, type Recipe } from './recipe.ts';
import {
  validateOutput,
  type Ask,
  type ModuleImpl,
  type ModuleOutput,
  type ResearchContext,
} from './runtime.ts';

/**
 * The three modules of report J.6, plus the deterministic resolution step they
 * all depend on. Each one is a prompt and a shape; the runtime does the rest.
 *
 * Every prompt says the same three things in its own words: cite by id, quote
 * by copying, answer UNKNOWN rather than filling a gap. Those are the rules
 * that keep the validator from having to reject work later.
 */

const CITATION_RULES = [
  'Cite every claim. Copy chunk_id or fact_version_id exactly as given; never invent one.',
  'A quote must be a span copied character for character out of the chunk you cite. Do not tidy, shorten across gaps, or paraphrase it.',
  'Cite a fact by fact_version_id with no quote. Figures are already verified; quoting them adds nothing.',
  'If the evidence does not answer something, emit the claim with status UNKNOWN and no evidence. That is a real answer here.',
  'Never state a number that is not in the evidence. Arithmetic belongs to the analytics engine, not to you.',
].join('\n');

/** Keeps a prompt bounded without a retrieval index. */
// ponytail: whole-snapshot prompt with a char cap, swap in pgvector retrieval
// when a filing set stops fitting (report defers retrieval until measured need).
const MAX_CHUNK_CHARS = 4000;
const MAX_CHUNKS = 40;

function renderChunks(context: ResearchContext): string {
  if (context.chunks.length === 0) return 'No document text in this snapshot.';
  return context.chunks
    .slice(0, MAX_CHUNKS)
    .map(
      (chunk) =>
        `[chunk_id: ${chunk.chunkId}] ${chunk.documentTitle}` +
        `${chunk.publishedAt ? ` (${chunk.publishedAt})` : ''} tier ${chunk.sourceTier}\n` +
        chunk.text.slice(0, MAX_CHUNK_CHARS),
    )
    .join('\n\n');
}

function renderFacts(context: ResearchContext): string {
  if (context.facts.length === 0) return 'No promoted figures in this snapshot.';
  return context.facts
    .map(
      (fact) =>
        `[fact_version_id: ${fact.factVersionId}] ${fact.label} (${fact.code}) = ${fact.value}` +
        `${fact.unit ? ` ${fact.unit}` : ''}${fact.periodEnd ? ` as of ${fact.periodEnd}` : ''}`,
    )
    .join('\n');
}

function renderUpstream(context: ResearchContext): string {
  const parts: string[] = [];
  for (const [code, claims] of Object.entries(context.upstream)) {
    if (claims.length === 0) continue;
    parts.push(
      `From ${code}:\n` +
        claims.map((claim) => `- (${claim.status}) ${claim.statement}`).join('\n'),
    );
  }
  return parts.length === 0 ? 'No upstream findings.' : parts.join('\n\n');
}

function subjectLine(context: ResearchContext): string {
  const { legalName, commonName, cik } = context.subject;
  return `${legalName}${commonName && commonName !== legalName ? ` (${commonName})` : ''}` +
    `${cik ? `, SEC CIK ${cik}` : ''}, as of ${context.asOfDate}`;
}

async function askFor(
  code: string,
  ask: Ask,
  task: 'extraction' | 'synthesis',
  system: string,
  user: string,
): Promise<ModuleOutput> {
  const output = await ask({ task, system, user });
  return validateOutput(code, output);
}

/**
 * Deterministic. The subject is already resolved by the time a run exists, so
 * this asserts nothing and emits nothing; it is the DAG root that guarantees
 * every downstream module has a resolved company in its context.
 */
const entityResolution: ModuleImpl = {
  code: 'entity_resolution',
  async run(context) {
    if (!context.subject.companyId) {
      throw new Error('entity_resolution: the run has no resolved subject');
    }
    return { claims: [] };
  },
};

const companyProfile: ModuleImpl = {
  code: 'company_profile',
  prompt: {
    version: '1.0.0',
    system:
      'You read company filings and state what the company is, from the filings alone.\n\n' +
      CITATION_RULES,
  },
  run(context, ask) {
    return askFor(
      'company_profile',
      ask,
      'extraction',
      companyProfile.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'Describe what this company does: its operations, what it produces or sells, where it ' +
        'operates, and its position in its own words. One claim per distinct finding, six at most.\n\n' +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

/**
 * Not one of the three modules phase J.6 names, but the registry makes it a
 * dependency of commodity_exposure, and the registry is the single source of
 * DAG truth (report I.18). Satisfying the dependency is cheaper and more
 * honest than editing it away.
 */
const businessModel: ModuleImpl = {
  code: 'business_model',
  prompt: {
    version: '1.0.0',
    system:
      'You describe how a company actually earns money: what it sells, to whom, on what terms, ' +
      'and what the revenue depends on.\n\n' +
      CITATION_RULES,
  },
  run(context, ask) {
    return askFor(
      'business_model',
      ask,
      'extraction',
      businessModel.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'How does this company earn revenue? Cover the products or services sold, the customers, ' +
        'contract or pricing structure, and any concentration. Five claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

const commodityExposure: ModuleImpl = {
  code: 'commodity_exposure',
  prompt: {
    version: '1.0.0',
    system:
      'You identify which commodities a company is economically exposed to, and how, from ' +
      'filings alone.\n\n' +
      CITATION_RULES,
  },
  run(context, ask) {
    return askFor(
      'commodity_exposure',
      ask,
      'extraction',
      commodityExposure.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'Which commodities does this company produce, consume, or price against, and what is the ' +
        'direction of the exposure? Name the commodity in each statement. Six claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

const financialQuality: ModuleImpl = {
  code: 'financial_quality',
  prompt: {
    version: '1.0.0',
    system:
      'You judge the quality of a company\'s reported financials: durability of revenue, margin ' +
      'behaviour, cash conversion, balance-sheet strength.\n\n' +
      CITATION_RULES +
      '\nPrefer the figures list over prose whenever both say the same thing: a figure is a ' +
      'verified value, prose about it is a description of one.',
  },
  run(context, ask) {
    return askFor(
      'financial_quality',
      ask,
      'synthesis',
      financialQuality.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'Assess financial quality against the figures below. Where a figure is missing, say so ' +
        'with an UNKNOWN claim rather than estimating it. Six claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Figures:\n${renderFacts(context)}\n\nEvidence:\n${renderChunks(context)}`,
    );
  },
};

export const MODULE_IMPLEMENTATIONS: readonly ModuleImpl[] = [
  entityResolution,
  companyProfile,
  businessModel,
  financialQuality,
  commodityExposure,
];

/**
 * The phase J.6 recipe: the three named modules, plus the two the registry
 * requires to reach them. Preconditions stop a run on empty evidence (I.23).
 */
export const CORE_RECIPE: Recipe = RecipeSchema.parse({
  id: 'company-core',
  version: '1.0.0',
  subject: 'company',
  depth: 'quick',
  preconditions: ['evidence_ingested'],
  modules: MODULE_IMPLEMENTATIONS.map((impl) => ({ code: impl.code, version: '1.0.0' })),
});

export const IMPLEMENTATIONS_BY_CODE: ReadonlyMap<string, ModuleImpl> = new Map(
  MODULE_IMPLEMENTATIONS.map((m) => [m.code, m]),
);
