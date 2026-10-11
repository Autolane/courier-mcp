# @autolane/courier-mcp

Use [Autolane Courier](https://docs.goautolane.com/courier/get-started) from an AI agent on any machine, including one with no browser: a server, a container, or a computer you reach over SSH.

This package runs a small MCP server on your machine. It links to your phone once, keeps its own login, and passes your agent's requests to Autolane at `https://mcp.goautolane.com/courier-mcp`. Any agent that can run a local (stdio) MCP server can use it, even one without OAuth.

## You probably don't need this package

Most AI assistants connect to Autolane Courier directly: add `https://mcp.goautolane.com/courier-mcp` as a custom connector or MCP server, link your phone, and you're done. Nothing to install.

- **Claude** (claude.ai, Claude Desktop, phone apps): Customize, Connectors, + Add, Add custom connector. Name `Autolane Courier`, URL `https://mcp.goautolane.com/courier-mcp`. Select Connect, then enter your mobile number and the 6-digit code Autolane texts you.
- **ChatGPT** (web, and your dots): chatgpt.com/plugins, +, Add custom MCP server. Name `Autolane Courier`, Server URL `https://mcp.goautolane.com/courier-mcp`, Authentication OAuth (leave client ID and secret empty). Select Connect and link your phone.
- **Claude Code**: `claude mcp add --transport http --scope user autolane-courier https://mcp.goautolane.com/courier-mcp`, then `claude mcp login autolane-courier`.
- **Codex** (CLI, IDE extension, ChatGPT desktop app): `codex mcp add autolane-courier --url https://mcp.goautolane.com/courier-mcp`. Codex opens your browser; if not, run `codex mcp login autolane-courier`.
- **OpenClaw**: `openclaw mcp add autolane-courier --url https://mcp.goautolane.com/courier-mcp --transport streamable-http --auth oauth`, then `openclaw mcp login autolane-courier`.
- **Hermes**: add this custom MCP entry, then open its config and select Retry, then Authorize:

  ```json
  { "mcpServers": { "Courier by Autolane": { "url": "https://mcp.goautolane.com/courier-mcp", "auth": "oauth" } } }
  ```

- **Muse** (Meta AI): ask "Connect the Autolane Courier MCP at https://mcp.goautolane.com/courier-mcp", open the link it shows, and check the code matches.

Full guides: [docs.goautolane.com/courier/get-started](https://docs.goautolane.com/courier/get-started).

**Terminal agent on another machine** (over SSH or on a server)? After you link your phone, the Autolane page asks where the agent is running. Pick **On another computer** and paste the link it shows where the agent asks for one. If the agent doesn't ask, open "isn't asking for a link?" and run the `curl` command it shows on the agent's machine.

## When to use this package

Use it when your agent runs on a machine with no browser and you'd rather link with a code from your phone, or when your agent can run a local (stdio) MCP server but can't sign in to one with OAuth.

### Link your phone

On the machine where your agent runs:

    npx -y @autolane/courier-mcp login --no-browser

Open the link it prints on any device (your phone works), check the page shows the same code, and enter your mobile number and the 6-digit code Autolane texts you. The command finishes by itself. Leave out `--no-browser` to have it open the link in a browser on this machine.

Autolane Courier is invite-only for now. If the page says the service isn't available for your number, [join the waitlist](https://goautolane.com/autolane-courier).

### Add it to your agent

Claude Code:

    claude mcp add --scope user autolane-courier -- npx -y @autolane/courier-mcp

Any other agent: add a local (stdio) MCP server with the command `npx` and the arguments `-y @autolane/courier-mcp`.

## Commands

| Command | Does |
| --- | --- |
| `npx -y @autolane/courier-mcp` | Runs the MCP server on stdio. Your agent's config runs this. |
| `login [--no-browser]` | Links this machine to your phone. |
| `logout` | Revokes this machine's link and removes it. |
| `status` | Shows whether this machine is linked. |

## Where the login lives

`~/.config/autolane/courier-mcp.json` (or `$XDG_CONFIG_HOME/autolane/` when set; `%APPDATA%\autolane\` on Windows), readable only by you. It holds a short-lived access token and a refresh token, never your phone number. Several agents on one machine can share it. Run `logout` to remove it.

## Help

support@goautolane.com
