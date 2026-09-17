/**
 * Scoring (report J.12). Pure: a set of expected verdicts and a set of actual
 * ones go in, a score comes out, and the same pair always gives the same
 * number. That is the only way a score can gate anything.
 *
 * What is being measured is the checker, not the company. A verification rule
 * that never fires is worse than no rule, because it reads as a clean bill of
 * health; a rule that fires on everything is worse still. Recording both
 * numbers is the point: precision says how often a reported failure is real,
 * recall says how much of what is wrong the rule finds.
 */

export interface Outcome {
  /** Case identifier, so a regression names the case that broke. */
  id: string;
  /** What the dataset says should happen. */
  expected: string;
  /** What the code did. */
  actual: string;
  /** Which rule this case is about. */
  group: string;
}

export interface GroupScore {
  group: string;
  cases: number;
  correct: number;
  accuracy: number;
  /** Of the failures the rule reported, how many the dataset agrees are real. */
  precision: number | null;
  /** Of the failures the dataset knows about, how many the rule found. */
  recall: number | null;
  f1: number | null;
}

export interface Score {
  cases: number;
  correct: number;
  accuracy: number;
  groups: GroupScore[];
  /** Cases whose actual verdict differs from the expected one. */
  misses: Outcome[];
}

/** The verdict that counts as "this rule fired". */
const FIRED = 'failed';

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function score(outcomes: readonly Outcome[]): Score {
  const byGroup = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const group = byGroup.get(outcome.group) ?? [];
    group.push(outcome);
    byGroup.set(outcome.group, group);
  }

  const groups: GroupScore[] = [...byGroup.entries()]
    .map(([group, cases]) => {
      const correct = cases.filter((outcome) => outcome.actual === outcome.expected).length;
      const truePositives = cases.filter(
        (outcome) => outcome.actual === FIRED && outcome.expected === FIRED,
      ).length;
      const falsePositives = cases.filter(
        (outcome) => outcome.actual === FIRED && outcome.expected !== FIRED,
      ).length;
      const falseNegatives = cases.filter(
        (outcome) => outcome.actual !== FIRED && outcome.expected === FIRED,
      ).length;

      const precision = ratio(truePositives, truePositives + falsePositives);
      const recall = ratio(truePositives, truePositives + falseNegatives);
      const f1 =
        precision === null || recall === null || precision + recall === 0
          ? null
          : (2 * precision * recall) / (precision + recall);

      return {
        group,
        cases: cases.length,
        correct,
        accuracy: correct / cases.length,
        precision,
        recall,
        f1,
      };
    })
    .sort((left, right) => left.group.localeCompare(right.group));

  const correct = outcomes.filter((outcome) => outcome.actual === outcome.expected).length;
  return {
    cases: outcomes.length,
    correct,
    // An empty dataset scores zero, not one. "Nothing was checked" must never
    // read as "everything passed".
    accuracy: outcomes.length === 0 ? 0 : correct / outcomes.length,
    groups,
    misses: outcomes.filter((outcome) => outcome.actual !== outcome.expected),
  };
}
