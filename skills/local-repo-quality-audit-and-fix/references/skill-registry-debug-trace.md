# Skill registry debug trace

This reference contains condensed failure modes observed while auditing local
repo skill quality on a Windows/OneDrive-backed repo.

## Failure modes seen

- `source: ""` missing on a skill JSON does not break registry load. The registry
  normalizes it to an empty string, not `undefined`, so config/search queries
  that assume absence must still handle the empty-string case.
- `memberIds: undefined` does not come back from saved JSON; after reload, it is
  often `[]`. If the local config entry observed missing `memberIds`, that was the
  live-process missing state, not the persisted schema contract.

## Verification pattern

After schema/config changes near `savedSkill.memberIds` or skill quality:

1. Run a debug test that asserts exact expected shape.
2. Remove the debug test after confirmation.
3. Re-run only the smallest meaningful verification path instead of the full
   test suite.

## Hot reload loop evidence

Repeat query after `clearSkillRegistryCache()` does not keep returning the same
broken state without bytes change because the data shape persists above the
cache layer.
