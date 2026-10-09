# Local security validation exercise

This branch intentionally contains a security regression. Use it only for local research with disposable accounts and data. Do not merge or deploy it.

## Run locally

Install the locked dependencies and build the app:

```sh
npm ci
npm run build
```

Create a temporary data directory, then start the app on loopback:

```sh
LAB_DATA_DIR="$(mktemp -d)"
CAT_AGENTUI_LAB=1 HOST=127.0.0.1 PORT=3000 \
  DATA_DIR="$LAB_DATA_DIR" SECRET_KEY=local-lab-test-only-key npm start
```

Use two disposable accounts to check whether one account can access another account's private data. Record the HTTP requests, responses, affected data, and the authorization check you expected. Compare the branch against `main` only after writing your own finding.

The repository's existing security regression suite can be run with a separate temporary directory:

```sh
LAB_TEST_DIR="$(mktemp -d)"
CAT_AGENTUI_LAB=1 HOST=127.0.0.1 DATA_DIR="$LAB_TEST_DIR" \
  SECRET_KEY=local-lab-test-only-key node scripts/security-regression.mjs
```

The exercise is an intentionally introduced defect. Label any notes or portfolio write-up as a local security validation exercise, not a newly discovered vulnerability or CVE.
