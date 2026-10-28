# Connect Kicktipp to ChatGPT

Use an OpenAI Secure MCP Tunnel to connect your private Kicktipp service to a custom ChatGPT plugin. You do not need to publish port 8787 or create a public website.

## Before you start

- Complete the [Quick Start](../README.md#quick-start). Leave the service running and keep profiles read-only for your first test.
- Your ChatGPT account or workspace must allow custom MCP servers. Workspace restrictions still apply.
- Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), create a tunnel, associate your intended ChatGPT workspace, and copy its full tunnel ID. Creating tunnels requires **Tunnels Read + Manage**; running and selecting one requires **Read + Use**.
- Create an OpenAI **runtime API key** whose principal has tunnel access. It is separate from your Kicktipp MCP token and web administrator token.
- Download the full `tunnel-client` for your operating system from the Platform page or [official releases](https://github.com/openai/tunnel-client/releases/latest). Extract the full release archive, keep its files together, add the extracted directory to your `PATH`, then run `tunnel-client help quickstart`.

The host running the client needs outbound HTTPS access to OpenAI and access to `http://127.0.0.1:8787/mcp`. Run it on the same computer as Docker for the commands below. These tunnels are for private use; publishing a plugin publicly requires a stable public HTTPS endpoint. See [OpenAI's tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## 1. Start the tunnel

In the local website, open **Connect agent** and reveal the **MCP token**. Use this token, not the administrator token you entered to unlock the website.

Open Bash on the Docker host. The prompts below hide your secrets and keep them out of shell history. Replace `YOUR_TUNNEL_ID` with the ID from Platform:

```bash
read -rsp "OpenAI runtime API key: " CONTROL_PLANE_API_KEY
printf '\n'
export CONTROL_PLANE_API_KEY
read -rsp "Kicktipp MCP token: " KICKTIPP_MCP_TOKEN
printf '\n'
export KICKTIPP_MCP_AUTH="Bearer $KICKTIPP_MCP_TOKEN"
export MCP_EXTRA_HEADERS='Authorization: env:KICKTIPP_MCP_AUTH'

tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile kicktipp \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-server-url http://127.0.0.1:8787/mcp

tunnel-client doctor --profile kicktipp --explain
tunnel-client run --profile kicktipp
```

Leave this terminal open. Both the Kicktipp service and tunnel client must run while ChatGPT discovers or calls tools. The profile stores references to your environment variables; after opening a new shell, repeat the secret prompts and exports before `doctor` and `run`. You only need `init` for the initial configuration.

The sample name means the server has no OAuth discovery. **Kicktipp still requires its bearer token**: the tunnel client adds it locally. The `env:` header reference avoids saving the token in the profile. See the [client onboarding guide](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md) and [static-header configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md#mcp-server).

## 2. Create your ChatGPT plugin

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins) on the web.
2. Select **+ → Add custom MCP server** and name it **Kicktipp**.
3. Under **Connection**, choose **Tunnel** and select the tunnel you created.
4. Choose **No authentication**. The local tunnel client supplies the bearer header; you are not disabling authentication on Kicktipp.
5. Review the warning, select **I understand and want to continue**, then **Create as a plugin**. Install the resulting plugin.

Keep this plugin private to people who should access your service. The tunnel uses one shared Kicktipp MCP token, which grants access to **every configured profile**. Write permissions still apply separately to each profile. Follow [OpenAI's custom MCP instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server) if the interface changes.

## 3. Check the connection

In a new ChatGPT conversation, type `@` and select **Kicktipp**, then ask:

> Call get_status and get_profiles. Show the available profiles and whether each is read-only. Do not submit or change any predictions.

A successful tool response confirms the connection. Next, ask which upcoming games need a tip. With multiple profiles, tell ChatGPT which one to use; it must pass the returned profile ID on each profile-specific call. Do not paste your tokens or Kicktipp password into the conversation.

## If something goes wrong

| Problem | What to check |
| --- | --- |
| Tunnel missing from ChatGPT | Verify its ChatGPT workspace association and your **Tunnels Read + Use** permission. A Platform organization association alone is not enough. |
| `401` from Kicktipp | Re-enter the MCP token from **Connect agent** and repeat the exports in the shell running the client. Use the MCP token, not the web administrator token or OpenAI key. |
| `doctor` reports OpenAI authentication failure | Check the runtime API key, its organization, and tunnel permissions. |
| No tools or connection error | Check `docker compose ps`, keep `tunnel-client run` alive, and rerun `doctor --profile kicktipp --explain` after stopping the client. |
| Client cannot reach localhost | Run it on the Docker host, or create an [SSH tunnel](../README.md#connect-your-agent) from its host first. `localhost` always means the computer running the client. |

Changes to available tools may require refreshing the plugin in ChatGPT. If OpenAI denies tunnel or custom MCP access, your organization or workspace administrator must enable it; changing Kicktipp settings cannot grant that access.
