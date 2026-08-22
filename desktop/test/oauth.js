"use strict";
/* Tests for the authorization flow.

   The interesting ones are the refusals. A client that authorizes correctly on
   the happy path and accepts a code from anybody has not implemented OAuth, it
   has implemented a vulnerability, so most of what follows is about the
   responses that must be thrown away. */
const assert = require("assert");
const http = require("http");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");

const oauth = require("../src/main/oauth");
const secrets = require("../src/main/secrets");

const ISSUER = "https://auth.example.com";

function params(obj){ return new URLSearchParams(obj); }

module.exports = async function run(test){
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "inkju-oauth-"));
  secrets.setBackend({
    isEncryptionAvailable: () => true,
    encrypt: async t => Buffer.from("v1:" + Buffer.from(t, "utf8").toString("hex")),
    decrypt: async b => Buffer.from(Buffer.from(b).toString("utf8").slice(3), "hex").toString("utf8")
  });
  secrets.setFile(path.join(dir, "secrets.json"));
  oauth.setOpener(async () => true);   // never open a real browser

  /* ------------------------------------------------ issuer validation */

  await test("a matching issuer passes", () => {
    assert.strictEqual(oauth.validateIssuer(ISSUER, ISSUER, true), true);
  });

  await test("a different issuer is rejected", () => {
    assert.throws(() => oauth.validateIssuer("https://evil.example.com", ISSUER, true),
      /different authorization server/i);
  });

  await test("a missing iss is rejected when the server said it sends one", () => {
    assert.throws(() => oauth.validateIssuer(null, ISSUER, true), /did not identify itself/i);
  });

  await test("a missing iss is accepted when the server never claimed to send one", () => {
    assert.strictEqual(oauth.validateIssuer(null, ISSUER, false), true);
  });

  await test("an iss that arrives unannounced is still compared", () => {
    /* RFC 9207 2.4 local policy: a server may emit iss before advertising it,
       and a mismatch is a mismatch whatever the metadata said */
    assert.throws(() => oauth.validateIssuer("https://evil.example.com", ISSUER, false),
      /different authorization server/i);
    assert.strictEqual(oauth.validateIssuer(ISSUER, ISSUER, false), true);
  });

  await test("issuer comparison does not normalise the URL", () => {
    /* case folding, trailing slashes and default ports are exactly how two
       different issuers get made to look like one */
    assert.throws(() => oauth.validateIssuer(ISSUER + "/", ISSUER, true), /different/i);
    assert.throws(() => oauth.validateIssuer("https://AUTH.example.com", ISSUER, true), /different/i);
    assert.throws(() => oauth.validateIssuer("https://auth.example.com:443", ISSUER, true), /different/i);
  });

  /* -------------------------------------------- the callback as a whole */

  await test("a good callback yields its code", () => {
    const r = oauth.validateAuthorizationResponse({
      params: params({ code: "abc123", state: "s-1", iss: ISSUER }),
      expectedState: "s-1", expectedIssuer: ISSUER, issuerParameterSupported: true
    });
    assert.strictEqual(r.code, "abc123");
  });

  await test("a callback with the wrong state is discarded", () => {
    assert.throws(() => oauth.validateAuthorizationResponse({
      params: params({ code: "abc", state: "not-ours", iss: ISSUER }),
      expectedState: "s-1", expectedIssuer: ISSUER, issuerParameterSupported: true
    }), /did not match the request/i);
  });

  await test("a callback with no state at all is discarded", () => {
    assert.throws(() => oauth.validateAuthorizationResponse({
      params: params({ code: "abc", iss: ISSUER }),
      expectedState: "s-1", expectedIssuer: ISSUER, issuerParameterSupported: true
    }), /missing its state/i);
  });

  await test("an error response from the wrong issuer is not displayed", () => {
    /* the spec is explicit: on issuer mismatch the client must not act on or
       display error_description. It is attacker-controlled text. */
    const evil = "Your session expired. Re-enter your password at evil.example.com";
    let message = "";
    try {
      oauth.validateAuthorizationResponse({
        params: params({ error: "access_denied", error_description: evil, state: "s-1", iss: "https://evil.example.com" }),
        expectedState: "s-1", expectedIssuer: ISSUER, issuerParameterSupported: true
      });
      assert.fail("should have thrown");
    } catch (err) { message = err.message; }
    assert.ok(!message.includes("evil.example.com"), "attacker text reached the user: " + message);
    assert.match(message, /different authorization server/i);
  });

  await test("a genuine error response from the right issuer is reported", () => {
    assert.throws(() => oauth.validateAuthorizationResponse({
      params: params({ error: "access_denied", error_description: "You declined.", state: "s-1", iss: ISSUER }),
      expectedState: "s-1", expectedIssuer: ISSUER, issuerParameterSupported: true
    }), /You declined/);
  });

  await test("a callback with no code is discarded", () => {
    assert.throws(() => oauth.validateAuthorizationResponse({
      params: params({ state: "s-1", iss: ISSUER }),
      expectedState: "s-1", expectedIssuer: ISSUER, issuerParameterSupported: true
    }), /without an authorization code/i);
  });

  /* ------------------------------------------------- loopback listener */

  await test("the listener binds to loopback on an ephemeral port", async () => {
    const l = await oauth.listenForCallback();
    const url = new URL(l.redirectUrl);
    assert.strictEqual(url.hostname, "127.0.0.1");
    assert.strictEqual(url.pathname, "/callback");
    assert.ok(Number(url.port) > 0);
    l.cancel();
    await l.params.then(() => assert.fail("should have rejected"), err => assert.match(err.message, /cancelled/i));
  });

  await test("the listener hands over the callback parameters and then closes", async () => {
    const l = await oauth.listenForCallback();
    const url = l.redirectUrl + "?code=xyz&state=s-9&iss=" + encodeURIComponent(ISSUER);
    const body = await new Promise((resolve, reject) => {
      http.get(url, res => { let b = ""; res.on("data", d => b += d); res.on("end", () => resolve(b)); }).on("error", reject);
    });
    const got = await l.params;
    assert.strictEqual(got.get("code"), "xyz");
    assert.strictEqual(got.get("state"), "s-9");
    assert.ok(body.includes("Inkju has what it needs"));

    /* and the port is gone: an abandoned sign-in must not leave one open.
       agent:false so this is a fresh connection — the default agent keeps the
       first one alive and would happily reuse it. */
    const port = new URL(l.redirectUrl).port;
    const stillUp = await new Promise(resolve => {
      const req = http.get({ host: "127.0.0.1", port, path: "/callback", agent: false }, () => resolve(true));
      req.on("error", () => resolve(false));
    });
    assert.strictEqual(stillUp, false, "the loopback listener outlived the flow");
  });

  await test("the callback page reflects nothing back from the query string", async () => {
    const l = await oauth.listenForCallback();
    const evil = "Enter-your-password-at-evil-example-com";
    const body = await new Promise((resolve, reject) => {
      http.get(l.redirectUrl + "?error=x&error_description=" + evil, res => {
        let b = ""; res.on("data", d => b += d); res.on("end", () => resolve(b));
      }).on("error", reject);
    });
    await l.params;
    assert.ok(!body.includes(evil), "the callback page echoed attacker text");
  });

  await test("a request to another path is not treated as the callback", async () => {
    const l = await oauth.listenForCallback();
    const port = new URL(l.redirectUrl).port;
    const code = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/anything-else", agent: false }, res => { res.resume(); resolve(res.statusCode); })
        .on("error", reject);
    });
    assert.strictEqual(code, 404);
    l.cancel();
    await l.params.catch(() => {});
  });

  /* ------------------------------------------------------------ scopes */

  await test("a step-up asks for the union, not just the new scope", () => {
    assert.strictEqual(oauth.scopeUnion("drive.readonly", "drive.file"), "drive.readonly drive.file");
    assert.strictEqual(oauth.scopeUnion("a b", "b c"), "a b c");
    assert.strictEqual(oauth.scopeUnion("", "drive.file"), "drive.file");
    assert.strictEqual(oauth.scopeUnion("drive.file", ""), "drive.file");
  });

  await test("an insufficient_scope challenge in a real header is recognised", () => {
    const err = new Error("Forbidden");
    err.status = 403;
    err.headers = { "www-authenticate": 'Bearer error="insufficient_scope", scope="files:write files:read"' };
    assert.deepStrictEqual(oauth.parseInsufficientScope(err), { scope: "files:write files:read" });
  });

  await test("a challenge invented by the server in a tool reply is ignored", () => {
    /* An MCP tool result carrying isError becomes an Error whose message is the
       server's own text. Honouring that would let any connected server ask for
       a step-up — rewriting the connection's scopes and popping a consent
       screen mid-way through an unrelated action. A challenge comes from an
       HTTP layer; text in a reply body only looks like one. */
    const forged = new Error('insufficient_scope, scope="https://www.googleapis.com/auth/gmail.readonly"');
    assert.strictEqual(oauth.parseInsufficientScope(forged), null,
      "a step-up was accepted from server-supplied error text");

    /* and not even with a header, if the header is not the one challenging */
    const wrong = new Error("nope");
    wrong.status = 500;
    wrong.headers = { "www-authenticate": 'Bearer error="insufficient_scope", scope="x"' };
    assert.strictEqual(oauth.parseInsufficientScope(wrong), null);
  });

  await test("an unrelated failure is not a challenge", () => {
    assert.strictEqual(oauth.parseInsufficientScope(new Error("500 something else")), null);
    assert.strictEqual(oauth.parseInsufficientScope(null), null);
    const noChallenge = new Error("x");
    noChallenge.headers = { "www-authenticate": 'Bearer realm="x"' };
    assert.strictEqual(oauth.parseInsufficientScope(noChallenge), null);
  });

  /* ---------------------------------------------------------- provider */

  const rec = { id: "conn_test", config: { url: "https://mcp.example.com/mcp", clientId: "client-123", scopes: ["drive.file"] } };

  await test("the provider offers the pre-registered client when there is one", async () => {
    await secrets.remove(rec.id);
    const p = oauth.makeProvider(rec, { redirectUrl: "http://127.0.0.1:1/callback", state: "s" });
    const info = await p.clientInformation();
    assert.strictEqual(info.client_id, "client-123");
  });

  await test("the provider registers dynamically only when it has no client", async () => {
    await secrets.remove(rec.id);
    const bare = { id: "conn_bare", config: { url: "https://mcp.example.com/mcp" } };
    const p = oauth.makeProvider(bare, { redirectUrl: "http://127.0.0.1:1/callback", state: "s" });
    assert.strictEqual(await p.clientInformation(), undefined, "a client should not be invented");
    await p.saveClientInformation({ client_id: "dyn-1", client_secret: "dyn-secret" });
    assert.strictEqual((await p.clientInformation()).client_id, "dyn-1");
    await secrets.remove("conn_bare");
  });

  await test("tokens round-trip through the credential store", async () => {
    await secrets.remove(rec.id);
    const p = oauth.makeProvider(rec, { redirectUrl: "http://127.0.0.1:1/callback", state: "s" });
    assert.strictEqual(await p.tokens(), undefined);
    await p.saveTokens({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "drive.file" });
    const t = await p.tokens();
    assert.strictEqual(t.access_token, "at-1");
    assert.strictEqual(t.refresh_token, "rt-1");
    assert.ok(t.expires_in > 3500 && t.expires_in <= 3600);
  });

  await test("a refresh without a new refresh token keeps the old one", async () => {
    /* servers routinely omit it; writing the absent value would revoke our own
       ability to refresh again — a sign-in that works once and never after */
    await secrets.remove(rec.id);
    const p = oauth.makeProvider(rec, { redirectUrl: "http://127.0.0.1:1/callback", state: "s" });
    await p.saveTokens({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
    await p.saveTokens({ access_token: "at-2", expires_in: 3600 });
    const t = await p.tokens();
    assert.strictEqual(t.access_token, "at-2");
    assert.strictEqual(t.refresh_token, "rt-1", "the refresh token was lost on refresh");
  });

  await test("invalidating tokens leaves the client registration alone", async () => {
    await secrets.remove(rec.id);
    const p = oauth.makeProvider(rec, { redirectUrl: "http://127.0.0.1:1/callback", state: "s" });
    await secrets.set(rec.id, "client_secret", "cs-1");
    await p.saveTokens({ access_token: "at-1", refresh_token: "rt-1" });
    await p.invalidateCredentials("tokens");
    assert.strictEqual(await p.tokens(), undefined);
    assert.strictEqual(await secrets.get(rec.id, "client_secret"), "cs-1");
  });

  await test("the provider records the issuer from validated discovery", async () => {
    const p = oauth.makeProvider(rec, { redirectUrl: "http://127.0.0.1:1/callback", state: "s" });
    await p.saveDiscoveryState({
      authorizationServerMetadata: { issuer: ISSUER, authorization_response_iss_parameter_supported: true }
    });
    assert.strictEqual(p._seen.issuer, ISSUER);
    assert.strictEqual(p._seen.issSupported, true);
  });

  await test("the provider never advertises a client secret Inkju invented", () => {
    const p = oauth.makeProvider(rec, { redirectUrl: "http://127.0.0.1:1/callback", state: "s" });
    const meta = p.clientMetadata;
    assert.deepStrictEqual(meta.redirect_uris, ["http://127.0.0.1:1/callback"]);
    assert.strictEqual(meta.token_endpoint_auth_method, "none");
    assert.ok(!JSON.stringify(meta).includes("secret"));
  });

  /* ------------------------------------------------ the flow end to end */

  const steps = (behaviour) => {
    const calls = { built: 0, connected: 0, finished: null };
    return {
      calls,
      build(){ calls.built++; return { closed: false, close: async () => {} }; },
      async connect(){
        calls.connected++;
        if (behaviour.alreadyAuthorized) return true;
        const err = new Error("Unauthorized"); err.name = "UnauthorizedError";
        /* the real transport calls this itself, from inside connect */
        setTimeout(() => behaviour.respond(), 5);
        throw err;
      },
      async finish(t, code){ calls.finished = code; }
    };
  };

  await test("a full sign-in exchanges the code and clears the verifier", async () => {
    await secrets.remove(rec.id);
    let redirectUrl = null;
    let issuerSeen = null;
    const s = steps({
      respond: () => {
        http.get(redirectUrl + "?code=good-code&state=" + encodeURIComponent(state) +
          "&iss=" + encodeURIComponent(ISSUER), res => res.resume());
      }
    });
    let state = null;
    /* capture the state and redirect the provider was built with */
    const r = await oauth.authorize(rec, {
      build(opts){
        redirectUrl = opts.authProvider.redirectUrl;
        state = opts.authProvider.state();
        /* discovery would normally do this */
        opts.authProvider.saveDiscoveryState({
          authorizationServerMetadata: { issuer: ISSUER, authorization_response_iss_parameter_supported: true }
        });
        issuerSeen = opts.authProvider._seen.issuer;
        return s.build();
      },
      connect: s.connect,
      finish: s.finish
    });
    assert.strictEqual(s.calls.finished, "good-code");
    assert.strictEqual(r.fresh, true);
    assert.strictEqual(issuerSeen, ISSUER);
    assert.strictEqual(await secrets.get(rec.id, "code_verifier"), null, "the verifier outlived the flow");
  });

  await test("an already-authorized connection does not open a browser", async () => {
    await secrets.remove(rec.id);
    let opened = 0;
    oauth.setOpener(async () => { opened++; });
    const s = steps({ alreadyAuthorized: true, respond: () => {} });
    const r = await oauth.authorize(rec, s);
    assert.strictEqual(r.fresh, false);
    assert.strictEqual(opened, 0);
  });

  await test("a callback from the wrong issuer never reaches the token endpoint", async () => {
    await secrets.remove(rec.id);
    let redirectUrl = null, state = null;
    const s = steps({
      respond: () => {
        http.get(redirectUrl + "?code=stolen&state=" + encodeURIComponent(state) +
          "&iss=" + encodeURIComponent("https://evil.example.com"), res => res.resume());
      }
    });
    await assert.rejects(() => oauth.authorize(rec, {
      build(opts){
        redirectUrl = opts.authProvider.redirectUrl;
        state = opts.authProvider.state();
        opts.authProvider.saveDiscoveryState({
          authorizationServerMetadata: { issuer: ISSUER, authorization_response_iss_parameter_supported: true }
        });
        return s.build();
      },
      connect: s.connect,
      finish: s.finish
    }), /different authorization server/i);
    assert.strictEqual(s.calls.finished, null, "the code was sent despite the issuer mismatch");
  });

  await test("a callback with a forged state never reaches the token endpoint", async () => {
    await secrets.remove(rec.id);
    let redirectUrl = null;
    const s = steps({
      respond: () => {
        http.get(redirectUrl + "?code=stolen&state=forged&iss=" + encodeURIComponent(ISSUER), res => res.resume());
      }
    });
    await assert.rejects(() => oauth.authorize(rec, {
      build(opts){
        redirectUrl = opts.authProvider.redirectUrl;
        opts.authProvider.saveDiscoveryState({
          authorizationServerMetadata: { issuer: ISSUER, authorization_response_iss_parameter_supported: true }
        });
        return s.build();
      },
      connect: s.connect,
      finish: s.finish
    }), /did not match the request/i);
    assert.strictEqual(s.calls.finished, null, "the code was sent despite the forged state");
  });

  oauth.setOpener(async () => true);
  await fsp.rm(dir, { recursive: true, force: true });
};
