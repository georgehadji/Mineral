import type { ModuleKind } from '@mineral/domain';

/**
 * Module declarations. This is the single source of truth for dependencies
 * (report I.18): a recipe lists which modules to run and at which version, and
 * the DAG is derived from `requires` here. Codes are snake_case because they
 * are persisted in `research.module_definitions.code` (report I.25);
 * directories on disk use kebab-case.
 */
export interface ModuleDecl {
  code: string;
  version: string;
  category: string;
  kind: ModuleKind;
  requires: string[];
}

export const MODULE_REGISTRY: readonly ModuleDecl[] = [
  { code: 'entity_resolution', version: '1.0.0', category: 'identity', kind: 'deterministic', requires: [] },
  { code: 'company_profile', version: '1.0.0', category: 'profile', kind: 'llm', requires: ['entity_resolution'] },
  { code: 'business_model', version: '1.0.0', category: 'profile', kind: 'llm', requires: ['company_profile'] },
  { code: 'industry_position', version: '1.0.0', category: 'industry', kind: 'llm', requires: ['company_profile', 'business_model'] },
  { code: 'commodity_exposure', version: '1.0.0', category: 'industry', kind: 'llm', requires: ['company_profile', 'business_model'] },
  { code: 'supply_chain_position', version: '1.0.0', category: 'industry', kind: 'llm', requires: ['commodity_exposure', 'industry_position'] },
  { code: 'project_pipeline', version: '1.0.0', category: 'industry', kind: 'llm', requires: ['supply_chain_position'] },
  { code: 'financial_quality', version: '1.0.0', category: 'financial', kind: 'hybrid', requires: ['company_profile'] },
  { code: 'capital_structure', version: '1.0.0', category: 'financial', kind: 'hybrid', requires: ['financial_quality'] },
  { code: 'management', version: '1.0.0', category: 'governance', kind: 'llm', requires: ['company_profile', 'financial_quality'] },
  { code: 'competitive_landscape', version: '1.0.0', category: 'industry', kind: 'llm', requires: ['industry_position', 'supply_chain_position'] },
  { code: 'risks', version: '1.0.0', category: 'risk', kind: 'llm', requires: ['financial_quality', 'supply_chain_position', 'competitive_landscape'] },
  { code: 'catalysts', version: '1.0.0', category: 'risk', kind: 'llm', requires: ['project_pipeline', 'competitive_landscape'] },
  { code: 'valuation_assumptions', version: '1.0.0', category: 'valuation', kind: 'llm', requires: ['financial_quality', 'capital_structure'] },
  { code: 'assumption_policy', version: '1.0.0', category: 'valuation', kind: 'deterministic', requires: ['valuation_assumptions'] },
  { code: 'valuation_calc', version: '1.0.0', category: 'valuation', kind: 'deterministic', requires: ['assumption_policy'] },
  { code: 'scenario_model', version: '1.0.0', category: 'valuation', kind: 'deterministic', requires: ['valuation_calc', 'project_pipeline', 'commodity_exposure'] },
  { code: 'bear_case', version: '1.0.0', category: 'risk', kind: 'llm', requires: ['risks', 'valuation_calc', 'competitive_landscape'] },
  { code: 'contradiction_check', version: '1.0.0', category: 'verification', kind: 'deterministic', requires: ['company_profile', 'financial_quality', 'competitive_landscape', 'risks', 'catalysts', 'bear_case'] },
  { code: 'numerical_check', version: '1.0.0', category: 'verification', kind: 'deterministic', requires: ['financial_quality', 'valuation_calc', 'scenario_model'] },
  { code: 'source_check', version: '1.0.0', category: 'verification', kind: 'deterministic', requires: ['company_profile', 'financial_quality', 'competitive_landscape', 'risks', 'catalysts', 'bear_case'] },
  { code: 'final_synthesis', version: '1.0.0', category: 'synthesis', kind: 'llm', requires: ['contradiction_check', 'numerical_check', 'source_check', 'scenario_model'] },
];

export const MODULES_BY_CODE: ReadonlyMap<string, ModuleDecl> = new Map(
  MODULE_REGISTRY.map((m) => [m.code, m]),
);
