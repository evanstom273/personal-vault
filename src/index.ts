import OAuthProvider, { type OAuthResourceAuth, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { authHandler, type AuthEnv } from './auth';
import { handleMcp } from './mcp';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = env.PUBLIC_ORIGIN;
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response('Invalid host',{status:400});
    // Bound bodies before handing them to OAuth / MCP JSON and form parsers.
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 600000) {await reader.cancel();return new Response('Request too large',{status:413});}
        chunks.push(new Uint8Array(chunk.value));
      }
      request = new Request(request,{body:new Blob(chunks)});
    }
    const provider = new OAuthProvider<AuthEnv>({
      apiRoute:'/mcp',
      apiHandler:{async fetch(req,e,context) {
        if (new URL(req.url).pathname !== '/mcp') return new Response('Not found',{status:404});
        const props = context.props as {userId?:string} | undefined;
        const auth = (context as ExecutionContext & {auth?:OAuthResourceAuth}).auth;
        if (!props?.userId || props.userId !== e.GITHUB_OWNER_ID) return new Response('Forbidden',{status:403});
        if (!auth) return new Response('Unauthorized',{status:401});
        if (!auth.scope.includes('vault')) return insufficientScope(auth,['vault']);
        const incomingOrigin = req.headers.get('Origin');
        if (incomingOrigin && incomingOrigin !== origin) return new Response('Invalid origin',{status:403});
        return handleMcp(req,e);
      }},
      defaultHandler:{fetch:authHandler},
      authorizeEndpoint:'/authorize', tokenEndpoint:'/oauth/token', clientRegistrationEndpoint:'/oauth/register',
      scopesSupported:['vault'], requiredScopes:['vault'],
      resourceMetadata:{resource:origin+'/mcp',authorization_servers:[origin]},
      clientIdMetadataDocumentEnabled:true,
      accessTokenTTL:3600, refreshTokenTTL:2592000,
    });
    try {
      const response = await provider.fetch(request,env as AuthEnv,ctx);
      const headers = new Headers(response.headers);
      headers.set('Cache-Control','no-store');
      headers.set('X-Content-Type-Options','nosniff');
      headers.set('Referrer-Policy','same-origin');
      headers.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      return new Response(response.body,{status:response.status,headers});
    } catch {
      // Never log notes, authorization headers, callback codes, or upstream tokens.
      console.error(JSON.stringify({event:'request_failed',path:url.pathname}));
      return new Response('Service temporarily unavailable',{status:500,headers:{'Cache-Control':'no-store'}});
    }
  }
};
