import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * A recipe is an ordered set of (module code, version) plus the preconditions
 * that must hold before the run starts. It does not restate dependencies: those
 * live in the module registry and the DAG is derived from them (report I.18).
 */
export const RecipeSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  subject: z.enum(['company', 'commodity', 'theme', 'project', 'supply_chain_stage']),
  depth: z.enum(['quick', 'standard', 'deep']),
  /**
   * Preconditions are checked by the orchestrator before a snapshot is taken.
   * `evidence_ingested` stops a run on empty evidence laundering confident
   * UNKNOWN answers (report I.23).
   */
  preconditions: z.array(z.enum(['evidence_ingested', 'entity_resolved', 'market_data_current'])).default([]),
  modules: z
    .array(z.object({ code: z.string().min(1), version: z.string().min(1) }))
    .min(1),
});

export type Recipe = z.infer<typeof RecipeSchema>;

export function parseRecipe(yamlText: string): Recipe {
  return RecipeSchema.parse(parseYaml(yamlText));
}
