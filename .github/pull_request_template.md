## Summary
<!-- What does this PR do and why? -->

## Changes
<!-- List the key changes made -->

## Testing
- [ ] Server unit tests pass (`npx jest --selectProjects unit`)
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] Client builds (`npm run build` in client/)
- [ ] Manually tested on local dev environment

## Database
- [ ] No migration required
- [ ] Migration included, tested locally, and backward-compatible

## Checklist
- [ ] No secrets or hardcoded credentials added
- [ ] Multi-tenant isolation maintained (all DB queries scoped by `accountId`)
- [ ] Error handling in place (no unhandled promise rejections)
- [ ] New API routes registered in OpenAPI schema (`docs/api/openapi.yaml`)
