# Windows Next.js dev-server restoration notes

## Goal
Restore a local Hermes OS / Next.js dev server on Windows when the port is bound but not returning HTTP.

## Observed failure pattern
- `netstat -ano` showed `0.0.0.0:3000 LISTENING <pid>`.
- `curl http://127.0.0.1:3000/api/worker/health` connected then timed out with 0 bytes.
- `browser_navigate` to localhost/127.0.0.1 also timed out.
- Restarting the same command without cleanup kept failing or remained hung.

## Owner identification
Use the port owner snippet from SKILL.md before stopping anything.
Confirm the command line contains the expected repo path.
If parent/command line does not match the project, do not stop it.
In this session, owner was `next\dist\server\lib\start-server.js` from the Hermes OS repo.

## Stale dev artifacts to clear
- `.next/dev/lock`
- `.next/dev` contents when present
`find .next -name '*lock*' -type f` is a quick check.

## Restored behavior
After:
```powershell
Stop-Process -Id <pid> -Force
# remove stale dev lock artifacts
npm run dev -- --hostname 127.0.0.1 --port 3000
```

verification returned HTTP 200 from:
- `http://127.0.0.1:3000/api/worker/health`
- `http://127.0.0.1:3000/`

And `npm run build` passed after that.

## Minimal acceptable fix boundary
Do not treat unrelated issues in the same repo as blockers for this incident.
Fix only the dev-server lifecycle/stale-process issue unless another error surfaces during verification.
