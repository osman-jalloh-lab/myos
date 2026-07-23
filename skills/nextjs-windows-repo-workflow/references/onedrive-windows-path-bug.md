# OneDrive Windows Path Bug

## Symptom
`patch`/`write_file` can resolve a OneDrive-spaced Windows repo path to `C:\c\Users\...`, creating files outside the intended repo while `read_file` still reads from the true location.

## Detection
After any write, read the same path back. If read points to a different location or the new file is not visible from the repo root, this is a hard stop.

## Recovery
1. Run `git status --short`
2. Run `git diff --name-only`
3. Revert suspect paths only if `git status` confirms they are inside the current worktree
4. Do not continue the same write strategy after one mismatch

## Provenance
Observed during a local Next.js repo migration on Windows with Hermes `patch`/`write_file`.
