import type { Provider } from './types.ts';
const googleOAuth = { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' };
const googleExtra = { access_type: 'offline', prompt: 'consent' };
export const providers = {
  google: { id: 'google', name: 'Google', oauth: googleOAuth, scopes: ['openid', 'email', 'profile'], extra: googleExtra },
  drive: { id: 'drive', name: 'Google Drive', oauth: googleOAuth, scopes: ['https://www.googleapis.com/auth/drive.file'], extra: googleExtra, mcpUrl: 'https://drivemcp.googleapis.com/mcp/v1' },
  gmail: { id: 'gmail', name: 'Gmail', oauth: googleOAuth, scopes: ['https://www.googleapis.com/auth/gmail.readonly'], extra: googleExtra },
  calendar: { id: 'calendar', name: 'Google Calendar', oauth: googleOAuth, scopes: ['https://www.googleapis.com/auth/calendar.events'], extra: googleExtra },
  notion: { id: 'notion', name: 'Notion', mcpUrl: 'https://mcp.notion.com/mcp' },
  canva: { id: 'canva', name: 'Canva', mcpUrl: 'https://mcp.canva.com/mcp' },
} as const satisfies Record<string, Provider>;
export type ProviderId = keyof typeof providers;
