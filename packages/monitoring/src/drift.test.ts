import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE_CONFIG, evaluate, type AlertRule, type DriftReport } from './drift.ts';

/**
 * The rules are pure, so they are checked here with no database. What the
 * integration suite proves is that the repository loads rows of this shape;
 * what this proves is that rows of this shape produce the right alerts.
 */

const rule = (ruleType: string, config?: Record<string, unknown>): AlertRule => ({
  id: `rule-${ruleType}`,
  ruleType,
  config: config ?? DEFAULT_RULE_CONFIG[ruleType as keyof typeof DEFAULT_RULE_CONFIG] ?? {},
});

const THESIS = {
  thesisVersionId: 'thesis-1',
  versionNo: 2,
  verdict: 'bullish',
  researchRunId: 'run-1',
  runStartedAt: '2026-06-01T00:00:00Z',
  createdAt: '2026-06-01T00:10:00Z',
};

const empty: DriftReport = {
  companyId: 'company-1',
  thesis: THESIS,
  newSources: [],
  affected: [],
  valuation: null,
};

describe('new_primary_source', () => {
  const filing = {
    documentVersionId: 'dv-10q',
    documentId: 'doc-10q',
    documentType: '10-Q',
    title: 'Quarterly report',
    versionNo: 1,
    sourceTier: 1,
    publishedAt: '2026-08-01T00:00:00Z',
    capturedAt: '2026-08-02T00:00:00Z',
  };

  it('fires on a filing the thesis never read, pointing at the version', () => {
    const [finding, ...rest] = evaluate([rule('new_primary_source')], {
      ...empty,
      newSources: [filing],
    });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      ruleType: 'new_primary_source',
      severity: 'warning',
      triggerRefType: 'document_version',
      triggerRefId: 'dv-10q',
    });
  });

  it('is quieter about a secondary source than about a filing', () => {
    const [finding] = evaluate([rule('new_primary_source')], {
      ...empty,
      newSources: [{ ...filing, sourceTier: 2 }],
    });
    expect(finding?.severity).toBe('info');
  });

  it('ignores sources below the configured tier, and unknown tiers', () => {
    const findings = evaluate([rule('new_primary_source')], {
      ...empty,
      newSources: [
        { ...filing, documentVersionId: 'dv-blog', sourceTier: 4 },
        { ...filing, documentVersionId: 'dv-unknown', sourceTier: null },
      ],
    });
    expect(findings).toEqual([]);
  });

  it('narrows to the document types a rule names', () => {
    const narrowed = rule('new_primary_source', { maxTier: 2, documentTypes: ['10-K'] });
    expect(evaluate([narrowed], { ...empty, newSources: [filing] })).toEqual([]);
  });

  it('gives one cause one dedupe key, whatever else changed', () => {
    const once = evaluate([rule('new_primary_source')], { ...empty, newSources: [filing] });
    const again = evaluate([rule('new_primary_source')], {
      ...empty,
      newSources: [{ ...filing, capturedAt: '2026-09-09T00:00:00Z' }],
    });
    expect(again[0]?.dedupeKey).toBe(once[0]?.dedupeKey);
  });
});

