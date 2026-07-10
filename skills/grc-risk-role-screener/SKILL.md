---
name: grc-risk-role-screener
description: Screen GRC, risk, compliance, audit, SOC 2, NIST, controls, and security analyst roles against Osman's Security+/CySA+ background.
ownerAgents:
  - athena
  - sophos
tags:
  - grc
  - risk-management
  - compliance
  - soc2
  - nist
  - audit
  - cybersecurity
safetyClass: read_only
source: claude-skill-export
---

# GRC / Risk Role Screener

Use this skill for role listings involving governance, risk, compliance, IT risk, security governance, controls testing, audit evidence, SOC 2, NIST CSF, NIST 800-53, RMF, ISO 27001, policy, risk registers, access reviews, third-party risk, vendor risk, compliance analyst, and security analyst work.

## Distinguish Carefully

Classify the role before scoring:

- True IT/security GRC: controls, security frameworks, audit evidence, policy, security risk, access reviews, vendor risk, compliance analyst, security analyst.
- Finance risk: credit, market, liquidity, treasury, banking risk with no security/control overlap.
- Legal compliance: counsel, regulatory legal ownership, privacy law, contract compliance.
- Senior audit ownership: manager, director, principal, 5+ years hard requirement, CPA/CISA/CISSP as hard gates.
- Entry-level analyst: associate, junior, coordinator, internship, analyst I, supportable framework exposure.

## Required Behavior

- Do not treat every risk or compliance keyword as cybersecurity GRC.
- Do not invent audit, framework, policy, or controls experience.
- Name hard requirement gaps directly.
- Pair with Job Application Ops for Apply/Maybe/Skip workflow, resume angle, or tracking.
- Pair with Personal Context Anchor when Security+/CySA+, career targets, or project context should inform the screen.

## Output Contract

Use:

1. Role category
2. Fit score
3. True GRC vs other risk
4. Why it fits
5. Risks/seniority
6. Resume angle
7. Missing skills
8. Apply / Maybe / Skip

## Strong Fit Signals

Security+, CySA+, SOC, SIEM, vulnerability management, risk assessment, audit evidence, controls testing, NIST, RMF, SOC 2, ISO 27001, policy, IAM/access review, vendor risk, third-party risk, and entry-level analyst language.
