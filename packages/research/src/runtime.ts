import { z } from 'zod';
import type { ModelTask } from '@mineral/ai';
import type { UUID } from '@mineral/domain';

/**
 * The module runtime (report F). A module receives a context and returns
 * claims; it never touches the database and never decides its own epistemic
 * status beyond the ceiling the report allows an author to assert.
 *
 * Everything here is pure. The persistence half -- freezing the snapshot,
 * writing module runs, checking that a quote really appears in the chunk it
 * cites -- lives in packages/db, because those checks need the stored bytes.
 */

/** A chunk as handed to a module: the text plus what is needed to cite it. */
export interface ContextChunk {
  chunkId: UUID;
  documentVersionId: UUID;
  documentTitle: string;
  publishedAt: string | null;
  sourceTier: number;
  text: string;
}

/** A promoted fact. Already VERIFIED or CALCULATED, so citing one is enough. */
export interface ContextFact {
  factVersionId: UUID;
  code: string;
  label: string;
  value: string;
  unit: string | null;
  periodEnd: string | null;
}

/** An upstream claim, carried with its status (report F.2). */
export interface ContextClaim {
  claimKey: string;
  statement: string;
  status: string;
}

export interface ResearchContext {
  subject: {
    companyId: UUID;
    legalName: string;
    commonName: string | null;
    cik: string | null;
  };
  asOfDate: string;
  chunks: ContextChunk[];
  facts: ContextFact[];
  /** Keyed by module code. Only declared dependencies appear here. */
  upstream: Record<string, ContextClaim[]>;
}

/**
 * Statuses a module may assert. VERIFIED and CALCULATED are absent on purpose:
 * the validator assigns the first and the analytics engine the second
 * (report G). A module that could name them would eventually name them wrongly.
 */
export const ASSERTABLE_STATUSES = ['DERIVED', 'INFERRED', 'HYPOTHESIS', 'UNKNOWN'] as const;

export const EvidenceRefSchema = z.object({
  chunk_id: z
    .string()
    .nullable()
    .default(null)
    .describe('handle of the chunk this comes from: the number shown in [chunk N], on its own'),
  fact_version_id: z
    .string()
    .nullable()
    .default(null)
    .describe('handle of the figure this comes from: the number shown in [figure N], on its own'),
  quote: z
    .string()
    .nullable()
    .default(null)
    .describe('verbatim span from the cited chunk, copied character for character, not paraphrased'),
  role: z.enum(['supports', 'contradicts', 'context']).default('supports'),
  strength: z.number().min(0).max(1).default(0.8),
});

export const ClaimSchema = z.object({
  claim_key: z
    .string()
    .min(1)
    .describe('stable snake_case identity for this claim across runs, e.g. revenue_concentration'),
  claim_type: z.string().min(1).describe('short category, e.g. business_fact, risk, metric'),
  statement: z.string().min(1).describe('one sentence, specific, no hedging'),
  status: z.enum(ASSERTABLE_STATUSES).describe('UNKNOWN when the evidence does not answer it'),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceRefSchema),
});

/**
 * The nine stages, as codes. Seeded by 002-supply-chain-ontology.sql and
 * repeated here because a module has to be told the vocabulary it may use;
 * `supply_chain_position` builds its prompt from this list rather than from a
 * second copy written out by hand.
 */
export const SUPPLY_CHAIN_STAGES = [
  'mining',
  'concentration',
  'separation',
  'refining',
  'metal',
  'alloy',
  'magnet',
  'motor',
  'recycling',
] as const;

/** ontology.facilities.status, which is the plant's condition, not a verdict. */
export const FACILITY_STATUSES = [
  'planned',
  'construction',
  'commissioning',
  'operating',
  'care_and_maintenance',
  'closed',
  'unknown',
] as const;

/**
 * A site a module proposes, so that a company can be placed at a stage.
 *
 * Same shape of bargain as an assumption: a model may propose, only a rule may
 * accept. A claim naming a stage in prose cannot be promoted, because "takes
 * NdPr oxide from separation into metal" names two stages and a parser would
 * have to guess which one the company occupies. This asks for the answer as
 * data and keeps the prose claim as the thing the evidence hangs off.
 */
export const FacilityProposalSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('the site as the filing names it, e.g. Mountain Pass; not a description'),
  stage_code: z.enum(SUPPLY_CHAIN_STAGES).describe('the one stage this site occupies'),
  material_code: z
    .string()
    .nullable()
    .default(null)
    .describe('code of the material it puts out, or null when the filing does not say'),
  country_code: z
    .string()
    .length(2)
    .nullable()
    .default(null)
    .describe('ISO 3166-1 alpha-2, or null when the filing does not say'),
  status: z.enum(FACILITY_STATUSES).default('unknown').describe('unknown unless the filing says'),
  source_claim_key: z
    .string()
    .min(1)
    .describe('claim_key of a finding in this run that says this site is at this stage'),
});

