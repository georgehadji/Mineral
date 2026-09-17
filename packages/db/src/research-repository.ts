import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';
import { sha256, zodToJsonSchema, type Transport } from '@mineral/ai';
import {
  IMPLEMENTATIONS_BY_CODE,
  MODULES_BY_CODE,
  MODULE_REGISTRY,
  ModuleOutputError,
  ModuleOutputSchema,
  buildDag,
  quoteIsContained,
  type ContextChunk,
  type ContextFact,
  type ModuleImpl,
  type ModuleOutput,
  type Recipe,
  type ResearchContext,
} from '@mineral/research';
import { inTransaction } from './client.ts';
import { callModel } from './model-repository.ts';
import { resolveCompany } from './identity-repository.ts';

/**
 * The persistence half of the module runtime (report F, phase J.6).
 *
 * Modules are pure: they receive a context and return claims. This file is
 * where those claims meet the database, and it is the last place a citation
 * can be checked against the bytes it claims to come from. Nothing a module
 * returns is written before that check passes -- an uncited claim and a cited
 * one are indistinguishable once they are both rows.
 *
 * Writes are append-only. A re-run adds module run attempts and new claims; it
 * never edits what an earlier run concluded.
 */

/** A seam for Inngest. Today it just calls the function (see the README note). */
export type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
const inlineStep: Step = (_name, fn) => fn();

export interface RunResearchInput {
  /** Either a query to resolve ("MP") or an already-resolved company. */
  query?: string;
  companyId?: UUID;
  recipe: Recipe;
  /** Defaults to today. The run is pinned to it, so a re-run is comparable. */
  asOfDate?: string;
  transport?: Transport;
  apiKey?: string;
  cacheOnly?: boolean;
  step?: Step;
  /** Who asked. Research state is global; the run still records the requester. */
  userId?: UUID;
  /** Called with the run id as soon as the row exists, before the modules run,
   *  so a caller that does not wait for the whole DAG still has something to
   *  show a status page. */
  onStart?: (runId: UUID) => void;
}

export interface ModuleOutcome {
  code: string;
  moduleRunId: UUID;
  status: 'completed' | 'failed';
  claimCount: number;
  assumptionCount: number;
  /** Claims the citation gate refused, and why. Empty on a clean module. */
  rejected?: RejectedClaim[];
  error?: string;
}

export interface RunResearchResult {
  runId: UUID;
  snapshotId: UUID;
  snapshotHash: string;
  status: 'completed' | 'failed';
  modules: ModuleOutcome[];
  claimCount: number;
  assumptionCount: number;
  /** True when this exact run existed already and was returned untouched. */
  reused: boolean;
}

export class ResearchRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchRunError';
  }
}

// --- registration -----------------------------------------------------------

/**
 * The registry in packages/research is the source of truth; these rows exist so
 * module runs and claims have something to point at. Re-registering is a
 * no-op, so it can run before every execution.
 */