describe('assumption_invalidated', () => {
  const node = {
    nodeId: 'node-rate',
    nodeType: 'ASSUMPTION',
    statement: 'Cash flows are discounted at the approved rate.',
    claimId: 'claim-1',
    claimKey: 'discount_rate_basis',
    assumptionVersionId: 'av-1',
    assumptionCode: 'discount_rate',
  };

  it('fires once per reason, pointing at the row that displaced the evidence', () => {
    const findings = evaluate([rule('assumption_invalidated')], {
      ...empty,
      affected: [
        {
          ...node,
          reasons: [
            {
              kind: 'fact_moved',
              triggerRefType: 'fact_version',
              triggerRefId: 'fv-new',
              citedFactVersionId: 'fv-old',
              code: 'free_cash_flow',
              from: 91_300_000,
              to: 70_000_000,
            },
            {
              kind: 'document_superseded',
              triggerRefType: 'document_version',
              triggerRefId: 'dv-2',
              citedDocumentVersionId: 'dv-1',
              title: 'Annual report',
              versionNo: 2,
            },
          ],
        },
      ],
    });

    expect(findings.map((finding) => finding.triggerRefId)).toEqual(['fv-new', 'dv-2']);
    expect(new Set(findings.map((finding) => finding.dedupeKey)).size).toBe(2);
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('treats a contradicted claim as worse than a moved number', () => {
    const [finding] = evaluate([rule('assumption_invalidated')], {
      ...empty,
      affected: [
        {
          ...node,
          reasons: [
            {
              kind: 'claim_contradicted',
              triggerRefType: 'claim',
              triggerRefId: 'claim-1',
              status: 'CONTRADICTED',
            },
          ],
        },
      ],
    });
    expect(finding?.severity).toBe('critical');
  });

  it('leaves affected nodes that are not assumptions to the drift report', () => {
    const findings = evaluate([rule('assumption_invalidated')], {
      ...empty,
      affected: [
        {
          ...node,
          nodeId: 'node-driver',
          nodeType: 'DRIVER',
          assumptionVersionId: null,
          assumptionCode: null,
          reasons: [
            {
              kind: 'document_superseded',
              triggerRefType: 'document_version',
              triggerRefId: 'dv-2',
              citedDocumentVersionId: 'dv-1',
              title: 'Annual report',
              versionNo: 2,
            },
          ],
        },
      ],
    });
    expect(findings).toEqual([]);
  });
});

describe('valuation_threshold', () => {
  const drift = (changePct: number) => ({
    method: 'dcf',
    thesisCalculationRunId: 'cr-thesis',
    latestCalculationRunId: 'cr-latest',
    calculatedAt: '2026-08-10T00:00:00Z',
    moves: [
      {
        code: 'dcf_equity_value',
        name: 'DCF equity value',
        from: 1_000_000_000,
        to: 1_000_000_000 * (1 + changePct),
        changePct,
      },
    ],
  });

  it('stays silent inside the configured band', () => {
    expect(evaluate([rule('valuation_threshold')], { ...empty, valuation: drift(0.05) })).toEqual([]);
  });

  it('fires on a move past the band, pointing at the run that moved it', () => {
    const [finding] = evaluate([rule('valuation_threshold')], { ...empty, valuation: drift(-0.15) });
    expect(finding).toMatchObject({
      severity: 'warning',
      triggerRefType: 'calculation_run',
      triggerRefId: 'cr-latest',
    });
  });

  it('escalates a move of twice the band', () => {
    const [finding] = evaluate([rule('valuation_threshold')], { ...empty, valuation: drift(0.4) });
    expect(finding?.severity).toBe('critical');
  });
});

describe('evaluate', () => {
  it('has nothing to say about a company with no thesis', () => {
    const rules = [rule('assumption_invalidated'), rule('valuation_threshold')];
    const findings = evaluate(rules, {
      ...empty,
      thesis: null,
      affected: [
        {
          nodeId: 'node-rate',
          nodeType: 'ASSUMPTION',
          statement: 'Cash flows are discounted at the approved rate.',
          claimId: 'claim-1',
          claimKey: 'discount_rate_basis',
          assumptionVersionId: 'av-1',
          assumptionCode: 'discount_rate',
          reasons: [
            {
              kind: 'claim_contradicted',
              triggerRefType: 'claim',
              triggerRefId: 'claim-1',
              status: 'CONTRADICTED',
            },
          ],
        },
      ],
      valuation: {
        method: 'dcf',
        thesisCalculationRunId: 'cr-thesis',
        latestCalculationRunId: 'cr-latest',
        calculatedAt: '2026-08-10T00:00:00Z',
        moves: [
          { code: 'dcf_equity_value', name: 'DCF equity value', from: 1, to: 2, changePct: 1 },
        ],
      },
    });
    expect(findings).toEqual([]);
  });

  it('skips rule types this phase does not implement', () => {
    expect(evaluate([rule('geopolitical_change')], empty)).toEqual([]);
  });
});