/**
 * An assumption a module proposes. Report G allows exactly this much: a value
 * with a range, a rationale and the claim it rests on, at status `proposed`. It
 * does not allow a module to approve one. Approval is deterministic policy and
 * lives in decision.ts, outside every module.
 */
export const AssumptionProposalSchema = z.object({
  code: z.string().min(1).describe('snake_case input code, one of the codes the question lists'),
  name: z.string().min(1).describe('short human label'),
  value: z.number().describe('the single number to use'),
  unit: z.string().nullable().default(null),
  min_value: z.number().nullable().default(null).describe('low end of the plausible range'),
  max_value: z.number().nullable().default(null).describe('high end of the plausible range'),
  rationale: z.string().min(1).describe('why this value, in terms of the evidence'),
  source_claim_key: z
    .string()
    .min(1)
    .describe('claim_key of a finding in this run that supports the value'),
});

export const ModuleOutputSchema = z.object({
  claims: z.array(ClaimSchema),
  /** Empty for every module that is not proposing valuation inputs. */
  assumptions: z.array(AssumptionProposalSchema).default([]),
  /** Empty for every module that is not placing a company in the chain. */
  facilities: z.array(FacilityProposalSchema).default([]),
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type AssumptionProposal = z.infer<typeof AssumptionProposalSchema>;
export type FacilityProposal = z.infer<typeof FacilityProposalSchema>;
export type ModuleOutput = z.infer<typeof ModuleOutputSchema>;

/** Minimum quote length. A three-word quote matches by accident. */
const MIN_QUOTE_CHARS = 16;

export class ModuleOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleOutputError';
  }
}

/**
 * What is wrong with one claim's citations as written, or null. Shape only:
 * whether the quote is really in the chunk needs the stored bytes and is
 * checked where they are.
 *
 * An uncited claim is the failure this exists to stop: it reads exactly like a
 * cited one once it is in the table. It is a fault of the claim, though, not of
 * the module, so the caller drops the claim and keeps the rest -- a run against
 * USA Rare Earth failed outright because one company_profile claim came back
 * with its evidence missing.
 */
export function citationFault(claim: ModuleOutput['claims'][number]): string | null {
  // An honest non-answer is allowed, and is the point of having UNKNOWN.
  if (claim.status === 'UNKNOWN') return null;
  if (claim.evidence.length === 0) return `is ${claim.status} with no evidence`;

  for (const ref of claim.evidence) {
    const targets = [ref.chunk_id, ref.fact_version_id].filter((t) => t !== null && t !== '');
    if (targets.length !== 1) return 'must cite exactly one of chunk_id or fact_version_id';
    if (ref.chunk_id && (!ref.quote || ref.quote.trim().length < MIN_QUOTE_CHARS)) {
      return 'cites a chunk with no usable quote';
    }
  }
  return null;
}

/**
 * Rules about the output as a whole, which no single claim can be dropped to
 * satisfy. A claim's own citations are judged by citationFault, one claim at a
 * time.
 */
export function validateOutput(code: string, output: ModuleOutput): ModuleOutput {
  const fail = (message: string): never => {
    throw new ModuleOutputError(`${code}: ${message}`);
  };

  const seen = new Set<string>();
  for (const claim of output.claims) {
    if (seen.has(claim.claim_key)) fail(`claim_key ${claim.claim_key} appears twice in one output`);
    seen.add(claim.claim_key);
  }

  // One value per input, or a later reader picks arbitrarily between two. That
  // the source claim resolves is checked where the claims are, not here.
  const codes = new Set<string>();
  for (const assumption of output.assumptions) {
    if (codes.has(assumption.code)) fail(`assumption ${assumption.code} is proposed twice`);
    codes.add(assumption.code);
  }

  // A facility is a claim restated as data, so the claim has to be in this same
  // output. Unlike an assumption's source claim, which may be a finding from an
  // earlier module, a site the module did not itself assert is a site nothing
  // in this run cited.
  const sites = new Set<string>();
  for (const facility of output.facilities) {
    const key = JSON.stringify([facility.name, facility.stage_code]);
    if (sites.has(key)) {
      fail(`facility ${facility.name} is proposed twice at ${facility.stage_code}`);
    }
    sites.add(key);

    if (!seen.has(facility.source_claim_key)) {
      fail(
        `facility ${facility.name} rests on claim ${facility.source_claim_key}, ` +
          'which this output does not contain',
      );
    }
  }
  return output;
}

/**
 * What the orchestrator injects so a module can reach the gateway. A module
 * does not choose its own response shape: every module answers in claims, so
 * the runtime owns the schema and the module owns only the prompt.
 */
export type Ask = (request: {
  task: ModelTask;
  system: string;
  user: string;
}) => Promise<ModuleOutput>;

export interface PromptSpec {
  version: string;
  system: string;
}

export interface ModuleImpl {
  code: string;
  /** Present for modules that call the gateway; registered as a prompt version. */
  prompt?: PromptSpec;
  run(context: ResearchContext, ask: Ask): Promise<ModuleOutput>;
}
