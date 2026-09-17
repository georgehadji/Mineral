import { ASSUMPTION_BANDS } from './decision.ts';
import { RecipeSchema, type Recipe } from './recipe.ts';
import {
  FACILITY_STATUSES,
  SUPPLY_CHAIN_STAGES,
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
    return { claims: [], assumptions: [], facilities: [] };
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

/**
 * Required by valuation_assumptions in the registry, and genuinely upstream of
 * it: a discount rate that ignores how the company is funded is a number picked
 * out of the air.
 */
const capitalStructure: ModuleImpl = {
  code: 'capital_structure',
  prompt: {
    version: '1.0.0',
    system:
      'You describe how a company is funded: debt, equity, maturities, covenants, dilution, and ' +
      'what its cost of capital is driven by.\n\n' +
      CITATION_RULES,
  },
  run(context, ask) {
    return askFor(
      'capital_structure',
      ask,
      'synthesis',
      capitalStructure.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'How is this company funded? Cover debt outstanding and its terms, cash, equity issuance ' +
        'or dilution, and anything that would move its cost of capital. Five claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Figures:\n${renderFacts(context)}\n\nEvidence:\n${renderChunks(context)}`,
    );
  },
};

/** The codes policy will accept, rendered from the bands themselves so the
 *  prompt cannot drift away from what the gate enforces. */
const ASSUMPTION_MENU = Object.entries(ASSUMPTION_BANDS)
  .map(([code, band]) => `- ${code} (${band.unit}), between ${band.min} and ${band.max}`)
  .join('\n');

/**
 * Report I.22: the model proposes the inputs, it does not value the company.
 * Every number it returns here is a `proposed` assumption that deterministic
 * policy accepts or refuses before any engine sees it.
 */
const valuationAssumptions: ModuleImpl = {
  code: 'valuation_assumptions',
  prompt: {
    version: '1.0.0',
    system:
      'You propose the inputs a discounted cash flow model for this company should use. You do ' +
      'not value the company and you do not compute anything: a deterministic engine does that ' +
      'from the inputs you propose, after a policy check accepts them.\n\n' +
      CITATION_RULES +
      '\nEvery assumption names the claim_key of one of your own claims in this output, gives a ' +
      'plausible range around the value, and says why. An assumption you cannot justify from the ' +
      'evidence is one you should not propose.',
  },
  run(context, ask) {
    return askFor(
      'valuation_assumptions',
      ask,
      'synthesis',
      valuationAssumptions.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'Propose these inputs, all of them, and one claim per input stating what in the evidence ' +
        `drives it:\n${ASSUMPTION_MENU}\n\n` +
        'Terminal growth must stay below the discount rate. Propose nothing outside this list.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Figures:\n${renderFacts(context)}\n\nEvidence:\n${renderChunks(context)}`,
    );
  },
};

/**
 * The modules report J.11 calls breadth. Each one is a prompt and a shape, like
 * the first six: the runtime does the citing, the validating and the writing,
 * so a new module is a new question rather than new machinery.
 *
 * The registry already declared them and their dependencies; what was missing
 * was the question each one asks. The deep recipe turns them on and the core
 * recipe is left alone, because core is the cheap path the web trigger takes
 * and fifteen model calls is not cheap.
 */

const industryPosition: ModuleImpl = {
  code: 'industry_position',
  prompt: {
    version: '1.0.0',
    system:
      'You place a company within its industry: what the industry is, how it is structured, and ' +
      'where in it this company sits.\n\n' +
      CITATION_RULES,
  },
  run(context, ask) {
    return askFor(
      'industry_position',
      ask,
      'extraction',
      industryPosition.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'What industry does this company operate in, how is that industry structured, and what ' +
        'position does the company hold in it? Give scale, share and standing only where the ' +
        'evidence states them. Five claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

/**
 * The module behind the supply-chain page. It asks for a stage from the named
 * list because a stage the ontology does not know is a sentence rather than a
 * position in a chain.
 */
const supplyChainPosition: ModuleImpl = {
  code: 'supply_chain_position',
  prompt: {
    // 1.1.0 adds the facilities array. The claims it asks for are unchanged.
    version: '1.1.0',
    system:
      'You locate a company in a physical supply chain: which stages it occupies, what it takes ' +
      'in, what it puts out, and who it depends on either side.\n\n' +
      CITATION_RULES +
      `\nName a stage using one of: ${SUPPLY_CHAIN_STAGES.join(', ')}. A company that plainly ` +
      'occupies none of them gets an UNKNOWN claim rather than an invented stage.\n\n' +
      'Where the evidence names a site -- a mine, a plant, a refinery -- also return it in ' +
      '`facilities`, one entry per site per stage, so the same site appears twice when the ' +
      'evidence says it both mines and separates. `name` is the site as the filing names it, not ' +
      'a description of it. `source_claim_key` must be the claim_key of a claim in this same ' +
      `answer. \`status\` is one of: ${FACILITY_STATUSES.join(', ')}, and is "unknown" unless the ` +
      'evidence says which. Leave `material_code` and `country_code` null rather than inferring ' +
      'them. A site you cannot tie to one stage does not belong in `facilities`; say it in a ' +
      'claim instead.',
  },
  run(context, ask) {
    return askFor(
      'supply_chain_position',
      ask,
      'synthesis',
      supplyChainPosition.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'Which stages of its supply chain does this company occupy, what does each stage consume ' +
        'and produce, and where is it dependent on someone else? Name the stage in every ' +
        'statement. Six claims at most, plus the sites behind them in `facilities`.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

const projectPipeline: ModuleImpl = {
  code: 'project_pipeline',
  prompt: {
    version: '1.0.0',
    system:
      'You record what a company is building: projects, facilities, expansions, their stage and ' +
      'their stated timing.\n\n' +
      CITATION_RULES +
      '\nA date the filing does not give is UNKNOWN. Do not turn "in the second half" into a ' +
      'month, and do not read a target as a commitment.',
  },
  run(context, ask) {
    return askFor(
      'project_pipeline',
      ask,
      'extraction',
      projectPipeline.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'What is this company building or commissioning? For each project or facility give its ' +
        'name, what it will produce, its stage, and the timing the filing states. Six claims at ' +
        'most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

const management: ModuleImpl = {
  code: 'management',
  prompt: {
    version: '1.0.0',
    system:
      'You assess management and governance from the record: who runs the company, what they ' +
      'said they would do, and what the filings show they did.\n\n' +
      CITATION_RULES +
      '\nJudge the record, not the person. An opinion about character that the filings do not ' +
      'support is not a claim you may make here.',
  },
  run(context, ask) {
    return askFor(
      'management',
      ask,
      'synthesis',
      management.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'Who leads this company, how are they incentivised, what have they promised, and what ' +
        'has been delivered against it? Governance arrangements that would matter to an outside ' +
        'shareholder count. Five claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

const competitiveLandscape: ModuleImpl = {
  code: 'competitive_landscape',
  prompt: {
    version: '1.0.0',
    system:
      'You identify who a company competes with and on what, from filings alone.\n\n' +
      CITATION_RULES +
      '\nName a competitor only where the evidence names it. "Chinese producers" is what the ' +
      'filing says and is a legitimate claim; inventing a company to make it concrete is not.',
  },
  run(context, ask) {
    return askFor(
      'competitive_landscape',
      ask,
      'synthesis',
      competitiveLandscape.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'Who competes with this company, on what basis, and what protects or exposes it? Cover ' +
        'barriers to entry and substitution where the evidence speaks to them. Six claims at ' +
        'most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

const risksModule: ModuleImpl = {
  code: 'risks',
  prompt: {
    version: '1.0.0',
    system:
      'You state what could go wrong for this company, and how you would know it was ' +
      'happening.\n\n' +
      CITATION_RULES +
      '\nA risk the filings disclose is evidenced. A risk you reason to from evidenced facts is ' +
      'INFERRED and must say so. Do not rank risks by a probability the evidence does not give.',
  },
  run(context, ask) {
    return askFor(
      'risks',
      ask,
      'synthesis',
      risksModule.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'What are the material risks to this company, and what observable event would show each ' +
        'one materialising? Operational, financial, market, regulatory and geopolitical all ' +
        'count. Seven claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

const catalysts: ModuleImpl = {
  code: 'catalysts',
  prompt: {
    version: '1.0.0',
    system:
      'You identify dated, checkable events that would change what this company is worth.\n\n' +
      CITATION_RULES +
      '\nA catalyst is an event, not a hope: it has something that happens and a time the ' +
      'evidence states. Where the timing is not stated, give the event and mark the timing ' +
      'UNKNOWN rather than guessing a quarter.',
  },
  run(context, ask) {
    return askFor(
      'catalysts',
      ask,
      'synthesis',
      catalysts.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'What events ahead would change this company materially, when does the evidence say each ' +
        'falls, and which direction would it move the case? Six claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

/**
 * The module report J.11 names by itself. It runs last in the DAG and argues
 * against everything before it, including the numbers the valuation module has
 * just proposed: those are what the valuation is made of, and disputing an
 * input is worth more than disputing the total.
 *
 * It is a module like any other, so the same rules bind it. A bear case that
 * cannot cite is a bear case nobody has to answer.
 */
const bearCase: ModuleImpl = {
  code: 'bear_case',
  prompt: {
    version: '1.0.0',
    system:
      'You argue the case against this company. Everything below was written by modules trying ' +
      'to describe it fairly; your job is to find where that description is weakest and say so ' +
      'in the same evidenced form.\n\n' +
      CITATION_RULES +
      '\nAttack the proposed valuation inputs by name where the evidence lets you: a discount ' +
      'rate, a growth rate or a terminal growth rate that the filings do not support is the ' +
      'strongest bear point available and the most checkable.\n' +
      'Do not manufacture a bear case. Where the evidence genuinely does not support one, say so ' +
      'with an UNKNOWN claim. An argument built on nothing is worse than no argument.',
  },
  run(context, ask) {
    return askFor(
      'bear_case',
      ask,
      'synthesis',
      bearCase.prompt!.system,
      `Subject: ${subjectLine(context)}\n\n` +
        'What is the case against owning this company, and what would have to be true for it to ' +
        'hold? Attack the findings and the proposed valuation inputs below, not a company you ' +
        'imagine. Six claims at most.\n\n' +
        `What earlier modules found:\n${renderUpstream(context)}\n\n` +
        `Evidence:\n${renderChunks(context)}\n\nFigures:\n${renderFacts(context)}`,
    );
  },
};

export const MODULE_IMPLEMENTATIONS: readonly ModuleImpl[] = [
  entityResolution,
  companyProfile,
  businessModel,
  industryPosition,
  commodityExposure,
  supplyChainPosition,
  projectPipeline,
  financialQuality,
  capitalStructure,
  management,
  competitiveLandscape,
  risksModule,
  catalysts,
  valuationAssumptions,
  bearCase,
];

/**
 * The cheap path: what a run needs to reach a valuation, plus what it needs to
 * place the company in the chain.
 *
 * `industry_position` is here because `supply_chain_position` requires it and
 * buildDag refuses a recipe that omits a dependency, not because the core run
 * wanted an industry read of its own. That makes this two model calls dearer
 * per run than the word "cheap" suggests, and the same two dearer for the web
 * trigger and `pnpm research`, which both run this recipe.
 *
 * What it buys is the only thing that fills ontology.facilities.
 * `supply_chain_position` is what proposes a site, and promoteFacilities has
 * nothing to promote without it. Until now that module was in DEEP_RECIPE
 * alone, so the ordinary path could never put a company at a stage.
 */
const CORE_MODULE_CODES = [
  'entity_resolution',
  'company_profile',
  'business_model',
  'industry_position',
  'commodity_exposure',
  'supply_chain_position',
  'financial_quality',
  'capital_structure',
  'valuation_assumptions',
];

/**
 * The phase J.6 recipe, extended in J.8 with the two modules that reach the
 * decision layer. Preconditions stop a run on empty evidence (I.23).
 */
export const CORE_RECIPE: Recipe = RecipeSchema.parse({
  id: 'company-core',
  version: '1.0.0',
  subject: 'company',
  depth: 'quick',
  preconditions: ['evidence_ingested'],
  modules: CORE_MODULE_CODES.map((code) => ({ code, version: '1.0.0' })),
});

/**
 * The recipe `docs/spec/company-deep-research.yaml` describes, as far as it can
 * be a recipe here. The spec lists the deterministic stages -- policy, the
 * calculation, the scenario, the three checks, the synthesis -- as modules, and
 * this repository runs every one of them as a step outside the DAG, because
 * each of them persists and a module may not (I.20, recorded at J.8). What is
 * left is fifteen modules: the fourteen that ask a model a question and return
 * claims, plus the deterministic root they all hang off, which is what a recipe
 * is for.
 *
 * `final_synthesis` stays out for the reason J.8 recorded: it writes thesis
 * rows rather than claims. `bear_case` is in, after the registry change above
 * moved it off `valuation_calc`.
 */
export const DEEP_RECIPE: Recipe = RecipeSchema.parse({
  id: 'company-deep-research',
  version: '1.0.0',
  subject: 'company',
  depth: 'standard',
  preconditions: ['evidence_ingested'],
  modules: MODULE_IMPLEMENTATIONS.map((impl) => ({ code: impl.code, version: '1.0.0' })),
});

export const IMPLEMENTATIONS_BY_CODE: ReadonlyMap<string, ModuleImpl> = new Map(
  MODULE_IMPLEMENTATIONS.map((m) => [m.code, m]),
);
