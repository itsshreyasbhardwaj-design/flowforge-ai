## What and why

<!-- What problem does this solve? Link the issue if there is one. -->

Closes #

## Approach

<!-- How does it work? Note any alternative you considered and rejected. -->

## Verification

<!-- How do you know it works? Be specific — "ran the tests" is not enough on its own. -->

- [ ] `pnpm verify` passes (typecheck, lint, tests, production build)
- [ ] New behaviour is covered by a test
- [ ] A bug fix includes a regression test that fails without the fix
- [ ] Verified in the running app, not only in tests

## Screenshots

<!-- Required for UI changes. Before and after where it helps. -->

## Checklist

- [ ] No React or Next.js imports were added under `src/core/`
- [ ] Any new node uses the public `defineNode` API
- [ ] Secrets are referenced with `{ "$secret": "KEY" }`, never inlined
- [ ] New error messages tell the user what to do about the error
- [ ] Docs updated if behaviour or the API changed
- [ ] Commits follow Conventional Commits

## Breaking changes

<!-- Describe any change to the workflow schema, the node contract, or the HTTP API,
     and how existing users should migrate. Write "None" if there are none. -->

None
