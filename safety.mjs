import { readPolicyDecision } from './read-only-policy.mjs';
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function installReadOnlyGuard(context, allowedOrigins) {
  const origins = new Set(allowedOrigins);
  const blocked = [];
  const record = value => { if (blocked.length < 50) blocked.push(value); };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const decision = ['GET', 'HEAD'].includes(request.method()) ? readPolicyDecision(request.url()) : null;
    if (decision?.blocked) {
      record({ kind: 'mutating-read', method: request.method(), origin: url.origin, path: url.pathname, code: decision.code });
      await route.abort('aborted');
    } else if (!safeMethods.has(request.method())) {
      record({ kind: 'write-request', method: request.method(), origin: url.origin, path: url.pathname });
      await route.abort('aborted');
    } else if (request.isNavigationRequest() && !origins.has(url.origin)) {
      record({ kind: 'external-navigation', method: request.method(), origin: url.origin, path: url.pathname });
      await route.abort('aborted');
    } else await route.fallback();
  });
  await context.routeWebSocket('**/*', socket => {
    record({ kind: 'websocket', method: 'WEBSOCKET' });
    socket.close();
  });
  return blocked;
}