export async function ensureModuleDefinitions(pool: Pool): Promise<Map<string, UUID>> {
  const ids = new Map<string, UUID>();
  const outputSchema = JSON.stringify(zodToJsonSchema(ModuleOutputSchema));
  // The input is a ResearchContext assembled here, not something a caller
  // sends, so the column records its name rather than a shape nobody validates.
  const inputSchema = JSON.stringify({ type: 'object', title: 'ResearchContext' });

  for (const decl of MODULE_REGISTRY) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into research.module_definitions
         (code, version, kind, category, requires, input_schema, output_schema)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       on conflict (code, version) do update
         set kind = excluded.kind,
             category = excluded.category,
             requires = excluded.requires,
             output_schema = excluded.output_schema
       returning id`,
      [decl.code, decl.version, decl.kind, decl.category, decl.requires, inputSchema, outputSchema],
    );
    const id = rows[0]?.id;
    if (!id) throw new ResearchRunError(`could not register module ${decl.code}`);
    ids.set(decl.code, id);
  }
  return ids;
}

async function ensurePromptVersion(
  pool: Pool,
  moduleDefinitionId: UUID,
  impl: ModuleImpl,
): Promise<UUID | null> {
  if (!impl.prompt) return null;
  const responseSchema = JSON.stringify(zodToJsonSchema(ModuleOutputSchema));
  await pool.query(
    `insert into research.prompt_versions
       (module_definition_id, version, system_prompt, response_schema)
     values ($1, $2, $3, $4::jsonb)
     on conflict (module_definition_id, version) do nothing`,
    [moduleDefinitionId, impl.prompt.version, impl.prompt.system, responseSchema],
  );
  const { rows } = await pool.query<{ id: string }>(
    `select id from research.prompt_versions
      where module_definition_id = $1 and version = $2`,
    [moduleDefinitionId, impl.prompt.version],
  );
  return rows[0]?.id ?? null;
}

async function ensureRecipe(pool: Pool, recipe: Recipe): Promise<UUID> {
  await pool.query(
    `insert into research.recipes (code, version, definition)
     values ($1, $2, $3::jsonb)
     on conflict (code, version) do update set definition = excluded.definition`,
    [recipe.id, recipe.version, JSON.stringify({ modules: recipe.modules })],
  );
  const { rows } = await pool.query<{ id: string }>(
    `select id from research.recipes where code = $1 and version = $2`,
    [recipe.id, recipe.version],
  );
  const id = rows[0]?.id;
  if (!id) throw new ResearchRunError(`could not register recipe ${recipe.id}`);
  return id;
}

// --- snapshot ---------------------------------------------------------------

interface SnapshotManifest {
  subjectId: UUID;
  asOfDate: string;
  chunkIds: string[];
  factVersionIds: string[];
  documentVersionIds: string[];
}

export interface FrozenSnapshot {
  id: UUID;
  hash: string;
  chunks: ContextChunk[];
  facts: ContextFact[];
}

async function loadChunks(pool: Pool, companyId: UUID): Promise<ContextChunk[]> {
  const { rows } = await pool.query<{
    chunk_id: string;
    document_version_id: string;
    title: string;
    published_at: Date | null;
    source_tier: number;
    text_content: string;
  }>(
    `select dc.id as chunk_id, dc.document_version_id, d.title, d.published_at,
            s.source_tier, dc.text_content
       from evidence.document_subjects ds
       join evidence.documents d on d.id = ds.document_id
       join evidence.sources s on s.id = d.source_id
       join lateral (
         select dv.id from evidence.document_versions dv
          where dv.document_id = d.id
          order by dv.version_no desc
          limit 1
       ) latest on true
       join evidence.document_chunks dc on dc.document_version_id = latest.id
      where ds.entity_id = $1
      order by d.published_at desc nulls last, dc.chunk_index`,
    [companyId],
  );
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentVersionId: row.document_version_id,
    documentTitle: row.title,
    publishedAt: row.published_at ? row.published_at.toISOString().slice(0, 10) : null,
    sourceTier: row.source_tier,
    text: row.text_content,
  }));
}

async function loadFacts(pool: Pool, companyId: UUID): Promise<ContextFact[]> {
  const { rows } = await pool.query<{
    fact_version_id: string;
    code: string;
    label: string;
    value: string;
    unit: string | null;
    period_end: string | null;
  }>(
    `select fv.id as fact_version_id, fd.code, fd.name as label,
            coalesce(fv.numeric_value::text, fv.text_value, fv.boolean_value::text,
                     fv.date_value::text, fv.json_value::text) as value,
            fv.unit, f.period_end::text
       from evidence.facts f
       join evidence.fact_versions fv on fv.id = f.current_version_id
       join evidence.fact_definitions fd on fd.id = f.fact_definition_id
      where f.entity_id = $1 and fv.status = 'promoted'
      order by fd.code, f.period_end desc nulls last`,
    [companyId],
  );
  return rows.map((row) => ({
    factVersionId: row.fact_version_id,
    code: row.code,
    label: row.label,
    value: row.value,
    unit: row.unit,
    periodEnd: row.period_end,
  }));
}

/**
 * Freezes what the run is allowed to see. The manifest holds ids only (I.14):
 * the bytes stay where they are, and the hash makes "the same inputs" a
 * checkable statement rather than an assumption.
 */
export async function freezeSnapshot(
  pool: Pool,
  companyId: UUID,
  asOfDate: string,
): Promise<FrozenSnapshot> {
  const [chunks, facts] = await Promise.all([loadChunks(pool, companyId), loadFacts(pool, companyId)]);

  const manifest: SnapshotManifest = {
    subjectId: companyId,
    asOfDate,
    chunkIds: chunks.map((c) => c.chunkId).sort(),
    factVersionIds: facts.map((f) => f.factVersionId).sort(),
    documentVersionIds: [...new Set(chunks.map((c) => c.documentVersionId))].sort(),
  };
  const hash = sha256(JSON.stringify(manifest));

  await pool.query(
    `insert into research.snapshots (content_hash, manifest)
     values ($1, $2::jsonb)
     on conflict (content_hash) do nothing`,
    [hash, JSON.stringify(manifest)],
  );
  const { rows } = await pool.query<{ id: string }>(
    `select id from research.snapshots where content_hash = $1`,
    [hash],
  );
  const id = rows[0]?.id;
  if (!id) throw new ResearchRunError('could not store the snapshot');
  return { id, hash, chunks, facts };
}

// --- citation checking ------------------------------------------------------

export interface RejectedClaim {
  claimKey: string;
  reason: string;
}

/**
 * The check the phase gate names: every quote must appear in the chunk it
 * cites, and every citation must point inside the frozen snapshot. A module
 * that cites something outside the snapshot has cited something the run never
 * read.
 *
 * A failing claim is dropped rather than thrown, and the rest of the module is
 * kept. It used to take the whole run down, which turned one bad citation into
 * the loss of fourteen good modules: against a real 10-K a model stitched two
 * cells of a cover-page table into one quote, and a fifteen-module run ended
 * there. The bar is unchanged -- nothing uncited or miscited is ever stored --
 * but the blast radius is now the claim that earned it.
 *
 * Every rejection is returned, recorded on the module run and counted in the
 * outcome, because a claim that vanishes with no trace is the failure mode this
 * whole file exists to prevent.
 */
function checkCitations(
  code: string,
  output: ModuleOutput,
  chunks: Map<string, ContextChunk>,
  factIds: Set<string>,
): { kept: ModuleOutput; rejected: RejectedClaim[] } {
  const rejected: RejectedClaim[] = [];

  const faultIn = (claim: ModuleOutput['claims'][number]): string | null => {
    for (const ref of claim.evidence) {
      if (ref.fact_version_id) {
        if (!factIds.has(ref.fact_version_id)) {
          return `cites fact version ${ref.fact_version_id}, which is not in the snapshot`;
        }
        continue;
      }
      const chunk = ref.chunk_id ? chunks.get(ref.chunk_id) : undefined;
      if (!chunk) return `cites chunk ${ref.chunk_id}, which is not in the snapshot`;
      if (!quoteIsContained(ref.quote ?? '', chunk.text)) {
        return `quotes text that is not in chunk ${chunk.chunkId}`;
      }
    }
    return null;
  };

  const claims = output.claims.filter((claim) => {
    const fault = faultIn(claim);
    if (fault) rejected.push({ claimKey: claim.claim_key, reason: `${code}: ${claim.claim_key} ${fault}` });
    return fault === null;
  });

  // What rested on a dropped claim goes with it. An assumption or a site whose
  // finding was thrown away is exactly the orphan the source_claim_key exists
  // to make impossible.
  const surviving = new Set(claims.map((claim) => claim.claim_key));
  const assumptions = output.assumptions.filter((proposal) => {
    if (surviving.has(proposal.source_claim_key)) return true;
    rejected.push({
      claimKey: proposal.source_claim_key,
      reason: `${code}: assumption ${proposal.code} dropped with the claim it rested on`,
    });
    return false;
  });
  const facilities = output.facilities.filter((facility) => {
    if (surviving.has(facility.source_claim_key)) return true;
    rejected.push({
      claimKey: facility.source_claim_key,
      reason: `${code}: facility ${facility.name} dropped with the claim it rested on`,
    });
    return false;
  });

  return { kept: { ...output, claims, assumptions, facilities }, rejected };
}

// --- persistence ------------------------------------------------------------

async function persistClaims(
  client: PoolClient,
  params: {
    runId: UUID;
    moduleRunId: UUID;
    companyId: UUID;
    output: ModuleOutput;
    chunks: Map<string, ContextChunk>;
    createdBy: 'llm' | 'system';
  },
): Promise<number> {
  for (const claim of params.output.claims) {
    const { rows } = await client.query<{ id: string }>(
      `insert into research.claims
         (run_id, module_run_id, subject_type, subject_id, claim_key, claim_type,
          statement, epistemic_status, confidence, created_by)
       values ($1, $2, 'company', $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        params.runId,
        params.moduleRunId,
        params.companyId,
        claim.claim_key,
        claim.claim_type,
        claim.statement,
        claim.status,
        claim.confidence,
        params.createdBy,
      ],
    );
    const claimId = rows[0]?.id;
    if (!claimId) throw new ResearchRunError(`could not store claim ${claim.claim_key}`);

    for (const ref of claim.evidence) {
      const chunk = ref.chunk_id ? params.chunks.get(ref.chunk_id) : undefined;
      await client.query(
        `insert into research.claim_evidence
           (claim_id, document_version_id, chunk_id, fact_version_id,
            evidence_role, support_strength, quote_excerpt)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          claimId,
          chunk?.documentVersionId ?? null,
          chunk?.chunkId ?? null,
          ref.fact_version_id || null,
          ref.role,
          ref.strength,
          chunk ? ref.quote : null,
        ],
      );
    }
  }
  return params.output.claims.length;
}

/**
 * Proposed assumptions (report G, I.22). Status is `proposed` and nothing here
 * approves anything: that is deterministic policy, and it runs later, over
 * stored rows. The source claim is resolved against what this run actually
 * wrote, so a proposal naming a finding nobody made fails the module instead of
 * founding a valuation on it.
 */
async function persistAssumptions(
  client: PoolClient,
  params: {
    runId: UUID;
    companyId: UUID;
    output: ModuleOutput;
    proposedBy: 'llm' | 'system';
    code: string;
  },
): Promise<number> {
  for (const proposal of params.output.assumptions) {
    const { rows: claims } = await client.query<{ id: string }>(
      `select id from research.claims where run_id = $1 and claim_key = $2 order by id limit 1`,
      [params.runId, proposal.source_claim_key],
    );
    const sourceClaimId = claims[0]?.id;
    if (!sourceClaimId) {
      throw new ModuleOutputError(
        `${params.code}: assumption ${proposal.code} rests on claim ${proposal.source_claim_key}, which this run did not produce`,
      );
    }

    const { rows: assumptions } = await client.query<{ id: string }>(
      `insert into valuation.assumptions (subject_type, subject_id, code, name, unit)
       values ('company', $1, $2, $3, $4)
       on conflict (subject_id, code) do update
         set name = excluded.name, unit = excluded.unit
       returning id`,
      [params.companyId, proposal.code, proposal.name, proposal.unit],
    );
    const assumptionId = assumptions[0]?.id;
    if (!assumptionId) throw new ResearchRunError(`could not store assumption ${proposal.code}`);

    // version_no is assigned by the trigger, which locks the parent first.
    await client.query(
      `insert into valuation.assumption_versions
         (assumption_id, version_no, value_numeric, min_value, max_value,
          source_claim_id, rationale, status, proposed_by)
       values ($1, 0, $2, $3, $4, $5, $6, 'proposed', $7)`,
      [
        assumptionId,
        proposal.value,
        proposal.min_value,
        proposal.max_value,
        sourceClaimId,
        proposal.rationale,
        params.proposedBy,
      ],
    );
  }
  return params.output.assumptions.length;
}

// --- orchestration ----------------------------------------------------------

function contextFor(
  snapshot: FrozenSnapshot,
  subject: ResearchContext['subject'],
  asOfDate: string,
  requires: readonly string[],
  outputs: Map<string, ModuleOutput>,
): ResearchContext {
  const upstream: Record<string, ContextClaimList> = {};
  for (const dep of requires) {
    upstream[dep] = (outputs.get(dep)?.claims ?? []).map((claim) => ({
      claimKey: claim.claim_key,
      statement: claim.statement,
      status: claim.status,
    }));
  }
  return { subject, asOfDate, chunks: snapshot.chunks, facts: snapshot.facts, upstream };
}

type ContextClaimList = ResearchContext['upstream'][string];

async function nextAttempt(pool: Pool, runId: UUID, moduleDefinitionId: UUID): Promise<number> {
  const { rows } = await pool.query<{ attempt: number }>(
    `select coalesce(max(attempt), 0) + 1 as attempt
       from research.module_runs where run_id = $1 and module_definition_id = $2`,
    [runId, moduleDefinitionId],
  );
  return rows[0]?.attempt ?? 1;
}

export async function runResearch(pool: Pool, input: RunResearchInput): Promise<RunResearchResult> {
  const step = input.step ?? inlineStep;
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const dag = buildDag(input.recipe);

  const subject = await step('resolve-subject', () => resolveSubject(pool, input));
  const [definitionIds, recipeId] = await Promise.all([
    ensureModuleDefinitions(pool),
    ensureRecipe(pool, input.recipe),
  ]);

  const snapshot = await step('freeze-snapshot', () => freezeSnapshot(pool, subject.companyId, asOfDate));

  if (input.recipe.preconditions.includes('evidence_ingested')) {
    // Report I.23: an empty snapshot produces confident UNKNOWNs that look like
    // findings. Refuse the run instead of laundering the absence of evidence.
    if (snapshot.chunks.length === 0 && snapshot.facts.length === 0) {
      throw new ResearchRunError(
        `nothing to research: no documents or promoted facts for ${subject.legalName}. Ingest first.`,
      );
    }
  }

  const idempotencyKey = [
    subject.companyId,
    `${input.recipe.id}@${input.recipe.version}`,
    asOfDate,
    snapshot.hash,
  ].join('|');

  const existing = await pool.query<{ id: string; status: string }>(
    `select id, status from research.runs where idempotency_key = $1`,
    [idempotencyKey],
  );
  if (existing.rows[0]?.status === 'completed') {
    const runId = existing.rows[0].id;
    input.onStart?.(runId);
    const { rows } = await pool.query<{ claims: string; assumptions: string }>(
      `select (select count(*) from research.claims where run_id = $1)::text as claims,
              (select count(*) from valuation.assumption_versions av
                 join research.claims c on c.id = av.source_claim_id
                where c.run_id = $1)::text as assumptions`,
      [runId],
    );
    return {
      runId,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.hash,
      status: 'completed',
      modules: [],
      claimCount: Number(rows[0]?.claims ?? 0),
      assumptionCount: Number(rows[0]?.assumptions ?? 0),
      reused: true,
    };
  }

  const runId =
    existing.rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `insert into research.runs
           (subject_type, subject_id, recipe_id, as_of_date, depth_mode, status,
            snapshot_id, idempotency_key, started_at, user_id)
         values ('company', $1, $2, $3, $4, 'running', $5, $6, now(), $7)
         returning id`,
        [
          subject.companyId,
          recipeId,
          asOfDate,
          input.recipe.depth,
          snapshot.id,
          idempotencyKey,
          input.userId ?? null,
        ],
      )
    ).rows[0]?.id;
  if (!runId) throw new ResearchRunError('could not create the run');
  input.onStart?.(runId);

  const chunkIndex = new Map(snapshot.chunks.map((c) => [c.chunkId, c]));
  const factIds = new Set(snapshot.facts.map((f) => f.factVersionId));
  const outputs = new Map<string, ModuleOutput>();
  const outcomes: ModuleOutcome[] = [];

  try {
    for (const level of dag.levels) {
      const results = await Promise.all(
        level.map((code) =>
          step(`module:${code}`, () =>
            runModule({
              pool,
              runId,
              subject,
              asOfDate,
              code,
              definitionIds,
              snapshot,
              chunkIndex,
              factIds,
              outputs,
              input,
            }),
          ),
        ),
      );
      for (const result of results) {
        outcomes.push(result.outcome);
        outputs.set(result.outcome.code, result.output);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `update research.runs set status = 'failed', completed_at = now(), error = $2::jsonb where id = $1`,
      [runId, JSON.stringify({ message })],
    );
    throw error;
  }

  await pool.query(
    `update research.runs set status = 'completed', completed_at = now() where id = $1`,
    [runId],
  );

  return {
    runId,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.hash,
    status: 'completed',
    modules: outcomes,
    claimCount: outcomes.reduce((total, outcome) => total + outcome.claimCount, 0),
    assumptionCount: outcomes.reduce((total, outcome) => total + outcome.assumptionCount, 0),
    reused: false,
  };
}

interface RunModuleParams {
  pool: Pool;
  runId: UUID;
  subject: ResearchContext['subject'];
  asOfDate: string;
  code: string;
  definitionIds: Map<string, UUID>;
  snapshot: FrozenSnapshot;
  chunkIndex: Map<string, ContextChunk>;
  factIds: Set<string>;
  outputs: Map<string, ModuleOutput>;
  input: RunResearchInput;
}

async function runModule(
  params: RunModuleParams,
): Promise<{ outcome: ModuleOutcome; output: ModuleOutput }> {
  const { pool, runId, code } = params;
  const decl = MODULES_BY_CODE.get(code);
  const impl = IMPLEMENTATIONS_BY_CODE.get(code);
  if (!decl || !impl) throw new ResearchRunError(`no implementation for module ${code}`);

  const moduleDefinitionId = params.definitionIds.get(code);
  if (!moduleDefinitionId) throw new ResearchRunError(`module ${code} is not registered`);
  const promptVersionId = await ensurePromptVersion(pool, moduleDefinitionId, impl);

  const context = contextFor(
    params.snapshot,
    params.subject,
    params.asOfDate,
    decl.requires,
    params.outputs,
  );
  // Ids only: the module run records what was given, not a copy of it.
  const contextManifest = {
    chunkIds: context.chunks.map((c) => c.chunkId),
    factVersionIds: context.facts.map((f) => f.factVersionId),
    upstream: Object.keys(context.upstream),
  };

  const attempt = await nextAttempt(pool, runId, moduleDefinitionId);
  const { rows } = await pool.query<{ id: string }>(
    `insert into research.module_runs
       (run_id, module_definition_id, prompt_version_id, status, attempt, context_manifest, started_at)
     values ($1, $2, $3, 'running', $4, $5::jsonb, now())
     returning id`,
    [runId, moduleDefinitionId, promptVersionId, attempt, JSON.stringify(contextManifest)],
  );
  const moduleRunId = rows[0]?.id;
  if (!moduleRunId) throw new ResearchRunError(`could not start module run for ${code}`);

  try {
    const ask: Parameters<ModuleImpl['run']>[1] = async (request) => {
      const result = await callModel(pool, {
        ...request,
        schema: ModuleOutputSchema,
        researchRunId: runId,
        moduleRunId,
        promptVersionId,
        transport: params.input.transport,
        apiKey: params.input.apiKey,
        cacheOnly: params.input.cacheOnly,
      });
      return result.value;
    };

    const raw = await impl.run(context, ask);
    const { kept: output, rejected } = checkCitations(
      code,
      raw,
      params.chunkIndex,
      params.factIds,
    );

    const author = decl.kind === 'deterministic' ? 'system' : 'llm';
    await inTransaction(pool, async (client) => {
      await persistClaims(client, {
        runId,
        moduleRunId,
        companyId: params.subject.companyId,
        output,
        chunks: params.chunkIndex,
        createdBy: author,
      });
      await persistAssumptions(client, {
        runId,
        companyId: params.subject.companyId,
        output,
        proposedBy: author,
        code,
      });
      await client.query(
        `update research.module_runs
            set status = 'completed', completed_at = now(), output = $2::jsonb
          where id = $1`,
        // Rejections ride along with the output rather than in `error`: the
        // module did complete, and this is the record of what it was not
        // allowed to say.
        [moduleRunId, JSON.stringify({ ...output, rejected })],
      );
    });

    return {
      outcome: {
        code,
        moduleRunId,
        status: 'completed',
        claimCount: output.claims.length,
        assumptionCount: output.assumptions.length,
        rejected,
      },
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `update research.module_runs
          set status = 'failed', completed_at = now(), error = $2::jsonb
        where id = $1`,
      [moduleRunId, JSON.stringify({ message })],
    );
    throw new ResearchRunError(`module ${code} failed: ${message}`);
  }
}

async function resolveSubject(
  pool: Pool,
  input: RunResearchInput,
): Promise<ResearchContext['subject']> {
  let companyId = input.companyId;
  let legalName = '';
  let commonName: string | null = null;

  if (!companyId) {
    if (!input.query) throw new ResearchRunError('a run needs either a company id or a query');
    const outcome = await resolveCompany(pool, input.query);
    if (outcome.status !== 'resolved') {
      throw new ResearchRunError(
        outcome.status === 'ambiguous'
          ? `"${input.query}" matches ${outcome.candidates.length} companies; name one exactly`
          : `no company matches "${input.query}"`,
      );
    }
    companyId = outcome.company.companyId;
    legalName = outcome.company.legalName;
    commonName = outcome.company.commonName;
  } else {
    const { rows } = await pool.query<{ legal_name: string; common_name: string | null }>(
      `select legal_name, common_name from core.companies where id = $1`,
      [companyId],
    );
    if (!rows[0]) throw new ResearchRunError(`no company with id ${companyId}`);
    legalName = rows[0].legal_name;
    commonName = rows[0].common_name;
  }

  const { rows: identifiers } = await pool.query<{ value: string }>(
    `select value from core.company_identifiers
      where company_id = $1 and id_type = 'cik' limit 1`,
    [companyId],
  );

  return { companyId, legalName, commonName, cik: identifiers[0]?.value ?? null };
}
