// Live admission probe for the reviewed catalogue. No account or credentials are used.
const apps = [
  { id: 'com.notion.mcp', name: 'Notion', description: 'Find and update pages in your Notion workspace.', url: 'https://mcp.notion.com/mcp', icon: 'https://www.notion.so/images/favicon.ico' },
  { id: 'com.canva.mcp', name: 'Canva', description: 'Create and manage designs in Canva.', url: 'https://mcp.canva.com/mcp', icon: 'https://www.canva.com/favicon.ico' },
  { id: 'com.linear.mcp', name: 'Linear', description: 'Read and manage issues and projects in Linear.', url: 'https://mcp.linear.app/mcp', icon: 'https://linear.app/favicon.ico' },
  { id: 'com.atlassian.mcp', name: 'Atlassian', description: 'Work with Jira and Confluence content.', url: 'https://mcp.atlassian.com/v1/mcp', icon: 'https://www.atlassian.com/favicon.ico' },
  { id: 'com.figma.mcp', name: 'Figma', description: 'Inspect and work with Figma design files.', url: 'https://mcp.figma.com/mcp', icon: 'https://www.figma.com/favicon.ico' },
  { id: 'com.airtable.mcp', name: 'Airtable', description: 'Find and manage records in Airtable bases.', url: 'https://mcp.airtable.com/mcp', icon: 'https://www.airtable.com/favicon.ico' },
  { id: 'com.monday.mcp', name: 'Monday.com', description: 'Read and manage work in monday.com.', url: 'https://mcp.monday.com/mcp', icon: 'https://monday.com/favicon.ico' },
  { id: 'com.clickup.mcp', name: 'ClickUp', description: 'Find and update tasks in ClickUp.', url: 'https://mcp.clickup.com/mcp', icon: 'https://clickup.com/favicon.ico' },
  { id: 'com.miro.mcp', name: 'Miro', description: 'Find and work with Miro boards.', url: 'https://mcp.miro.com/', icon: 'https://miro.com/favicon.ico' },
  { id: 'com.dropbox.mcp', name: 'Dropbox', description: 'Find and manage files in Dropbox.', url: 'https://mcp.dropbox.com/mcp', icon: 'https://www.dropbox.com/favicon.ico' },
  { id: 'com.calendly.mcp', name: 'Calendly', description: 'Manage scheduling links and events in Calendly.', url: 'https://mcp.calendly.com/mcp', icon: 'https://calendly.com/favicon.ico' },
  { id: 'com.todoist.mcp', name: 'Todoist', description: 'Find and manage tasks in Todoist.', url: 'https://ai.todoist.net/mcp', icon: 'https://todoist.com/favicon.ico' },
];
const get = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000), headers: { accept: 'application/json', ...init?.headers } });
  let body; try { body = await response.json(); } catch {}
  return { response, body };
};
const results = await Promise.all(apps.map(async app => {
  try {
    const { response } = await get(app.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'byokit-directory-probe', version: '1' } } }) });
    if (response.status !== 401) return { ...app, status: response.status, auth: 'rejected', included: false };
    const advertised = response.headers.get('www-authenticate')?.match(/resource_metadata\s*=\s*"([^"]+)"/i)?.[1];
    const resourceUrl = advertised ?? `${new URL(app.url).origin}/.well-known/oauth-protected-resource${new URL(app.url).pathname}`;
    const { body: resource } = await get(resourceUrl);
    if (!resource?.authorization_servers?.length) return { ...app, status: response.status, auth: 'no-resource-metadata', included: false };
    const issuer = resource.authorization_servers[0], base = new URL(issuer);
    const metadataUrl = `${base.origin}/.well-known/oauth-authorization-server${base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')}`;
    const { body: metadata } = await get(metadataUrl);
    const auth = metadata?.registration_endpoint ? 'discovery' : 'registered-client-required';
    return { ...app, status: response.status, resourceMetadata: resourceUrl, issuer, authorizationMetadata: metadataUrl, dcr: !!metadata?.registration_endpoint, auth, included: response.status === 401 && !!metadata?.registration_endpoint };
  } catch (error) { return { ...app, auth: 'probe-error', included: false, error: String(error) }; }
}));
console.log(JSON.stringify(results, null, 2));
if (results.some(result => result.auth === 'probe-error')) process.exitCode = 1;
