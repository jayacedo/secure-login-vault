// The extension's link to the desktop app, as one object with three operations:
//   check()      ping the app; if paired, run the two-way proof and report the result
//   pair(code)   pair with the one-time code shown in the app
//   forget()     delete this browser's copy of the pairing secret
// Every operation opens its own connection to the helper and closes it again.
//
// Nothing here trusts the app just because it answers: "connected" means the app
// proved it holds the pairing secret AND the app accepted this extension's proof.
// Everything it needs from the browser is passed in, so it can be tested in Node
// against the real app code.
(function (root) {
  var REQUEST_TIMEOUT_MS = 8000;

  function createLink(deps) {
    var pairing = deps.pairing;
    var status = deps.status;
    var timeoutMs = deps.requestTimeoutMs || REQUEST_TIMEOUT_MS;

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
        ended = lastErrorText() || "Native host has exited.";
        settleAll({ runtimeError: ended });
      });

      return {
        request: function (type, fields) {
          return new Promise(function (resolve) {
            if (ended) {
              resolve({ runtimeError: ended });
              return;
            }
            count += 1;
            var id = deps.randomId() + "-" + count;
            var timer = setTimeout(function () {
              delete waiting[id];
              resolve({ reply: { id: id, ok: false, error: "timeout" } });
            }, timeoutMs);
            waiting[id] = { resolve: resolve, timer: timer };
            try {
              port.postMessage(Object.assign({ id: id, type: type }, fields || {}));
            } catch (error) {
              delete waiting[id];
              clearTimeout(timer);
              resolve({ runtimeError: ended || "Native host has exited." });
            }
          });
        },
        close: function () {
          settleAll({ runtimeError: "closed" }); // nothing may be left waiting
          try {
            port.disconnect();
          } catch (error) {
            // already closed
          }
        }
      };
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

    // ── check ─────────────────────────────────────────────────────────────────
    function check() {
      return deps.storage.get().then(function (stored) {
        var secretHex = pairing.isSecretHex(stored) ? stored : null;
        var session = openSession();
        if (!session) return withFlags(status.describeStatus(undefined, ""), secretHex);

        return session
          .request("ping")
          .then(function (ping) {
            var base = describe(ping);
            if (!base.connected) return withFlags(base, secretHex);
            if (!secretHex) {
              return problem(
                "unpaired",
                "Not paired",
                "Secure Login Vault is running. In the app, open Settings > Pair Browser, press Pair browser, copy the code and paste it below.",
                null,
                { canPair: true, appVersion: base.appVersion }
              );
            }
            return verify(session, secretHex, base);
          })
          .then(
            function (result) {
              session.close();
              return result;
            },
            function () {
              session.close();
              return genericError(secretHex);
            }
          );
      });
    }

    function verify(session, secretHex, base) {
      var secret = pairing.fromHex(secretHex);
      var nonceE = pairing.randomNonce();

      return session.request("auth-begin", { nonceE: nonceE }).then(function (begin) {
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
        return pairing.appProof(secret, "auth", nonceE, reply.nonceA).then(function (expected) {
          if (!pairing.equalHex(expected, reply.appProof)) {
            return problem(
              "app-unverified",
              "Could not verify the app",
              "Whatever is answering did not prove it is the Secure Login Vault you paired with. If you paired this browser again from another browser, pair this one again. Otherwise something else may be answering on this computer: do not sign in or paste codes until you have closed it.",
              secretHex,
              { canPair: true, danger: true }
            );
          }
          return pairing.extProof(secret, "auth", nonceE, reply.nonceA).then(function (proof) {
            return session.request("auth-finish", { nonceE: nonceE, nonceA: reply.nonceA, extProof: proof }).then(function (finish) {
              if (finish.runtimeError || !finish.reply) return withFlags(describe(finish), secretHex);
              if (finish.reply.ok === true && finish.reply.authenticated === true) {
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

    function pair(codeText) {
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
        return result && result.state === "paired-now" ? check() : result;
      });
    }

    function runPairing(session, codeBytes, secretHex) {
      var nonceE = pairing.randomNonce();

      return session.request("pair-begin", { nonceE: nonceE }).then(function (begin) {
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
            return pairing.extProof(authKey, "pair", nonceE, reply.nonceA).then(function (proof) {
              return session.request("pair-finish", { nonceE: nonceE, nonceA: reply.nonceA, extProof: proof }).then(function (finish) {
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

    return { check: check, pair: pair, forget: forget };
  }

  var api = { createLink: createLink, REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS };
  root.SLVLink = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
