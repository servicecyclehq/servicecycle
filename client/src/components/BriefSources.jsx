/**
 * BriefSources — "Market sources cited" footer below the four BriefSection
 * cards.
 *
 * v0.4.1: APA-ish formatting (Publisher. (Retrieved YYYY, Month D). Title.
 * URL.) and an explicit "Sources retrieved on <date>; market conditions
 * may have shifted" caveat. Persisted in Contract.renewalBriefSources so
 * citations survive page reloads — important because if a user comes back
 * to the brief two weeks later and a market shifts or a link rots, we
 * want them to know exactly when the retrieval happened and not rely on
 * the cited material as current.
 *
 * Source shape: { title, url, retrievedAt (ISO string) }
 * Older briefs (generated before v0.4.1) have empty sources array →
 * component renders nothing.
 */

const DOMAIN_PUBLISHER_LABELS = {
  'vendr.com':            'Vendr',
  'g2.com':               'G2',
  'openviewpartners.com': 'OpenView Partners',
  'commonpaper.com':      'Common Paper',
  'lawinsider.com':       'Law Insider',
  'bvp.com':              'Bessemer Venture Partners',
  'fcc.gov':              'Federal Communications Commission',
  'bls.gov':              'U.S. Bureau of Labor Statistics',
  'itu.int':              'International Telecommunication Union',
  'oecd.org':             'OECD',
  'lightreading.com':     'Light Reading',
  'iii.org':              'Insurance Information Institute',
  'naic.org':             'National Association of Insurance Commissioners',
  'businessinsurance.com':'Business Insurance',
  'fred.stlouisfed.org':  'Federal Reserve Economic Data (FRED)',
  'wtwco.com':            'Willis Towers Watson',
  'cbre.com':             'CBRE',
  'jll.com':              'JLL',
  'cushmanwakefield.com': 'Cushman & Wakefield',
  'compstak.com':         'CompStak',
  'fasb.org':             'Financial Accounting Standards Board (FASB)',
  'gartner.com':          'Gartner',
  'forrester.com':        'Forrester',
  'crn.com':              'CRN',
  'theregister.com':      'The Register',
  'spec.org':             'Standard Performance Evaluation Corporation (SPEC)',
  'iaop.org':             'International Association of Outsourcing Professionals (IAOP)',
  'everestgrp.com':       'Everest Group',
  'idc.com':              'IDC',
  'sievo.com':            'Sievo',
  'sam.gov':              'SAM.gov',
  'eia.gov':              'U.S. Energy Information Administration (EIA)',
  'ferc.gov':             'Federal Energy Regulatory Commission (FERC)',
  'openei.org':           'OpenEI (NREL)',
  'nyiso.com':            'New York ISO',
  'pjm.com':              'PJM Interconnection',
  'ercot.com':            'ERCOT',
  'gsa.gov':              'U.S. General Services Administration',
  'spendmatters.com':     'Spend Matters',
  'procurementleaders.com': 'Procurement Leaders',
  'ardentpartners.com':   'Ardent Partners',
  'ism.org':              'Institute for Supply Management (ISM)',
  'industrialdistribution.com': 'Industrial Distribution',
};

function publisherFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return DOMAIN_PUBLISHER_LABELS[host] || host;
  } catch {
    return '';
  }
}

function fmtRetrievedAt(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch {
    return null;
  }
}

export default function BriefSources({ sources }) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  // All sources from one brief share a retrievedAt (set at generation
  // time). Use the first one for the header caveat — they're all the same.
  const headerDate = fmtRetrievedAt(sources[0]?.retrievedAt);

  return (
    <div
      style={{
        marginTop:  '1rem',
        paddingTop: '0.9rem',
        borderTop:  '1px solid var(--color-border, #eaeaea)',
        fontSize:   '0.82rem',
      }}
    >
      <div
        style={{
          fontWeight:    600,
          color:         'var(--text-secondary, #555)',
          fontSize:      '0.78rem',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom:  4,
        }}
      >
        Market sources cited
      </div>
      {headerDate && (
        <div
          style={{
            fontSize:   '0.75rem',
            fontStyle:  'italic',
            color:      'var(--text-secondary, #888)',
            marginBottom: 8,
          }}
        >
          Retrieved {headerDate}. Market conditions and external content may
          have shifted since then — verify any cited data before relying on it.
        </div>
      )}
      <ol style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--text-secondary, #555)' }}>
        {sources.map((s, i) => {
          const publisher = publisherFromUrl(s.url);
          const date      = fmtRetrievedAt(s.retrievedAt);
          // APA-ish: Publisher. (Retrieved Month D, YYYY). Title. URL.
          return (
            <li key={`${i}-${s.url}`} style={{ marginBottom: 6, lineHeight: 1.5 }}>
              {publisher && <span style={{ fontWeight: 600 }}>{publisher}</span>}
              {publisher && date && <span> (retrieved {date}).</span>}
              {!publisher && date && <span>(retrieved {date}).</span>}
              {s.title && <span> {s.title}.</span>}
              {s.url && (
                <>
                  {' '}
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--color-primary, #1f6feb)',
                      wordBreak: 'break-all',
                      textDecoration: 'none',
                    }}
                  >
                    {s.url}
                  </a>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
