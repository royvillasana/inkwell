"use strict";
/* ===========================================================================
   Authorization for HTTP connections, following the MCP authorization spec.

   The SDK does most of the protocol: it discovers the authorization server
   through RFC 9728 protected resource metadata, tries both RFC 8414 and
   OpenID Connect discovery, generates the PKCE pair, sends the RFC 8707
   `resource` parameter, and exchanges the code. What it does not do, in the
   1.x line, is validate the RFC 9207 `iss` parameter on the authorization
   response — so that check lives here, and it happens before the code is sent
   to any token endpoint. Skipping it is how a client gets talked into handing
   an authorization code to the wrong authorization server.

   Two other things are deliberately ours rather than the SDK's:

   * The redirect is a loopback listener, not a custom inkju:// scheme. It is
     the native-app norm (RFC 8252), needs no registration with the OS, and
     cannot be claimed by another application that fancies the same scheme.
     The listener is bound to 127.0.0.1, exists for exactly one flow, and is
     torn down whether that flow succeeds, fails, or is abandoned.

   * The authorization page opens in the user's real browser. Never in a
     BrowserWindow: a login page inside the app is a login page the app could
     read, and it hides the address bar the user needs to check.
   =========================================================================== */
const http = require("http");
const crypto = require("crypto");

const secrets = require("./secrets");

/* Injected so this module can be tested without Electron. */
let openExternal = null;
function setOpener(fn){ openExternal = fn; }
function open(url){
  if (openExternal) return openExternal(url);
  return require("electron").shell.openExternal(url);
}

const CALLBACK_PATH = "/callback";
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STEP_UP_ATTEMPTS = 3;

/* ------------------------------------------------------- pure validation */

/* RFC 9207 section 2.4, with the table from the MCP spec:

     supported | iss present | action
     ----------+-------------+----------------------------------
     true      | yes         | compare
     true      | no          | reject
     false     | yes         | compare anyway
     false     | no          | proceed

   The comparison is simple string comparison (RFC 3986 6.2.1). No case
   folding, no default-port elision, no trailing-slash or percent-encoding
   normalisation — normalising here is how two different issuers are made to
   look like one. */
function validateIssuer(received, expected, supported){
  const present = received != null && received !== "";
  if (supported && !present) {
    throw new Error("That sign-in could not be verified: the authorization server did not identify itself.");
  }
  if (!present) return true;
  if (!expected) {
    throw new Error("That sign-in could not be verified: Inkju does not know which authorization server it asked.");
  }
  if (String(received) !== String(expected)) {
    throw new Error("That sign-in came back from a different authorization server than the one Inkju asked. It has been discarded.");
  }
  return true;
}

/* Everything that has to be true about a callback before the code is worth
   anything. Note the order: state and issuer are checked before the error
   parameters are so much as looked at, because the spec is explicit that a
   response failing issuer validation must not have its error_description
   displayed — an attacker-controlled string is still attacker-controlled
   when it arrives inside an error. */
function validateAuthorizationResponse(opts){
  const params = opts.params || {};
  const get = k => (typeof params.get === "function" ? params.get(k) : params[k]);

  if (opts.expectedState) {
    const state = get("state");
    if (!state) throw new Error("That sign-in is missing its state value and has been discarded.");
    /* constant time: the state is the CSRF defence, and comparing it with ===
       leaks its prefix to anything that can time the reply */
    const a = Buffer.from(String(state));
    const b = Buffer.from(String(opts.expectedState));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error("That sign-in did not match the request Inkju made and has been discarded.");
    }
  }

  validateIssuer(get("iss"), opts.expectedIssuer, !!opts.issuerParameterSupported);

  const error = get("error");
  if (error) {
    const description = get("error_description");
    throw new Error("The authorization server refused: " + String(description || error));
  }

  const code = get("code");
  if (!code) throw new Error("That sign-in came back without an authorization code.");
  return { code: String(code) };
}

/* Step-up: the union of what we asked for before and what the server is now
   demanding. Asking only for the new scope is how a client loses the
   permissions it already had halfway through a session. */
function scopeUnion(previous, challenged){
  const split = s => String(s || "").split(/\s+/).filter(Boolean);
  return Array.from(new Set(split(previous).concat(split(challenged)))).join(" ");
}

/* Pull the scope out of a WWW-Authenticate challenge on a 403.

   Only ever out of the header. The first version of this fell back to the
   error's message when there was no header, which quietly made a step-up
   something the *other end* could ask for: an MCP tool result carrying
   `isError` becomes an Error whose message is the server's own text, so any
   connected server could put the words `insufficient_scope` in a tool reply and
   have Inkju rewrite that connection's scopes and open a consent screen — in
   the middle of an unrelated action, when nobody has any reason to read it
   closely. A challenge is a thing an HTTP layer produces. Text in a reply body
   is not a challenge, however much it looks like one.

   With no header there is no step-up, and the original error is reported. That
   is the right way for this to fail. */
