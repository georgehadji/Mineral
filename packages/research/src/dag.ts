import { MODULES_BY_CODE, type ModuleDecl } from './modules.ts';
import type { Recipe } from './recipe.ts';

export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipeError';
  }
}

export interface RecipeDag {
  /** Modules grouped by dependency depth. Each level may run in parallel. */
  levels: string[][];
  /** Flattened topological order. */
  order: string[];
}

/**
 * Derives and validates the execution DAG for a recipe (report I.18).
 * Rejects unknown modules, version mismatches against the registry, required
 * modules the recipe omits, duplicates, and cycles.
 *
 * Levels map one-to-one onto Inngest `step.run` batches: every module in a
 * level has all of its dependencies satisfied by earlier levels.
 */
export function buildDag(
  recipe: Recipe,
  registry: ReadonlyMap<string, ModuleDecl> = MODULES_BY_CODE,
): RecipeDag {
  const selected = new Map<string, ModuleDecl>();

  for (const ref of recipe.modules) {
    if (selected.has(ref.code)) {
      throw new RecipeError(`module listed twice: ${ref.code}`);
    }
    const decl = registry.get(ref.code);
    if (!decl) {
      throw new RecipeError(`unknown module: ${ref.code}`);
    }
    if (decl.version !== ref.version) {
      throw new RecipeError(
        `version mismatch for ${ref.code}: recipe wants ${ref.version}, registry has ${decl.version}`,
      );
    }
    selected.set(ref.code, decl);
  }

  for (const decl of selected.values()) {
    for (const dep of decl.requires) {
      if (!selected.has(dep)) {
        throw new RecipeError(`${decl.code} requires ${dep}, which the recipe does not include`);
      }
    }
  }

  const remaining = new Set(selected.keys());
  const done = new Set<string>();
  const levels: string[][] = [];

  while (remaining.size > 0) {
    const level = [...remaining]
      .filter((code) => selected.get(code)!.requires.every((dep) => done.has(dep)))
      .sort();

    if (level.length === 0) {
      throw new RecipeError(`dependency cycle among: ${[...remaining].sort().join(', ')}`);
    }

    for (const code of level) {
      remaining.delete(code);
      done.add(code);
    }
    levels.push(level);
  }

  return { levels, order: levels.flat() };
}
