// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { createPool } from './client.ts';
import { recordConcentration, supplyChain } from './ontology-repository.ts';
import { DecisionError, type CalcFn } from './decision-repository.ts';

/**
 * Read a supply chain, and measure how concentrated one point in it is.
 *
 *   pnpm chain ndpr_oxide              # the chain around this material
 *   pnpm chain ndpr_oxide --measure    # compute and store the indices
 *
 * Measuring needs the analytics service (pnpm analytics) and needs production
 * quantities already in the record. With nothing measured there is no index,
 * and this says so rather than drawing a chart of nothing.
 */
const args = process.argv.slice(2);
const code = args[0];
const measure = args.includes('--measure');

if (!code || code.startsWith('--')) {
  console.error('usage: pnpm chain <material-code> [--measure]');
  process.exit(2);
}

function httpCalc(baseUrl: string): CalcFn {
  return async (method, inputs, currency) => {
    const response = await fetch(`${baseUrl}/calc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs, currency }),
    }).catch((error: Error) => {
      throw new DecisionError(
        `the analytics service at ${baseUrl} is not answering (${error.message}); start it with pnpm analytics`,
      );
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const detail = (body as { detail?: unknown }).detail ?? body;
      throw new DecisionError(`${method} failed: ${JSON.stringify(detail)}`);
    }
    return body;
  };
}

const pool = createPool();
try {
  if (measure) {
    const calc = httpCalc(process.env.ANALYTICS_URL ?? 'http://127.0.0.1:8000');
    const result = await recordConcentration(pool, { materialCode: code, calc });
    for (const producer of result.producers) {
      console.log(
        `  ${(producer.commonName ?? producer.legalName).padEnd(24)} ` +
          `${producer.quantity} ${producer.unit ?? ''}`,
      );
    }
    for (const output of result.outputs) {
      console.log(`\n${output.code.padEnd(20)} ${output.value}`);
    }
    console.log(`\nrun ${result.calculationRunId}`);
  }

  const chain = await supplyChain(pool, code);
  if (!chain) throw new Error(`no material with code ${code}; try pnpm chain ndpr_oxide`);

  for (const material of chain.materials) {
    const stage = material.stage ? `${material.stage.sequenceNo}. ${material.stage.name}` : 'unstaged';
    console.log(`\n${stage.padEnd(18)} ${material.name} (${material.code})`);
    if (material.supplies.length > 0) {
      console.log(`  supplies           ${material.supplies.join(', ')}`);
    }
    if (material.elements.length > 0) {
      console.log(`  elements           ${material.elements.map((e) => e.symbol).join(', ')}`);
    }
    // Who stands here at all, which is knowable far more often than how much
    // they put out. A stage with operators and no producers is not empty; it
    // is unmeasured, and those are different answers.
    for (const operator of material.operators) {
      console.log(
        `  operates           ${(operator.commonName ?? operator.legalName).padEnd(22)} ` +
          `${operator.name}${operator.status ? ` (${operator.status})` : ''}`,
      );
    }
    for (const producer of material.producers) {
      console.log(
        `  produces           ${(producer.commonName ?? producer.legalName).padEnd(22)} ` +
          `${producer.quantity} ${producer.unit ?? ''}`,
      );
    }
    const indices = material.concentration;
    if (indices) {
      console.log(
        `  concentration      ` +
          indices.outputs.map((output) => `${output.code} ${output.value.toFixed(3)}`).join('  '),
      );
    } else if (material.producers.length > 0) {
      console.log('  concentration      not measured yet; run with --measure');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
