# Parawi Knowledge Card System v1

Use this prompt when implementing or extending the file-backed knowledge layer.
This layer complements Prisma Memory. It does not replace the database, approval
queue, or existing memory tools.

## Scope

Implement only these four capabilities:

1. OKF Card
2. Catalog Read
3. Catalog Write
4. Agent Bootstrap

Do not import fileset search, catalog git, MCP registration, enrich loops, or
duplicate docs in v1.

## OKF Card

A card is one markdown file under `catalog/<collection>/<id>.md`.

Collections group by kind:

- `senders`
- `feeds`
- `assets`
- `policies`
- `contacts`

Required frontmatter:

- `type`: singular card kind
- `id`: filename stem
- `updated`: `YYYY-MM-DD`

Frontmatter is for fields agents filter on. The body is for prose agents load
into context. Keep one concept per card. Do not put two senders, feeds, assets,
policies, or contacts in one card.

Cards must not contain em dashes.

## Catalog Read

Catalog reads are side-effect free.

Supported read operations:

- `loadCollection(name)`
- `queryCards(name, filter)`
- `readCard(path)`

Filtering is shallow equality on frontmatter. If a frontmatter value is a list,
filters can match by list membership.

Agents should query the smallest useful subset of cards instead of loading an
entire catalog into context.

## Catalog Write

Catalog writes are local file writes only. They do not auto-push and do not
replace the database memory system.

Supported write operations:

- `writeCard(path, frontmatter, body)`
- `patchFrontmatter(path, partial)`
- `appendSection(path, heading, content)`

Guardrails:

- All writes must stay inside `/catalog`.
- Reject missing `type`, `id`, or `updated`.
- Set `updated` to today's date on write.
- Reject cards with em dashes.
- Reject card ids that do not match filenames.
- Reject collection/type mismatches.
- Never store secrets in cards.
- Do not edit `.env`.
- Do not auto-push to GitHub.

Git commits may be added later as an explicit user-approved action. They are not
automatic in v1.

## Agent Bootstrap

Each agent can declare startup context in `agents/<agent>/context.yaml`.

Example:

```yaml
agent: iris
loads:
  - collection: policies
    filter: { tags: [knowledge-card-system] }
```

On wake, an agent can call `loadAgentKnowledgeContext(agent)` to:

1. read its manifest,
2. query the requested card collections,
3. assemble matching cards into working context.

Existing in-code config stays in place until parity is proven. Do not delete
existing constants or routing rules during v1.
