import {
  PublicClientApplication,
  type AuthenticationResult,
  type Configuration,
  type RedirectRequest,
} from "@azure/msal-browser";
import { MS_AUTHORITY, MS_CLIENT_ID, MS_REDIRECT_URI, MS_SCOPES } from "./config.ts";

let initPromise: Promise<PublicClientApplication | null> | null = null;

export function msalConfigured(): boolean {
  return typeof MS_CLIENT_ID === "string" && MS_CLIENT_ID.length > 0;
}

function buildConfig(): Configuration {
  return {
    auth: {
      clientId: MS_CLIENT_ID,
      authority: MS_AUTHORITY,
      redirectUri: MS_REDIRECT_URI,
      postLogoutRedirectUri: MS_REDIRECT_URI,
    },
    cache: {
      cacheLocation: "localStorage",
      storeAuthStateInCookie: true,
    },
  };
}

export async function getMsal(): Promise<PublicClientApplication | null> {
  if (!msalConfigured()) return null;
  initPromise ??= (async () => {
    const app = new PublicClientApplication(buildConfig());
    await app.initialize();
    return app;
  })();
  return initPromise;
}

export async function handleRedirectPromise(): Promise<AuthenticationResult | null> {
  const app = await getMsal();
  if (!app) return null;
  return app.handleRedirectPromise();
}

export async function connectExcelRedirect(): Promise<void> {
  const app = await getMsal();
  if (!app) throw new Error("Set MS_CLIENT_ID in src/config.ts first.");
  const request: RedirectRequest = {
    scopes: [...MS_SCOPES],
  };
  await app.loginRedirect(request);
}

export async function getGraphToken(): Promise<string | null> {
  const app = await getMsal();
  if (!app) return null;
  const accounts = app.getAllAccounts();
  if (accounts.length === 0) return null;
  try {
    const result = await app.acquireTokenSilent({
      account: accounts[0]!,
      scopes: [...MS_SCOPES],
    });
    return result.accessToken;
  } catch {
    await app.acquireTokenRedirect({
      account: accounts[0]!,
      scopes: [...MS_SCOPES],
    });
    return null;
  }
}

export async function excelAccountLabel(): Promise<string | null> {
  const app = await getMsal();
  if (!app) return null;
  const account = app.getAllAccounts()[0];
  return account?.username ?? null;
}
