import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// Per-account SSO admin config. Gated: admin role + the `sso` account feature
// flag. All writes go to /api/sso/admin/* (server forces the Polis tenant from
// the caller's account — the client never sends a tenant).
export default function SsoSettings() {
  useDocumentTitle('Single sign-on');
  const { user, accountFeatures } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [scimToken, setScimToken] = useState(null); // shown once after creating a directory

  // form state
  const [protocol, setProtocol] = useState('saml');
  const [metadataUrl, setMetadataUrl] = useState('');
  const [oidc, setOidc] = useState({ oidcDiscoveryUrl: '', oidcClientId: '', oidcClientSecret: '' });
  const [domain, setDomain] = useState('');
  const [domainConn, setDomainConn] = useState('');
  const [mapGroup, setMapGroup] = useState('');
  const [mapRole, setMapRole] = useState('viewer');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const res = await api.get('/api/sso/admin/config');
      setCfg(res.data.data);
      if (res.data.data.connections?.[0]) setDomainConn(res.data.data.connections[0].id);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to load SSO configuration.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (accountFeatures?.sso && user?.role === 'admin') load(); else setLoading(false); }, [accountFeatures, user, load]);

  if (user && user.role !== 'admin') return <div className="page"><p>Admin access required.</p></div>;
  if (!accountFeatures?.sso) return <div className="page"><p>Single sign-on is not enabled for this account. Contact ServiceCycle to enable it.</p></div>;
  if (loading) return <div className="page"><p>Loading…</p></div>;

  const act = async (fn) => {
    setErr(''); setNotice('');
    try { await fn(); await load(); } catch (e) { setErr(e.response?.data?.error || 'Request failed.'); }
  };

  const addConnection = () => act(async () => {
    const body = protocol === 'saml' ? { protocol, metadataUrl } : { protocol, ...oidc };
    await api.post('/api/sso/admin/connections', body);
    setNotice('Connection created.'); setMetadataUrl(''); setOidc({ oidcDiscoveryUrl: '', oidcClientId: '', oidcClientSecret: '' });
  });
  const delConnection = (id) => act(() => api.delete(`/api/sso/admin/connections/${id}`));
  const addDomain = () => act(async () => { await api.post('/api/sso/admin/domains', { domain, connectionId: domainConn }); setDomain(''); });
  const delDomain = (id) => act(() => api.delete(`/api/sso/admin/domains/${id}`));
  const addDirectory = () => act(async () => {
    const res = await api.post('/api/sso/admin/directories', {});
    setScimToken(res.data.data.scim); setNotice('SCIM directory created — copy the endpoint + token now; the token is shown only once.');
  });
  const delDirectory = (id) => act(() => api.delete(`/api/sso/admin/directories/${id}`));
  const addMapping = () => act(async () => { await api.post('/api/sso/admin/role-mappings', { idpGroup: mapGroup, role: mapRole }); setMapGroup(''); });
  const delMapping = (id) => act(() => api.delete(`/api/sso/admin/role-mappings/${id}`));
  const setRequired = (v) => act(() => api.put('/api/sso/admin/policy', { ssoRequired: v }));

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <h1>Single sign-on (SSO)</h1>
      <p style={{ color: 'var(--color-text-secondary)' }}>
        Connect your identity provider (Okta, Entra ID, Google Workspace, Ping, JumpCloud) for SSO + automatic
        user provisioning (SCIM). Polis tenant: <code>{cfg?.polisTenant}</code>
      </p>
      {err && <div role="alert" className="alert alert-error">{err}</div>}
      {notice && <div role="status" className="alert alert-success">{notice}</div>}

      <section style={{ marginTop: 24 }}>
        <h2>Connections</h2>
        <ul>
          {(cfg?.connections || []).map((c) => (
            <li key={c.id}>
              <strong>{c.protocol.toUpperCase()}</strong> {c.label ? `— ${c.label}` : ''} {c.isActive ? '' : '(inactive)'}
              <button className="btn btn-link" onClick={() => delConnection(c.id)} style={{ marginLeft: 8 }}>Remove</button>
            </li>
          ))}
          {(!cfg?.connections || cfg.connections.length === 0) && <li style={{ color: 'var(--color-text-secondary)' }}>No connections yet.</li>}
        </ul>
        <div className="form-group">
          <label className="form-label">Protocol</label>
          <select className="form-control" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option value="saml">SAML</option>
            <option value="oidc">OIDC</option>
          </select>
        </div>
        {protocol === 'saml' ? (
          <div className="form-group">
            <label className="form-label">IdP metadata URL</label>
            <input className="form-control" value={metadataUrl} onChange={(e) => setMetadataUrl(e.target.value)} placeholder="https://idp.example.com/app/metadata" />
          </div>
        ) : (
          <>
            <div className="form-group"><label className="form-label">OIDC discovery URL</label>
              <input className="form-control" value={oidc.oidcDiscoveryUrl} onChange={(e) => setOidc({ ...oidc, oidcDiscoveryUrl: e.target.value })} placeholder="https://idp.example.com/.well-known/openid-configuration" /></div>
            <div className="form-group"><label className="form-label">Client ID</label>
              <input className="form-control" value={oidc.oidcClientId} onChange={(e) => setOidc({ ...oidc, oidcClientId: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Client secret</label>
              <input className="form-control" type="password" value={oidc.oidcClientSecret} onChange={(e) => setOidc({ ...oidc, oidcClientSecret: e.target.value })} /></div>
          </>
        )}
        <button className="btn btn-primary" onClick={addConnection}>Add connection</button>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Email domains</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Users with these email domains are routed to your IdP.</p>
        <ul>
          {(cfg?.domains || []).map((d) => (
            <li key={d.id}>{d.domain} <button className="btn btn-link" onClick={() => delDomain(d.id)}>Remove</button></li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="form-control" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="company.com" />
          <select className="form-control" value={domainConn} onChange={(e) => setDomainConn(e.target.value)}>
            {(cfg?.connections || []).map((c) => <option key={c.id} value={c.id}>{c.protocol.toUpperCase()} {c.label || ''}</option>)}
          </select>
          <button className="btn btn-primary" onClick={addDomain} disabled={!domainConn}>Add</button>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>SCIM directory sync</h2>
        <ul>
          {(cfg?.directories || []).map((d) => (
            <li key={d.id}>{d.label || d.type || 'SCIM directory'} <button className="btn btn-link" onClick={() => delDirectory(d.id)}>Remove</button></li>
          ))}
        </ul>
        {scimToken && (
          <div className="alert alert-success" style={{ wordBreak: 'break-all' }}>
            <div><strong>SCIM endpoint:</strong> {scimToken.endpoint || scimToken.path}</div>
            <div><strong>Bearer token (copy now):</strong> <code>{scimToken.token}</code></div>
          </div>
        )}
        <button className="btn btn-primary" onClick={addDirectory}>Create SCIM directory</button>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Group → role mapping</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          Default role: <strong>{cfg?.defaultRole}</strong>. Admin / OEM-admin cannot be granted via SSO.
        </p>
        <ul>
          {(cfg?.roleMappings || []).map((m) => (
            <li key={m.id}>{m.idpGroup} → {m.role} <button className="btn btn-link" onClick={() => delMapping(m.id)}>Remove</button></li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="form-control" value={mapGroup} onChange={(e) => setMapGroup(e.target.value)} placeholder="IdP group name" />
          <select className="form-control" value={mapRole} onChange={(e) => setMapRole(e.target.value)}>
            <option value="viewer">viewer</option>
            <option value="consultant">consultant</option>
            <option value="manager">manager</option>
          </select>
          <button className="btn btn-primary" onClick={addMapping} disabled={!mapGroup}>Add</button>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Enforcement</h2>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={!!cfg?.ssoRequired} onChange={(e) => setRequired(e.target.checked)} />
          Require SSO for this account (a local admin keeps password access for break-glass)
        </label>
      </section>
    </div>
  );
}