function parseInsufficientScope(err){
  const headers = err && err.headers;
  const header = headers && (headers["www-authenticate"] || headers["WWW-Authenticate"]);
  if (!header) return null;
  const text = String(header);
  if (!/insufficient_scope/i.test(text)) return null;
  /* and only a status that means it: 401 or 403, when we can see one */
  const status = err && (err.status || err.statusCode);
  if (status && status !== 401 && status !== 403) return null;
  const m = /scope\s*=\s*"([^"]*)"/i.exec(text);
  return { scope: m ? m[1] : "" };
}

/* ------------------------------------------------------ loopback listener */

/* One flow, one listener, an ephemeral port, bound to loopback only. It closes
   itself on success, on failure, and on the timeout — an abandoned sign-in must
   not leave a port open for the rest of the session. */
function listenForCallback(){
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;
    let waiter = null;

    /* close() only stops the listener accepting new connections; the browser's
       keep-alive socket from the callback request keeps the server — and the
       port — alive behind it. Drop those too, or an abandoned sign-in leaves a
       loopback port answering for the rest of the session. */
    const shut = () => {
      try { server.close(); } catch (err) { /* already closed */ }
      try { server.closeAllConnections(); } catch (err) { /* older node */ }
    };

    server.on("request", (req, res) => {
      let url;
      try { url = new URL(req.url, "http://127.0.0.1"); }
      catch (err) { res.writeHead(400).end("Bad request"); return; }
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(404).end("Not found"); return; }

      /* The page the user is left looking at. Static, self-contained, and it
         carries none of the query string — reflecting an attacker-supplied
         error_description back into a page is a way to make the app render
         someone else's text. */
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"
      });
      res.end("<!doctype html><meta charset=utf-8><title>Inkju</title>" +
        "<body style=\"font:16px/1.6 -apple-system,system-ui,sans-serif;margin:14vh auto;max-width:30rem;text-align:center;color:#2a2a2a\">" +
        "<p>Inkju has what it needs.</p><p style=\"opacity:.6\">You can close this tab and go back to the app.</p>");

      if (settled) return;
      settled = true;
      const params = url.searchParams;
      shut();
      if (waiter) waiter.resolve(params);
    });

    server.on("error", err => { shut(); reject(err); });

    /* port 0: the OS picks a free one. Host is explicit — binding to 0.0.0.0
       would put the callback on the network. */
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUrl = "http://127.0.0.1:" + port + CALLBACK_PATH;

      const result = new Promise((res2, rej2) => { waiter = { resolve: res2, reject: rej2 }; });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        shut();
        waiter.reject(new Error("That sign-in was not finished in time. Try connecting again."));
      }, FLOW_TIMEOUT_MS);

      /* A cancelled flow rejects this promise, and the caller does not always
         await it — a connection that turned out to be authorized already never
         reaches the callback. An unhandled rejection in Electron's main process
         is not a warning, it ends the app, so a no-op handler is attached to
         the promise we actually hand out. That changes nothing for a caller
         that does await it: a promise may have as many handlers as it likes.
         It has to be this derived promise rather than `result` — .finally()
         returns a new promise, and the rejection would be unhandled on that. */
      const params = result.finally(() => clearTimeout(timer));
      params.catch(() => {});

      resolve({
        redirectUrl,
        params,
        cancel: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          shut();
          waiter.reject(new Error("That sign-in was cancelled."));
        }
      });
    });
  });
}

/* ---------------------------------------------------------------- provider */

/* The SDK's OAuthClientProvider, backed by the credential store.

   Client registration precedence, as the spec sets it out: a pre-registered
   client if the user gave us one — which is the Google Drive case, where the
   user brings their own OAuth client — and dynamic registration only as the
   deprecated fallback for servers that offer nothing else. An embedded client
   secret shipped inside a distributed desktop app is not a secret, so there is
   no third option where Inkju supplies one. */
