'use strict';

/**
 * v11.3.25 · Phase 8.1 · Lightweight route test-harness.
 *
 * Reviewer Codex #2's H4: "gericht server/db integration tests bouwen op de
 * geldpaden." Dit gebeurt zonder externe deps (supertest niet geïnstalleerd)
 * door Express routers via een mock-req/res te draaien.
 *
 * Pattern:
 *   const router = createBetsRouter({ readBets, deleteBet, ... });
 *   const res = await callRoute(router, { method: 'GET', path: '/bets', user: { id: 'u1' } });
 *   assert.strictEqual(res.statusCode, 200);
 *   assert.deepStrictEqual(res.body.bets, [...]);
 *
 * De harness simuleert alleen het pad dat Express zelf volgt: matcht method+path
 * tegen router.stack, attacheert `req.user`, `req.query`, `req.params`, `req.body`
 * en `req.headers`, en vangt `res.status()`, `res.json()`, `res.send()`.
 *
 * Geen middleware chain (dat zou requireAuth/requireAdmin-mocks nodig hebben);
 * caller moet de route passeren aan requireAdmin als ze die willen testen.
 * Voor auth-aware tests: mount requireAdmin als no-op die `req.user` forwarde.
 */
function callRoute(router, { method = 'GET', path = '/', user = null, query = {}, params = {}, body = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method: method.toUpperCase(),
      url: path,
      path,
      query,
      params,
      body,
      headers,
      user,
      ip: '127.0.0.1',
      get: (name) => headers[String(name).toLowerCase()],
    };
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      ended: false,
      status(code) { this.statusCode = code; return this; },
      setHeader(name, val) { this.headers[String(name).toLowerCase()] = val; return this; },
      getHeader(name) { return this.headers[String(name).toLowerCase()]; },
      json(payload) {
        this.body = payload;
        this.ended = true;
        resolve(this);
        return this;
      },
      send(payload) {
        this.body = payload;
        this.ended = true;
        resolve(this);
        return this;
      },
      end() {
        this.ended = true;
        resolve(this);
        return this;
      },
    };

    // Defer op `router.handle` als aanwezig (werkt met express.Router()), anders
    // fallback op handmatige route-dispatch via router.stack.
    if (typeof router.handle === 'function') {
      try {
        router.handle(req, res, (err) => {
          if (err) return reject(err);
          if (!res.ended) {
            res.statusCode = 404;
            res.body = { error: 'Not Found (harness)' };
            resolve(res);
          }
        });
      } catch (e) {
        reject(e);
      }
      return;
    }

    reject(new Error('router.handle not available — pass an express.Router()'));
  });
}

/**
 * Factory voor een no-op requireAdmin / requireAuth middleware die simpelweg
 * `req.user` doorzet (gebruikt in tests waar auth-rol wordt gemockt via `user`).
 */
function makeNoopAuthMiddleware() {
  return (req, _res, next) => next();
}

module.exports = { callRoute, makeNoopAuthMiddleware };
