import Link from 'next/link';
import { notFound } from 'next/navigation';
import { companyPage, type ThesisNodeView } from '@mineral/db';
import { pool } from '../../../lib/pool';
import { currentViewer } from '../../../lib/session';
import { startRun } from '../../../lib/actions';
import { day, exact, money, pct, ratio, stamp } from '../../../lib/format';
import { Status, Verdict } from '../../ui';

const GROUPS: [string, string][] = [
  ['CONCLUSION', 'Conclusions'],
  ['DRIVER', 'Drivers'],
  ['RISK', 'Risks'],
  ['CATALYST', 'Catalysts'],
  ['ASSUMPTION', 'Assumptions in the thesis'],
  ['UNKNOWN', 'Open questions'],
];

/** Where a node's anchor leads. Every node has one; that is what makes it a
 *  thesis rather than an opinion (report G, and the J.8 anchoring check). */
function Anchor({ node }: { node: ThesisNodeView }) {
  const anchor = node.anchor;
  if (!anchor) return <span className="sub">unanchored</span>;
  if (anchor.kind === 'claim') {
    return (
      <Link href={`/claim/${anchor.claimId}`}>
        {anchor.claimKey} <span className="sub">({anchor.status})</span>
      </Link>
    );
  }
  if (anchor.kind === 'assumption') {
    return (
      <a href={`#assumption-${anchor.code}`}>
        {anchor.code} = {exact(anchor.value)}
      </a>
    );
  }
  return <a href="#valuation">the valuation run</a>;
}

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await companyPage(pool, id);
  if (!page) notFound();

  const viewer = await currentViewer();
  const { company, thesis, nodes, assumptions, valuation, evidence, changed, runs } = page;
  const grouped = GROUPS.map(
    ([type, label]) => [label, nodes.filter((node) => node.nodeType === type)] as const,
  ).filter(([, list]) => list.length > 0);

  return (
    <>
      <h1>{company.commonName ?? company.legalName}</h1>
      <p className="sub">
        {company.legalName}
        {company.countryCode ? ` · ${company.countryCode}` : ''}
        {company.listings.length > 0
          ? ` · ${company.listings.map((l) => `${l.mic}:${l.ticker}`).join(', ')}`
          : ''}
      </p>

      {thesis ? (
        <div className="panel">
          <p>
            <Verdict verdict={thesis.verdict} />{' '}
            <span className="sub">
              thesis v{thesis.versionNo} · confidence {pct(thesis.confidence)} · as of{' '}
              {day(thesis.asOfDate)} · written {stamp(thesis.createdAt)}
            </span>
          </p>
          <p>{thesis.summary}</p>
          <p className="sub">
            From <Link href={`/run/${thesis.researchRunId}`}>run {thesis.researchRunId.slice(0, 8)}</Link>
          </p>
        </div>
      ) : (
        <div className="panel">
          <p className="sub">
            No thesis yet. Ingest a filing, then start a run; the page fills itself from what the
            run leaves behind.
          </p>
        </div>
      )}

      {changed && (
        <>
          <h2>What changed since v{changed.previousVersionNo}</h2>
          <div className="panel">
            {changed.verdictFrom !== changed.verdictTo && (
              <p>
                Verdict <Verdict verdict={changed.verdictFrom} /> to{' '}
                <Verdict verdict={changed.verdictTo} />
              </p>
            )}
            <p className="sub">
              Confidence {pct(changed.confidenceFrom)} to {pct(changed.confidenceTo)}
            </p>
            {changed.assumptions.map((assumption) => (
              <p key={assumption.code} className="sub">
                {assumption.code}: {exact(assumption.from)} to {exact(assumption.to)}
              </p>
            ))}
            {changed.nodes.length === 0 && changed.assumptions.length === 0 && (
              <p className="sub">The thesis restated itself without changing what it rests on.</p>
            )}
            {changed.nodes.map((node) => (
              <p key={`${node.change}-${node.key}`}>
                <span className={`tag ${node.change === 'removed' ? 'bad' : 'warn'}`}>
                  {node.change}
                </span>{' '}
                {node.nodeType.toLowerCase()} · {node.statement}
                {node.previousStatement && node.change === 'restated' && (
                  <span className="sub"> (was: {node.previousStatement})</span>
                )}
              </p>
            ))}
          </div>
        </>
      )}

      {grouped.map(([label, list]) => (
        <section key={label}>
          <h2>{label}</h2>
          <table>
            <tbody>
              {list.map((node) => (
                <tr key={node.nodeId}>
                  <td>{node.statement}</td>
                  <td className="num">{pct(node.confidence)}</td>
                  <td>
                    <Anchor node={node} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <h2 id="valuation">Valuation</h2>
      {valuation ? (
        <>
          <p className="sub">
            {valuation.method} · {valuation.engine} {valuation.engineVersion} · scenario{' '}
            {valuation.scenarioName ?? '--'} · {stamp(valuation.calculatedAt)}
          </p>
          <table>
            <thead>
              <tr>
                <th>Output</th>
                <th>Value</th>
                <th>Range across scenarios</th>
              </tr>
            </thead>
            <tbody>
              {valuation.outputs.map((output) => (
                <tr key={output.code}>
                  <td>{output.name}</td>
                  <td className="num">{money(output.value, valuation.currency)}</td>
                  <td className="num sub">
                    {money(output.low, valuation.currency)} to{' '}
                    {money(output.high, valuation.currency)}
                    {` (${output.runs} run${output.runs === 1 ? '' : 's'})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 18 }}>What went in</h3>
          <table>
            <thead>
              <tr>
                <th>Input</th>
                <th>Value</th>
                <th>Kind</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {valuation.inputs.map((input) => (
                <tr key={`${input.kind}-${input.code}`}>
                  <td>{input.name}</td>
                  <td className="num">
                    {input.kind === 'fact'
                      ? money(input.value, valuation.currency)
                      : exact(input.value)}
                  </td>
                  <td>
                    <span className="tag">{input.kind}</span>
                  </td>
                  <td>
                    {input.sourceDocumentVersionId ? (
                      <Link href={`/document/${input.sourceDocumentVersionId}`}>
                        the filing it was read from
                      </Link>
                    ) : (
                      <a href={`#assumption-${input.code}`}>approved assumption</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="sub">
          Nothing valued yet. A valuation needs approved assumptions and a promoted cash-flow fact.
        </p>
      )}

      <h2>Assumptions</h2>
      {assumptions.length === 0 ? (
        <p className="sub">No assumptions proposed for this company yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Value</th>
              <th>Range</th>
              <th>Status</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            {assumptions.map((assumption) => (
              <tr key={assumption.assumptionVersionId} id={`assumption-${assumption.code}`}>
                <td>
                  {assumption.code}
                  <div className="sub">
                    v{assumption.versionNo} · proposed by {assumption.proposedBy}
                    {assumption.approvedBy ? ` · approved by ${assumption.approvedBy}` : ''}
                  </div>
                </td>
                <td className="num">{ratio(assumption.value, assumption.unit)}</td>
                <td className="num sub">
                  {assumption.minValue === null && assumption.maxValue === null
                    ? '--'
                    : `${exact(assumption.minValue)} to ${exact(assumption.maxValue)}`}
                </td>
                <td>
                  <Status status={assumption.status} />{' '}
                  {assumption.inScenario && <span className="tag good">in scenario</span>}
                </td>
                <td>
                  {assumption.sourceClaimId ? (
                    <Link href={`/claim/${assumption.sourceClaimId}`}>
                      {assumption.sourceClaimKey}
                    </Link>
                  ) : (
                    <span className="sub">--</span>
                  )}
                  {assumption.rationale && <div className="sub">{assumption.rationale}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Evidence</h2>
      <div className="panel counts">
        <div>
          <div className="n">{evidence.claims}</div>
          <div className="k">claims in this run</div>
        </div>
        <div>
          <div className="n">{evidence.citations}</div>
          <div className="k">citations</div>
        </div>
        <div>
          <div className="n">{evidence.documents}</div>
          <div className="k">documents</div>
        </div>
        <div>
          <div className="n">{evidence.chunks}</div>
          <div className="k">chunks</div>
        </div>
        <div>
          <div className="n">{evidence.promotedFacts}</div>
          <div className="k">promoted facts</div>
        </div>
      </div>
      {evidence.claimsByStatus.length > 0 && (
        <p className="sub">
          {evidence.claimsByStatus.map((row) => `${row.count} ${row.status}`).join(' · ')}
        </p>
      )}

      <h2>Runs</h2>
      {viewer ? (
        <form action={startRun} className="inline">
          <input type="hidden" name="companyId" value={company.companyId} />
          <button type="submit">Start a run</button>
        </form>
      ) : (
        <p className="sub">
          <Link href="/sign-in">Sign in</Link> to start a run. Reading needs no account; starting one
          spends money on model calls, so it does.
        </p>
      )}
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Run</th>
            <th>As of</th>
            <th>Status</th>
            <th>Claims</th>
            <th>Requested</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId}>
              <td>
                <Link href={`/run/${run.runId}`}>{run.runId.slice(0, 8)}</Link>
              </td>
              <td className="num">{day(run.asOfDate)}</td>
              <td>
                <Status status={run.status} />
              </td>
              <td className="num">{run.claims}</td>
              <td className="num sub">{stamp(run.requestedAt)}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5} className="sub">
                No runs yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
