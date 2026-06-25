---
type: policy
id: parawi-knowledge-card-system-v1
tags: [knowledge-card-system, parawi]
status: draft
updated: 2026-06-25
---
Parawi Knowledge Card System v1 is a file-backed context layer for durable
agent knowledge.

It complements the existing database memory system. It does not replace Prisma
Memory, approval actions, or Mnemosyne.

Agents may read cards for context. Catalog writes must stay inside catalog,
must validate the OKF card format, and must never store secrets.