function makeProvider(rec, opts){
  const o = opts || {};
  const id = rec.id;
  const cfg = rec.config || {};

  /* Recorded from discovery so the callback can be checked against it. */
  const seen = { issuer: null, issSupported: false };

  return {
    get redirectUrl(){ return o.redirectUrl; },

    get clientMetadata(){
      return {
        client_name: "Inkju",
        redirect_uris: [o.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: cfg.clientSecretStored ? "client_secret_post" : "none",
        /* A step-up hands its scopes in here rather than through the record.
           They last for this one authorization and are never written down. */
        scope: (o.extraScope || (cfg.scopes || []).join(" ")) || undefined
      };
    },

    state(){
      if (!o.state) throw new Error("This sign-in has no state value.");
      return o.state;
    },

    async clientInformation(){
      const clientId = cfg.clientId || await secrets.get(id, "client_id");
      if (!clientId) return undefined;
      const clientSecret = await secrets.get(id, "client_secret");
      const info = { client_id: String(clientId) };
      if (clientSecret) info.client_secret = clientSecret;
      return info;
    },

    /* Only reached when a server offers nothing but dynamic registration. */
    async saveClientInformation(info){
      if (info.client_id) await secrets.set(id, "client_id", info.client_id);
      if (info.client_secret) await secrets.set(id, "client_secret", info.client_secret);
    },

    async tokens(){
      const access = await secrets.get(id, "access_token");
      if (!access) return undefined;
      const out = { access_token: access, token_type: "Bearer" };
      const refresh = await secrets.get(id, "refresh_token");
      if (refresh) out.refresh_token = refresh;
      const expires = await secrets.get(id, "expires_at");
      if (expires) out.expires_in = Math.max(0, Math.round((Number(expires) - Date.now()) / 1000));
      const scope = await secrets.get(id, "scope");
      if (scope) out.scope = scope;
      return out;
    },

    async saveTokens(tokens){
      await secrets.set(id, "access_token", tokens.access_token);
      /* A refresh is only replaced when a new one arrives. Many servers omit it
         on refresh, and writing the absent value would revoke our own ability
         to refresh again — a sign-in that works once and then never does. */
      if (tokens.refresh_token) await secrets.set(id, "refresh_token", tokens.refresh_token);
      if (tokens.scope) await secrets.set(id, "scope", tokens.scope);
      if (tokens.expires_in) {
        await secrets.set(id, "expires_at", String(Date.now() + Number(tokens.expires_in) * 1000));
      }
      if (o.onTokens) o.onTokens();
    },

    async saveCodeVerifier(verifier){ await secrets.set(id, "code_verifier", verifier); },
    async codeVerifier(){
      const v = await secrets.get(id, "code_verifier");
      if (!v) throw new Error("This sign-in is missing its verifier. Start again.");
      return v;
    },

    /* Discovery result. The issuer recorded here is what the callback is
       checked against, and it comes from validated metadata — not from the
       redirect, and not from anything the user typed. */
    async saveDiscoveryState(state){
      const meta = state && state.authorizationServerMetadata;
      if (meta && meta.issuer) {
        seen.issuer = meta.issuer;
        seen.issSupported = !!meta.authorization_response_iss_parameter_supported;
        if (o.onIssuer) o.onIssuer(seen.issuer, seen.issSupported);
      }
    },

    redirectToAuthorization(url){
      if (o.onAuthorizationUrl) o.onAuthorizationUrl(url);
      return open(url.toString());
    },

    async invalidateCredentials(scope){
      if (scope === "all") {
        await secrets.remove(id);
      } else if (scope === "tokens") {
        await secrets.remove(id, "access_token");
        await secrets.remove(id, "refresh_token");
        await secrets.remove(id, "expires_at");
      } else if (scope === "verifier") {
        await secrets.remove(id, "code_verifier");
      } else if (scope === "client") {
        await secrets.remove(id, "client_id");
        await secrets.remove(id, "client_secret");
      }
    },

    /* Exposed for the flow, not part of the SDK interface. */
    _seen: seen
  };
}

/* --------------------------------------------------------------- the flow */

/* One interactive sign-in, start to finish.

   `steps` is how the transport is created and driven, injected so this
   function is testable and so mcp-client stays the only place that knows
   about transports:
     steps.build({ authProvider })  -> a fresh transport
     steps.connect(transport)       -> resolves, or throws UnauthorizedError
     steps.finish(transport, code)  -> exchanges the code
*/
async function authorize(rec, steps, opts){
  const o = opts || {};
  const listener = await listenForCallback();
  const state = crypto.randomBytes(32).toString("base64url");

  const provider = makeProvider(rec, {
    redirectUrl: listener.redirectUrl,
    state,
    extraScope: o.scope || null,
    onIssuer: o.onIssuer,
    onAuthorizationUrl: o.onAuthorizationUrl
  });

  let transport = null;
  try {
    transport = steps.build({ authProvider: provider, scope: o.scope });
    try {
      await steps.connect(transport);
      /* Already authorized — a valid token was in the store all along. */
      listener.cancel();
      return { transport, provider, authorized: true, fresh: false };
    } catch (err) {
      if (!isUnauthorized(err)) throw err;
      /* redirectToAuthorization has run; the user is in their browser. */
    }

    const params = await listener.params;

    /* Everything below happens before the code goes anywhere. */
    const { code } = validateAuthorizationResponse({
      params,
      expectedState: state,
      expectedIssuer: provider._seen.issuer,
      issuerParameterSupported: provider._seen.issSupported
    });

    await steps.finish(transport, code);
    await secrets.remove(rec.id, "code_verifier");
    return { transport, provider, authorized: true, fresh: true };
  } catch (err) {
    listener.cancel();
    /* A half-finished flow leaves a verifier behind that matches nothing. */
    await secrets.remove(rec.id, "code_verifier").catch(() => {});
    if (transport) { try { await transport.close(); } catch (e) { /* already gone */ } }
    throw err;
  }
}

function isUnauthorized(err){
  if (!err) return false;
  if (err.name === "UnauthorizedError") return true;
  try {
    const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");
    if (err instanceof UnauthorizedError) return true;
  } catch (e) { /* SDK not present in this test */ }
  return /unauthorized/i.test(String(err.message || ""));
}

module.exports = {
  authorize, makeProvider, listenForCallback,
  validateAuthorizationResponse, validateIssuer, scopeUnion, parseInsufficientScope,
  isUnauthorized, setOpener,
  CALLBACK_PATH, MAX_STEP_UP_ATTEMPTS, FLOW_TIMEOUT_MS
};
