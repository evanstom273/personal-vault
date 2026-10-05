import { browserCallback } from './browser-api';
import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { consentPage, home } from './pages';
export type AuthEnv = Env & {OAUTH_PROVIDER: OAuthHelpers};
const redirect = (headers: Headers, location: string) => {headers.set('Location', location);return new Response(null,{status:302,headers});};
async function challenge(verifier: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export async function authHandler(req: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/' && req.method === 'GET') return new Response(home(env.PUBLIC_ORIGIN), {headers:{'Content-Type':'text/html; charset=utf-8'}});
  if (!['/authorize','/callback'].includes(url.pathname)) return new Response('Not found', {status:404});
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.GITHUB_OWNER_ID) return new Response('Vault connection setup is not complete.', {status:503});
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details,consent.handle),{headers:consent.headers});
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      // Some browsers suppress Origin (or send 'null') under privacy policies.
      // The OAuth library still requires the unpredictable form handle AND its
      // matching HttpOnly browser cookie before approval or denial can proceed.
      const origin = req.headers.get('Origin');
      const site = req.headers.get('Sec-Fetch-Site');
      if ((origin && origin !== 'null' && origin !== env.PUBLIC_ORIGIN) ||
          (site && site !== 'same-origin' && site !== 'none')) {
        return new Response('Invalid origin',{status:403});
      }
      const form = await req.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(req,handle);
        return new Response(null,{status:302,headers:denied.headers});
      }
      const approved = await oauth.approveConsent(req,handle,{scope:['vault']});
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const upstream = await oauth.beginUpstream(approved.request,{data:{verifier},headers:approved.headers});
      const github = new URL('https://github.com/login/oauth/authorize');
      github.search = new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:env.PUBLIC_ORIGIN+'/callback',state:upstream.state,code_challenge:await challenge(verifier),code_challenge_method:'S256',scope:''}).toString();
      return redirect(upstream.headers,github.toString());
    }
    if (url.pathname === '/callback' && req.method === 'GET') {
      if (url.searchParams.get('state')?.startsWith('web_')) return browserCallback(req,env);
      const {request,data,headers} = await oauth.finishUpstream<{verifier:string}>(req);
      const deny = () => redirect(headers,authorizationErrorRedirect(request,'access_denied'));
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) return deny();
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:env.PUBLIC_ORIGIN+'/callback',code_verifier:data.verifier}),signal:AbortSignal.timeout(15000)});
      if (!tokenResponse.ok) return new Response('GitHub sign-in is temporarily unavailable.',{status:502,headers});
      const token = await tokenResponse.json<{access_token?:string}>();
      if (!token.access_token) return deny();
      const userResponse = await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'personal-vault'},signal:AbortSignal.timeout(15000)});
      if (!userResponse.ok) return new Response('GitHub identity verification failed.',{status:502,headers});
      const user = await userResponse.json<{id?:number}>();
      // Stable numeric ID prevents access transferring if a GitHub username is renamed.
      if (!user.id || String(user.id) !== env.GITHUB_OWNER_ID) return deny();
      const completed = await oauth.completeAuthorization({request,userId:String(user.id),metadata:{},scope:['vault'],props:{userId:String(user.id)}});
      return redirect(headers,completed.redirectTo);
    }
    return new Response('Method not allowed',{status:405});
  } catch (err) {
    if (err instanceof AuthorizationError || err instanceof CimdFetchError) return new Response('Authorization expired or invalid. Start the connection again from your MCP client.',{status:400});
    throw err;
  }
}
