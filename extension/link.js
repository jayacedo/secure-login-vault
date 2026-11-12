// The extension's link to the desktop app, as one object with three operations:
//   check({url}) ping the app; if paired, run the two-way proof and report the result;
//                when verified and a page origin is given, also ask which saved logins
//                belong to that page (names and usernames only)
//   pair(code, {url})   pair with the one-time code shown in the app, then check
//   forget()     delete this browser's copy of the pairing secret
//   fetchLogin({loginId, url})
//                ask the app for ONE saved login's username and password, for the page
//                at url. Only a fully verified connection is ever asked. The result is for
//                the background worker alone; it is never passed on to the popup.
//   saveLogin({url, username, password})
//                ask the app to add a login (or update its password) for the origin url.
//                The person always confirms in the app; this only relays the request.
// Every operation opens its own connection to the helper and closes it again.
//
// Nothing here trusts the app just because it answers: "connected" means the app
// proved it holds the pairing secret AND the app accepted this extension's proof.
// Everything it needs from the browser is passed in, so it can be tested in Node
// against the real app code.
(function (root) {
  var REQUEST_TIMEOUT_MS = 8000;
  // The desktop confirmation can remain open for 30 seconds.
  var APPROVAL_REQUEST_TIMEOUT_MS = 35000;

  function createLink(deps) {
    var secure = root.SLVSecureChannel || (typeof require === "function" ? require("./secureChannel") : null);
    var pairing = deps.pairing;
    var status = deps.status;
    var timeoutMs = deps.requestTimeoutMs || REQUEST_TIMEOUT_MS;
    var approvalTimeoutMs = deps.approvalRequestTimeoutMs || APPROVAL_REQUEST_TIMEOUT_MS;

    function lastErrorText() {
      try {
        return (deps.getLastError && deps.getLastError()) || "";
      } catch (error) {
        return "";
      }
    }

    // ── One connection to the helper ──────────────────────────────────────────
    // request() always resolves: { reply } (the app's or helper's answer),
    // { runtimeError } (the browser says the helper is gone), never rejects.
    function openSession() {
      var port;
      try {
        port = deps.connectNative(deps.hostName);
      } catch (error) {
        return null;
      }

      var waiting = {};
      var ended = "";
      var count = 0;
      var channel = null;

      function settleAll(outcome) {
        Object.keys(waiting).forEach(function (id) {
          var entry = waiting[id];
          delete waiting[id];
          clearTimeout(entry.timer);
          entry.resolve(outcome);
        });
      }

      port.onMessage.addListener(function (message) {
        if (!message || typeof message !== "object") return;
        if (message.id !== undefined && Object.prototype.hasOwnProperty.call(waiting, message.id)) {
          var entry = waiting[message.id];
          delete waiting[message.id];
          clearTimeout(entry.timer);
          entry.resolve({ reply: message });
        } else if (message.id === undefined) {
          settleAll({ reply: message }); // the helper itself refusing, e.g. origin-not-allowed
        }
      });

      port.onDisconnect.addListener(function () {
        ended = lastErrorText() || port.error?.message || "Native host has exited.";
        settleAll({ runtimeError: ended });
      });

      function rawRequest(type, fields, envelope, deadlineMs = timeoutMs) {
          return new Promise(function (resolve) {
            if (ended) {
              resolve({ runtimeError: ended });
              return;
            }
            count += 1;
            var id = envelope ? envelope.id : deps.randomId() + "-" + count;
            var timer = setTimeout(function () {
              delete waiting[id];
              resolve({ reply: { id: id, ok: false, error: "timeout" } });
            }, deadlineMs);
            waiting[id] = { resolve: resolve, timer: timer };
            try {
              port.postMessage(envelope || Object.assign({ id: id, type: type }, fields || {}));
            } catch (error) {
              delete waiting[id];
              clearTimeout(timer);
              resolve({ runtimeError: ended || "Native host has exited." });
            }
          });
      }
      const session = {
        async enableEncryption(secret, nonceE, nonceA) {
          channel = await secure.createChannel({ secret, nonceE, nonceA, role: "extension" });
        },
        async request(type, fields) {
          if (!channel) {
            if (!["ping", "pair-begin", "pair-finish", "auth-begin", "auth-finish"].includes(type)) return { runtimeError: "Encryption required" };
            return rawRequest(type, fields);
          }
          try {
            const id = deps.randomId() + "-secure-" + (++count);
            const envelope = await channel.seal(Object.assign({}, fields || {}, { type }), id);
            const outcome = await rawRequest("secure", null, envelope, type === "save-login" || type === "get-login" ? approvalTimeoutMs : timeoutMs);
            if (outcome.runtimeError || !outcome.reply) throw new Error("Disconnected");
            const reply = await channel.open(outcome.reply);
            if (reply.id !== id) throw new Error("Wrong response");
            return { reply };
          } catch {
            session.close();
            return { runtimeError: "Secure connection failed. Check again." };
          }
        },
        close: function () {
          if (channel) channel.destroy();
          ended = "closed";
          settleAll({ runtimeError: "closed" }); // nothing may be left waiting
          try {
            port.disconnect();
          } catch (error) {
            // already closed
          }
        }
      };
      return session;
    }

    function describe(outcome) {
      return status.describeStatus(outcome.reply, outcome.runtimeError || "");
    }

    function withFlags(result, secretHex, extra) {
      return Object.assign({}, result, { paired: Boolean(secretHex), canForget: Boolean(secretHex), canPair: false }, extra || {});
    }

    function problem(state, title, detail, secretHex, extra) {
      return withFlags({ state: state, connected: false, title: title, detail: detail }, secretHex, extra);
    }

    function genericError(secretHex) {
      return withFlags(status.describeStatus({ ok: false, error: "other" }, ""), secretHex);
    }

    // ── One connection: ping, then (if paired) the two-way proof ──────────────
    // Resolves to { status } when the link is not verified (the status to show), or to
    // { verified: true, value } where value is whatever afterVerified(session, status)
    // produced. afterVerified runs only on a fully verified connection.
    function runVerified(afterVerified) {
      return deps.storage.get().then(function (stored) {
        var secretHex = pairing.isSecretHex(stored) ? stored : null;
        var session = openSession();
        if (!session) return { status: withFlags(status.describeStatus(undefined, ""), secretHex) };

        return session
          .request("ping")
          .then(function (ping) {
            var base = describe(ping);
            if (!base.connected) return { status: withFlags(base, secretHex) };
            if (!secretHex) {
              return {
                status: problem(
                  "unpaired",
                  "Not paired",
                  "Secure Login Vault is running. In the app, open Settings > Pair Browser, press Pair browser, copy the code and paste it below.",
                  null,
                  { canPair: true, appVersion: base.appVersion }
                )
              };
            }
            return verify(session, secretHex, base).then(function (result) {
              if (result.state !== "verified") return { status: result };
              return Promise.resolve(afterVerified(session, result)).then(function (value) {
                return { verified: true, status: result, value: value };
              });
            });
          })
          .then(
            function (outcome) {
              session.close();
              return outcome;
            },
            function () {
              session.close();
              return { status: genericError(secretHex) };
            }
          );
      });
    }

    // ── check ─────────────────────────────────────────────────────────────────
    function check(options) {
      var pageUrl = options && typeof options.url === "string" && options.url.length <= 2048 ? options.url : "";
      return runVerified(function (session, result) {
        // Only a fully verified connection is ever asked about saved logins.
        return pageUrl ? addSite(session, result, pageUrl) : result;
      }).then(function (outcome) {
        return outcome.verified ? outcome.value : outcome.status;
      });
    }

    // ── fetchLogin ────────────────────────────────────────────────────────────
    var LOGIN_PROBLEMS = {
      locked: "Secure Login Vault is locked. Unlock it, then try again.",
      "no-match": "That login does not belong to this page.",
      "rate-limited": "Too many fills in a minute. Wait a moment and try again.",
      declined: "The fill was not approved in Secure Login Vault.",
      "insecure-page": "Logins are only filled on secure (https) pages.",
      "unsupported-page": "Logins are only filled on secure (https) pages.",
      "bad-url": "Logins are only filled on secure (https) pages.",
      "no-credentials": "This login has no username or password to fill."
    };

    function fetchLogin(request) {
      var loginId = request && request.loginId;
      var pageUrl = request && request.url;
      if (!Number.isSafeInteger(loginId) || typeof pageUrl !== "string" || !pageUrl || pageUrl.length > 2048) {
        return Promise.resolve({ ok: false, message: "That request could not be understood." });
      }

      return runVerified(function (session) {
        return session.request("get-login", { loginId: loginId, url: pageUrl }).then(function (outcome) {
          var reply = outcome.reply;
          if (outcome.runtimeError || !reply) return { ok: false, message: "Could not get the login. Check again." };
          if (reply.ok === true && typeof reply.password === "string" && typeof reply.username === "string") {
            return { ok: true, username: reply.username, password: reply.password };
          }
          var known = typeof reply.error === "string" && Object.prototype.hasOwnProperty.call(LOGIN_PROBLEMS, reply.error);
          return { ok: false, message: known ? LOGIN_PROBLEMS[reply.error] : "Could not get the login. Check again." };
        });
      }).then(function (outcome) {
        if (outcome.verified) return outcome.value;
        // Not verified: say why, in the same words as the status box.
        return { ok: false, message: outcome.status.title + ". " + outcome.status.detail, unverified: true };
      });
    }

    // ── saveLogin ─────────────────────────────────────────────────────────────
    var SAVE_PROBLEMS = {
      locked: "Secure Login Vault is locked. Unlock it, then try again.",
      "rate-limited": "Too many saves in a minute. Wait a moment and try again.",
      declined: "It was not approved in Secure Login Vault, so nothing was saved.",
      unchanged: "This login is already saved with this password.",
      changed: "The vault changed while you were deciding. Nothing was saved; try again.",
      "insecure-page": "Logins are only saved from secure (https) pages.",
      "unsupported-page": "Logins are only saved from secure (https) pages.",
      "bad-url": "Logins are only saved from secure (https) pages.",
      "bad-message": "That login could not be saved (the username or password is empty or too long)."
    };

    function saveLogin(request) {
      var pageUrl = request && request.url;
      var username = request && request.username;
      var password = request && request.password;
      if (typeof pageUrl !== "string" || !pageUrl || pageUrl.length > 2048 || typeof username !== "string" || !username || username.length > 256 || typeof password !== "string" || !password || password.length > 1024) {
        return Promise.resolve({ ok: false, message: "That request could not be understood." });
      }

      return runVerified(function (session) {
        return session.request("save-login", { url: pageUrl, username: username, password: password }).then(function (outcome) {
          var reply = outcome.reply;
          if (outcome.runtimeError || !reply) return { ok: false, message: "Could not save the login. Check again." };
          if (reply.ok === true && (reply.mode === "add" || reply.mode === "update")) return { ok: true, mode: reply.mode };
          var known = typeof reply.error === "string" && Object.prototype.hasOwnProperty.call(SAVE_PROBLEMS, reply.error);
          return { ok: false, message: known ? SAVE_PROBLEMS[reply.error] : "Could not save the login. Check again." };
        });
      }).then(function (outcome) {
        if (outcome.verified) return outcome.value;
        return { ok: false, message: outcome.status.title + ". " + outcome.status.detail, unverified: true };
      });
    }

    function inspectLogin(request) {
      var pageUrl = request && request.url;
      var username = request && request.username;
      var password = request && request.password;
      if (typeof pageUrl !== "string" || !pageUrl || pageUrl.length > 2048 ||
          typeof username !== "string" || !username.trim() || username.length > 256 ||
          typeof password !== "string" || !password || password.length > 1024) return Promise.resolve({ ok: false });
      return runVerified(function (session) {
        return session.request("inspect-login", { url: pageUrl, username: username, password: password }).then(function (outcome) {
          var reply = outcome.reply;
          if (!outcome.runtimeError && reply && reply.ok === true && ["add", "update", "unchanged"].includes(reply.mode)) {
            return { ok: true, mode: reply.mode };
          }
          return { ok: false, locked: Boolean(reply && reply.error === "locked") };
        });
      }).then(function (outcome) {
        return outcome.verified ? outcome.value : { ok: false };
      });
    }

    function cleanText(value) {
      return typeof value === "string" ? value.slice(0, 100) : "";
    }

    function addSite(session, result, pageUrl) {
      return session.request("find-logins", { url: pageUrl }).then(function (outcome) {
        var reply = outcome.reply;
        var site;
        if (outcome.runtimeError || !reply) {
          site = { state: "error" };
        } else if (reply.ok === true && Array.isArray(reply.logins)) {
          var logins = [];
          reply.logins.slice(0, 20).forEach(function (entry) {
            if (entry && typeof entry === "object" && Number.isSafeInteger(entry.id)) {
              logins.push({ id: entry.id, name: cleanText(entry.name), username: cleanText(entry.username) });
            }
          });
          site = { state: "ok", host: cleanText(reply.host), logins: logins };
        } else if (reply.error === "locked") {
          site = { state: "locked" };
        } else if (reply.error === "insecure-page") {
          site = { state: "insecure" };
        } else if (reply.error === "unsupported-page" || reply.error === "bad-url") {
          site = { state: "unsupported" };
        } else {
          site = { state: "error" };
        }
        return Object.assign({}, result, { site: site });
      });
    }

    function verify(session, secretHex, base) {
      var secret = pairing.fromHex(secretHex);
      var nonceE = pairing.randomNonce();

      return pairing.pairingId(secret).then(function (id) {
        return session.request("auth-begin", { nonceE: nonceE, pairingId: id });
      }).then(function (begin) {
        if (begin.runtimeError || !begin.reply) return withFlags(describe(begin), secretHex);
        var reply = begin.reply;

        if (reply.ok !== true) {
          if (reply.error === "not-paired") {
            return problem(
              "pairing-lost",
              "Pairing no longer valid",
              "The app does not recognise this browser any more (it may have been unpaired). Pair again with a new code.",
              secretHex,
              { canPair: true }
            );
          }
          return withFlags(describe({ reply: reply }), secretHex);
        }

        if (!pairing.isNonce(reply.nonceA) || !pairing.isProof(reply.appProof)) return genericError(secretHex);

        // The app goes first: until it proves it holds the secret, nothing is sent
        // that would let a fake app learn anything.
        return pairing.appProof(secret, "auth-v2", nonceE, reply.nonceA).then(function (expected) {
          if (!pairing.equalHex(expected, reply.appProof)) {
            return problem(
              "app-unverified",
              "Could not verify the app",
              "Whatever is answering did not prove it is the Secure Login Vault you paired with. Check that the correct SLV app is running before pairing again.",
              secretHex,
              { canPair: true, danger: true }
            );
          }
          return pairing.extProof(secret, "auth-v2", nonceE, reply.nonceA).then(function (proof) {
            return session.request("auth-finish", { nonceE: nonceE, nonceA: reply.nonceA, extProof: proof }).then(async function (finish) {
              if (finish.runtimeError || !finish.reply) return withFlags(describe(finish), secretHex);
              if (finish.reply.ok === true && finish.reply.authenticated === true) {
                await session.enableEncryption(secret, nonceE, reply.nonceA);
                secret.fill(0);
                const confirmation = await session.request("channel-check");
                if (!confirmation.reply?.ok || confirmation.reply.authenticated !== true) return genericError(secretHex);
                return withFlags(
                  {
                    state: "verified",
                    connected: true,
                    title: "Connected",
                    detail: base.appVersion ? "Secure Login Vault " + base.appVersion + " (verified)" : "Secure Login Vault (verified)",
                    appVersion: base.appVersion
                  },
                  secretHex
                );
              }
              if (finish.reply.error === "not-paired") {
                return problem("pairing-lost", "Pairing no longer valid", "The app does not recognise this browser any more. Pair again with a new code.", secretHex, { canPair: true });
              }
              return genericError(secretHex);
            });
          });
        });
      });
    }

    // ── pair ──────────────────────────────────────────────────────────────────
    function pairFailed(title, detail, secretHex) {
      return problem("pair-failed", title, detail, secretHex, { canPair: true });
    }

    function pair(codeText, options) {
      var codeBytes = pairing.parseCode(codeText);
      return deps.storage.get().then(function (stored) {
        var secretHex = pairing.isSecretHex(stored) ? stored : null;
        if (!codeBytes) {
          return pairFailed("Code not recognised", "That does not look like a pairing code. It has 26 letters and numbers in groups of four, separated by dashes.", secretHex);
        }

        var session = openSession();
        if (!session) return withFlags(status.describeStatus(undefined, ""), secretHex);

        return runPairing(session, codeBytes, secretHex).then(
          function (result) {
            session.close();
            return result;
          },
          function () {
            session.close();
            return pairFailed("Pairing failed", "Something went wrong while pairing. Check that the app is running and try again with a new code.", secretHex);
          }
        );
      }).then(function (result) {
        // After a successful pairing, report the verified state through a normal check.
        return result && result.state === "paired-now" ? check(options) : result;
      });
    }

    function runPairing(session, codeBytes, secretHex) {
      var nonceE = pairing.randomNonce();

      return session.request("pair-begin", { nonceE: nonceE, browserName: deps.browserName || "Browser" }).then(function (begin) {
        if (begin.runtimeError || !begin.reply) return withFlags(describe(begin), secretHex);
        var reply = begin.reply;

        if (reply.ok !== true) {
          if (reply.error === "no-pairing") {
            return pairFailed("No code is active", "The app is not showing a pairing code. In the app: Settings > Pair Browser > Pair browser, then copy the new code.", secretHex);
          }
          if (reply.error === "busy") {
            return pairFailed("The app is busy", "Wait a moment and try again.", secretHex);
          }
          return withFlags(describe({ reply: reply }), secretHex);
        }

        if (!pairing.isNonce(reply.nonceA) || !pairing.isProof(reply.appProof)) return genericError(secretHex);

        return pairing.pairingAuthKey(codeBytes).then(function (authKey) {
          return pairing.appProof(authKey, "pair", nonceE, reply.nonceA).then(function (expected) {
            // The app proves it knows the code first. A wrong or mistyped code, or
            // something pretending to be the app, ends here without us sending a proof.
            if (!pairing.equalHex(expected, reply.appProof)) {
              return pairFailed(
                "Code not accepted",
                "The app's answer does not match this code. Copy the code again from Settings > Pair Browser in your own Secure Login Vault (a code works once and expires after 2 minutes). If you copied it correctly, something else may be answering as the app.",
                secretHex
              );
            }
            return pairing.extProof(authKey, "pair", nonceE, reply.nonceA).then(async function (proof) {
              const request = { nonceE: nonceE, nonceA: reply.nonceA, extProof: proof };
              if (secretHex) {
                const prior = pairing.fromHex(secretHex);
                request.replaceId = await pairing.pairingId(prior);
                request.replaceProof = await pairing.replaceProof(prior, nonceE, reply.nonceA, proof);
                prior.fill(0);
              }
              return session.request("pair-finish", request).then(function (finish) {
                if (finish.runtimeError || !finish.reply) return withFlags(describe(finish), secretHex);
                if (finish.reply.ok === true && finish.reply.paired === true) {
                  return pairing.pairingSecret(codeBytes, nonceE, reply.nonceA).then(function (secret) {
                    return deps.storage.set(pairing.toHex(secret)).then(function () {
                      return { state: "paired-now" };
                    });
                  });
                }
                if (finish.reply.error === "no-pairing") {
                  return pairFailed("The code expired", "Codes work once and expire after 2 minutes. Press Pair browser in the app for a new one.", secretHex);
                }
                if (finish.reply.error === "storage-failed") {
                  return pairFailed("The app could not save the pairing", "Windows encryption may be unavailable for this account.", secretHex);
                }
                if (finish.reply.error === "pairing-limit") return pairFailed("Too many paired browsers", "Remove an unused browser from SLV Settings, then try again.", secretHex);
                return pairFailed("Code not accepted", "The app did not accept the pairing. Press Pair browser in the app for a new code and try again.", secretHex);
              });
            });
          });
        });
      });
    }

    // ── forget ────────────────────────────────────────────────────────────────
    function forget() {
      return deps.storage.clear().then(check);
    }

    return { check: check, pair: pair, forget: forget, fetchLogin: fetchLogin, saveLogin: saveLogin, inspectLogin: inspectLogin };
  }

  var api = { createLink: createLink, REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS };
  root.SLVLink = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
