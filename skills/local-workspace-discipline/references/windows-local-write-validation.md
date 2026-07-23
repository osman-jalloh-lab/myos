# Windows Local-Folder Write Validation

Use this when a project claims a local-first root on Windows and you need to confirm write access before generation.

## Commands
```bash
ROOT='C:/Users/osman/OneDrive/Desktop/HermesProject'
cd "$ROOT" && pwd && git rev-parse --show-toplevel
touch "$ROOT/.local-write-test" && rm "$ROOT/.local-write-test"
```

## Notes
- Confirm presence with `ls -la "$ROOT/.local-write-test"` before delete.
- If `find` returns no inode matches for a previously confirmed path, assume OneDrive lag or cloud-only folder; do not write.
- Do not use Microsoft Graph/OneDrive URLs as write paths; use absolute local filesystem paths.