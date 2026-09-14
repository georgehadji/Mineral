import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDag, RecipeError } from './dag.js';
import { MODULE_REGISTRY, MODULES_BY_CODE, type ModuleDecl } from './modules.js';
import { parseRecipe, type Recipe } from './recipe.js';

const recipePath = fileURLToPath(
  new URL('../recipes/company-deep-research.yaml', import.meta.url),
);
const recipe = parseRecipe(readFileSync(recipePath, 'utf8'));

const registryOf = (decls: ModuleDecl[]): ReadonlyMap<string, ModuleDecl> =>
  new Map(decls.map((d) => [d.code, d]));

const recipeOf = (codes: string[]): Recipe => ({
  ...recipe,
  modules: codes.map((code) => ({ code, version: '1.0.0' })),
});

describe('company-deep-research recipe', () => {
  it('requires evidence before the run starts', () => {
    expect(recipe.preconditions).toContain('evidence_ingested');
  });

  it('builds a DAG covering every listed module exactly once', () => {
    const dag = buildDag(recipe);
    expect(dag.order).toHaveLength(recipe.modules.length);
    expect(new Set(dag.order).size).toBe(recipe.modules.length);
  });

  it('places each module after everything it requires', () => {
    const dag = buildDag(recipe);
    const position = new Map(dag.order.map((code, i) => [code, i]));
    for (const code of dag.order) {
      for (const dep of MODULES_BY_CODE.get(code)!.requires) {
        expect(position.get(dep)!).toBeLessThan(position.get(code)!);
      }
    }
  });

  it('starts with entity resolution and ends with synthesis', () => {
    const dag = buildDag(recipe);
    expect(dag.levels[0]).toEqual(['entity_resolution']);
    expect(dag.levels.at(-1)).toEqual(['final_synthesis']);
  });

  it('lets no LLM module produce a valuation number (rule 6)', () => {
    const kindOf = (code: string) => MODULES_BY_CODE.get(code)!.kind;
    expect(kindOf('valuation_assumptions')).toBe('llm');
    expect(kindOf('assumption_policy')).toBe('deterministic');
    expect(kindOf('valuation_calc')).toBe('deterministic');
    expect(kindOf('scenario_model')).toBe('deterministic');
  });

  it('verifies every narrative module and the bear case', () => {
    const sourceChecked = MODULES_BY_CODE.get('source_check')!.requires;
    expect(sourceChecked).toContain('bear_case');
    expect(MODULES_BY_CODE.get('numerical_check')!.requires).toContain('valuation_calc');
  });
});

describe('buildDag validation', () => {
  it('rejects an unknown module', () => {
    expect(() => buildDag(recipeOf(['entity_resolution', 'does_not_exist']))).toThrow(RecipeError);
  });

  it('rejects a version the registry does not have', () => {
    const bad: Recipe = { ...recipe, modules: [{ code: 'entity_resolution', version: '9.9.9' }] };
    expect(() => buildDag(bad)).toThrow(/version mismatch/);
  });

  it('rejects a module whose requirement the recipe omits', () => {
    expect(() => buildDag(recipeOf(['company_profile']))).toThrow(/requires entity_resolution/);
  });

  it('rejects a duplicate module', () => {
    expect(() => buildDag(recipeOf(['entity_resolution', 'entity_resolution']))).toThrow(/twice/);
  });

  it('detects a cycle', () => {
    const cyclic = registryOf([
      { code: 'a', version: '1.0.0', category: 't', kind: 'deterministic', requires: ['b'] },
      { code: 'b', version: '1.0.0', category: 't', kind: 'deterministic', requires: ['a'] },
    ]);
    const r: Recipe = {
      ...recipe,
      modules: [
        { code: 'a', version: '1.0.0' },
        { code: 'b', version: '1.0.0' },
      ],
    };
    expect(() => buildDag(r, cyclic)).toThrow(/cycle/);
  });
});

describe('module registry', () => {
  it('references only modules it declares', () => {
    for (const m of MODULE_REGISTRY) {
      for (const dep of m.requires) {
        expect(MODULES_BY_CODE.has(dep)).toBe(true);
      }
    }
  });

  it('uses snake_case codes so they can be persisted as-is', () => {
    for (const m of MODULE_REGISTRY) {
      expect(m.code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
