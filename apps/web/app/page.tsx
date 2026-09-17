import Link from 'next/link';
import { companyList } from '@mineral/db';
import { pool } from '../lib/pool';
import { pct, stamp } from '../lib/format';
import { Verdict } from './ui';

export default async function Home() {
  const companies = await companyList(pool);
  return (
    <>
      <h1>Companies</h1>
      <p className="sub">
        Every figure on a company page is read back from the row that recorded it. Follow one far
        enough and it ends at a filing.
      </p>
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Listing</th>
            <th>Thesis</th>
            <th>Confidence</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => (
            <tr key={company.companyId}>
              <td>
                <Link href={`/company/${company.companyId}`}>
                  {company.commonName ?? company.legalName}
                </Link>
                <div className="sub">{company.legalName}</div>
              </td>
              <td className="num">
                {company.listings.map((listing) => `${listing.mic}:${listing.ticker}`).join(', ') ||
                  '--'}
              </td>
              <td>
                {company.verdict ? (
                  <>
                    <Verdict verdict={company.verdict} />{' '}
                    <span className="sub">v{company.thesisVersionNo}</span>
                  </>
                ) : (
                  <span className="sub">no thesis yet</span>
                )}
              </td>
              <td className="num">{pct(company.confidence)}</td>
              <td className="num sub">{stamp(company.thesisAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Supply chains</h2>
      <p className="sub">
        A company is one position in a chain. <Link href="/supply-chain/ndpr_oxide">NdPr oxide</Link>{' '}
        is the first one modelled: ore to concentrate to separated oxide to metal to alloy to magnet
        to motor.
      </p>
    </>
  );
}
