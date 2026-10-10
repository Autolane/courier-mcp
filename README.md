# @autolane/courier-mcp

Use [Autolane Courier](https://docs.goautolane.com/courier/get-started) from an AI agent on any machine, including one with no browser: a server, a container, or a computer you reach over SSH.

This package runs a small MCP server on your machine. It links to your phone once, keeps its own login, and passes your agent's requests to Autolane at `https://mcp.goautolane.com/courier-mcp`. Any agent that can run a local (stdio) MCP server can use it, even one without OAuth.

## Link your phone

On the machine where your agent runs:

    npx -y @autolane/courier-mcp login --no-browser

Open the link it prints on any device (your phone works), check the page shows the same code, and enter your mobile number and the 6-digit code Autolane texts you. The command finishes by itself. Leave out `--no-browser` to have it open the link in a browser on this machine.

Autolane Courier is invite-only for now. If the page says the service isn't available for your number, [join the waitlist](https://goautolane.com/autolane-courier).

## Add it to your agent

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
