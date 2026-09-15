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
    .describe('id of the chunk this comes from, copied exactly from the evidence list'),
  fact_version_id: z
    .string()
    .nullable()
    .default(null)
    .describe('id of the fact this comes from, copied exactly from the figures list'),
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

export const ModuleOutputSchema = z.object({
  claims: z.array(ClaimSchema),
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
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
 * Shape rules the stored bytes are not needed for. Containment -- does the
 * quote actually appear in the chunk -- is checked against the database, not
 * here.
 *
 * An uncited claim is the failure this exists to stop: it reads exactly like a
 * cited one once it is in the table.
 */
export function validateOutput(code: string, output: ModuleOutput): ModuleOutput {
  const fail = (message: string): never => {
    throw new ModuleOutputError(`${code}: ${message}`);
  };

  const seen = new Set<string>();
  for (const claim of output.claims) {
    if (seen.has(claim.claim_key)) fail(`claim_key ${claim.claim_key} appears twice in one output`);
    seen.add(claim.claim_key);

    if (claim.status === 'UNKNOWN') {
      // An honest non-answer is allowed, and is the point of having UNKNOWN.
      continue;
    }
    if (claim.evidence.length === 0) {
      fail(`claim ${claim.claim_key} is ${claim.status} with no evidence`);
    }

    for (const ref of claim.evidence) {
      const targets = [ref.chunk_id, ref.fact_version_id].filter((t) => t !== null && t !== '');
      if (targets.length !== 1) {
        fail(`claim ${claim.claim_key} must cite exactly one of chunk_id or fact_version_id`);
      }
      if (ref.chunk_id) {
        if (!ref.quote || ref.quote.trim().length < MIN_QUOTE_CHARS) {
          fail(`claim ${claim.claim_key} cites a chunk with no usable quote`);
        }
      }
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
