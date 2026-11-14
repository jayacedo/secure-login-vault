# Tracked source and history secret review

Date: 2026-11-15 (Asia/Manila).

## Result

No confirmed real credentials or private keys were found by this scoped review.
Gitleaks reported five findings in history and the same five in the current source
snapshot. Each was classified using source context without displaying secret
values or attempting to authenticate to an external service.

| Location | Historical commit / line | Classification |
| --- | --- | --- |
| `extension/manifest.json` | `26853322a715` / 7 | Public RSA extension identity key, not a private key |
| `scripts/credential-filters-app-test.js` | `cf71d0c1feb1` / 21 | Known example TOTP seed used in a generated synthetic test QR |
| `scripts/credential-details-app-test.js` | `5ce39f4fa970` / 19 | Known example TOTP seed used in a generated synthetic test QR |
| `scripts/authenticator-app-test.js` | `fb27758c6e39` / 21 | Known example TOTP seed in an isolated authenticator test |
| `scripts/authenticator-app-test.js` | `d7c7ef532cb7` / 93 | Known example TOTP seed in an isolated client test |

Current line numbers may differ. Test source creates temporary data/profile paths;
the seeds were compared with known example constants without printing their values.
The manifest key was parsed with Node's public-key parser as an RSA public key.
No findings were hidden with a new scanner suppression or broad test-file exclusion.

## Scope and method

- Reviewed commit: `d8ff3dab36c91cbfe846ffbdefa72e40f273048c`.
- The non-shallow repository had 71 reachable commits and 200 historical paths.
- Public branch/tag enumeration showed only `main`, pointing at that same commit.
  The local history scan used all available refs, including local tooling refs.
- A filename-only history inventory found no tracked vault, backup, credential
  export or private QR file. The only `database/` entry was `.gitkeep`; its contents
  were not needed or opened for this review.
- Gitleaks **8.30.1** was downloaded from its official GitHub release. The Windows
  x64 archive matched the publisher's SHA-256:
  `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`.
- Both scans used the default rules, explicit configuration extending those rules,
  an empty scanner-ignore file, `--ignore-gitleaks-allow`, `--redact=100`, and no
  archive traversal. No live credential checks or source upload were performed.
- The history scan used `git --log-opts="--all --full-history -- <reviewed paths>"`.
  Its scope was 185 tracked text paths under `src`, `extension`, `scripts`, `docs`
  and the five root text files. The current scan used `dir` against a temporary
  snapshot of those same 185 files exported from Git objects, not the working tree.
- Scanner stdout/stderr were captured without displaying their contents. Only
  rule, file, line and commit metadata was exposed for triage. Temporary tool,
  snapshot and reports were removed afterward.

No real vault, backups, installed app data, browser profiles or untracked private
files were opened. No credentials were changed and no Git history was rewritten.

## Preventive change

Added targeted `.gitignore` entries for the untracked private QR filenames, `work/`,
vault and backup formats, pairing storage, environment files and `database/`
contents other than `.gitkeep`. This changes tracking rules only; it does not
modify or delete the private files. Ignore rules are not retroactive and can be
bypassed with force-add; the package allowlist remains a separate build safeguard.

## Limits and next work

This is a pattern-based source review, not proof that every possible secret is
absent. Gitleaks can miss arbitrary passwords and unfamiliar credential formats.
Images, binary files, unreachable/deleted Git objects, GitHub issue/PR text,
external forks/caches and remote refs not advertised as branches/tags were not
content-scanned. The current package inventory check is documented separately.

The next independent review should examine dependency advisories, followed by
synthetic lock/session and hostile-page regression tests. Public installer
distribution remains on hold; any new installer is for local testing only.

## References

- [Gitleaks usage and redaction](https://github.com/gitleaks/gitleaks)
- [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
- [GitHub secret leakage risks](https://docs.github.com/en/code-security/concepts/secret-security/secret-leakage-risks)
- [Package privacy checks](package-privacy.md)
