import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supplyChain } from '@mineral/db';
import { pool } from '../../../lib/pool';
import { exact, pct, stamp } from '../../../lib/format';

/**
 * The supply-chain page (report J.11). It shows a chain as what it is: an
 * ordered set of stages, a material at each, who has measured output there, and
 * how concentrated that output is.
 *
 * Every index on this page was computed by the analytics engine and stored as a
 * calculation run. Nothing here works one out (invariant C.9), which is why a
 * stage with no ingested quantities shows a gap rather than a plausible number:
 * a bottleneck is easy to assert and hard to support, so the page says nothing
 * until something has been measured.
 */
export default async function SupplyChainPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const chain = await supplyChain(pool, code);
  if (!chain) notFound();

  const focus = chain.materials.find((material) => material.code === chain.focus);
  const measured = chain.materials.filter((material) => material.producers.length > 0);

  return (
    <>
      <p className="crumbs">
        <Link href="/">Companies</Link> · supply chain
      </p>
      <h1>{focus?.name ?? chain.focus}</h1>
      <p className="sub">
        {chain.materials.length} materials across {chain.stages.length} stages, connected by what
        supplies what. The chain is structure and is seeded; quantities are measurement and arrive
        with a filing behind them.
      </p>

      <h2>The chain</h2>
      <table>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Material</th>
            <th>Elements</th>
            <th>Supplies</th>
            <th className="num">Producers</th>
          </tr>
        </thead>
        <tbody>
          {chain.materials.map((material) => (
            <tr key={material.materialId}>
              <td>
                {material.stage ? (
                  <>
                    <span className="tag">{material.stage.sequenceNo}</span> {material.stage.name}
                  </>
                ) : (
                  <span className="sub">unstaged</span>
                )}
              </td>
              <td>
                {material.code === chain.focus ? (
                  <strong>{material.name}</strong>
                ) : (
                  <Link href={`/supply-chain/${material.code}`}>{material.name}</Link>
                )}
                <div className="sub">{material.description}</div>
              </td>
              <td className="sub">
                {material.elements.map((element) => element.symbol).join(', ') || '--'}
              </td>
              <td className="sub">
                {material.supplies.length === 0
                  ? 'end of chain'
                  : material.supplies.map((downstream) => (
                      <span key={downstream}>
                        <Link href={`/supply-chain/${downstream}`}>{downstream}</Link>{' '}
                      </span>
                    ))}
              </td>
              <td className="num">{material.producers.length || '--'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Where it narrows</h2>
      {measured.length === 0 ? (
        <p className="sub">
          Nothing on this chain has a measured quantity yet, so no concentration index exists. The
          page shows nothing rather than something, because an unmeasured bottleneck is a gap and
          not a small number.
        </p>
      ) : (
        measured.map((material) => {
          const total = material.producers.reduce((sum, row) => sum + row.quantity, 0);
          return (
            <section key={material.materialId}>
              <h3>{material.name}</h3>
              {material.concentration ? (
                <>
                  <p className="sub">
                    {material.concentration.outputs
                      .map((output) => `${output.name} ${exact(output.value)}`)
                      .join(' · ')}
                  </p>
                  <p className="sub">
                    Computed by engine {material.concentration.engineVersion} over{' '}
                    {material.concentration.producerCount} producers from{' '}
                    {material.concentration.factCode.replace(/_/g, ' ')} ·{' '}
                    {stamp(material.concentration.calculatedAt)} · run{' '}
                    <code>{material.concentration.calculationRunId.slice(0, 8)}</code>
                  </p>
                </>
              ) : (
                <p className="sub">
                  {material.producers.length} producers measured, no index stored yet. Run{' '}
                  <code>pnpm chain {material.code} --measure</code>.
                </p>
              )}
              <table>
                <thead>
                  <tr>
                    <th>Producer</th>
                    <th className="num">Quantity</th>
                    <th className="num">Share</th>
                    <th>Period</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {material.producers.map((producer) => (
                    <tr key={producer.factVersionId}>
                      <td>
                        <Link href={`/company/${producer.companyId}`}>
                          {producer.commonName ?? producer.legalName}
                        </Link>
                      </td>
                      <td className="num">
                        {exact(producer.quantity)} {producer.unit ?? ''}
                      </td>
                      <td className="num">{total > 0 ? pct(producer.quantity / total) : '--'}</td>
                      <td className="sub">{producer.periodEnd ?? '--'}</td>
                      <td>
                        {producer.sourceDocumentVersionId ? (
                          <Link href={`/document/${producer.sourceDocumentVersionId}`}>
                            the filing it was read from
                          </Link>
                        ) : (
                          <span className="sub">none</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}

      <h2>End markets</h2>
      <p className="sub">
        {chain.endMarkets.map((market) => market.name).join(' · ') || 'none recorded'}
      </p>
    </>
  );
}
