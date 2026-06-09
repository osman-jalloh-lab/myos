# Parawi MCP Gateway

Connects Claude Desktop to your live Parawi/MyOS execution layer.
Claude can call Parawi tools directly from conversation — without a browser session, and without Parawi depending on Claude being open.

## Architecture

```
Claude Desktop
  └── stdio → mcp-gateway/server.ts (local Node.js process)
                  └── HTTPS → https://www.parawi.com/api/hermes/execute
                                  └── execution layer → tools → real results
```

Parawi runs independently on Vercel. The gateway is just a local bridge.

## Setup (one time)

### Step 1 — Install gateway dependencies

```powershell
cd "C:\Users\osman\OneDrive\Desktop\my os\hermes-os\mcp-gateway"
npm install
```

### Step 2 — Generate a shared API key

Pick any strong random string. You'll add it in two places:

```powershell
# Example — use any random string, do not use this one
$key = [System.Web.Security.Membership]::GeneratePassword(32, 8)
Write-Output $key
```

Or just use a UUID. Keep it secret — treat it like a password.

### Step 3 — Add the key to Vercel

In Vercel Dashboard → `myos` project → Settings → Environment Variables:

| Key | Value |
|---|---|
| `PARAWI_MCP_API_KEY` | `your-random-key` |

Redeploy after adding it (push any commit, or trigger redeploy from dashboard).

### Step 4 — Add the key to Claude Desktop config

Open (or create) your Claude Desktop config file:
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the `mcpServers` block (see `mcp-gateway/claude-desktop-config.example.json`):

```json
{
  "mcpServers": {
    "parawi": {
      "command": "npx",
      "args": [
        "tsx",
        "C:\\Users\\osman\\OneDrive\\Desktop\\my os\\hermes-os\\mcp-gateway\\server.ts"
      ],
      "env": {
        "PARAWI_URL": "https://www.parawi.com",
        "PARAWI_MCP_API_KEY": "your-random-key"
      }
    }
  }
}
```

### Step 5 — Restart Claude Desktop

After saving the config, fully quit and reopen Claude Desktop. You should see "parawi" appear in the MCP tools list.

---

## Available tools (loaded from `/skills/*.json`)

| Tool name | What Claude can do |
|---|---|
| `github.inspectRepo` | Inspect any GitHub repo — metadata, README, language, stars |
| `tasks.create` | Create a task in Parawi from natural language |
| `email.triage` | Fetch and triage your inbox for action-needed emails |
| `email.draft` | Queue an email draft (always held for approval — never auto-sends) |
| `resume.generate` | Generate an ATS-optimized resume draft for a target role |
| `income.brief` | Scan F-1-safe income opportunities via Tyche |

## Adding a new skill

1. Create a new file in `skills/your-skill.json` following the existing schema
2. The gateway loads all `.json` files in `skills/` automatically on startup
3. Restart Claude Desktop to pick up the new tool
4. Optionally add execution logic in `src/lib/hermes-execution/tools/internal-tools.ts`

## Security model

- The API key (`PARAWI_MCP_API_KEY`) is the only authentication between the gateway and Parawi
- It must match exactly on both ends (Vercel env var + Claude Desktop config)
- If `PARAWI_MCP_API_KEY` is not set in Vercel, the gateway path is disabled — every call returns 401
- The gateway never stores credentials — it reads `PARAWI_MCP_API_KEY` from environment at startup
- Email drafts and other external writes still go through the existing approval queue — Claude cannot bypass it

## Troubleshooting

**"PARAWI_MCP_API_KEY is not set" warning on startup**
→ Add the key to Claude Desktop config env block (Step 4)

**401 Unauthorized from Parawi**
→ Keys don't match, or `PARAWI_MCP_API_KEY` not yet deployed to Vercel — check Step 3 and redeploy

**"skills/ directory not found"**
→ The path in `args` is wrong. Use the absolute path to the repo root's `mcp-gateway/server.ts`

**Tool not appearing in Claude Desktop**
→ Fully quit Claude Desktop (not just close window) and reopen
