# GuildMutualFriends (Vencord)

Scan a Discord server to identify members who share mutual friends with you.  
The plugin safely queries Discord’s profile APIs, caches results locally, and presents everything in a searchable modal without overwhelming rate limits.

- **Server-wide mutual discovery** — scan guild members to find users you share mutual friends with
- **Persistent cache** — results survive Discord reloads and reduce repeat API calls
- **Rate-limit aware scanning** — automatic pausing, backoff, and resume when Discord responds with 429s
- **Live progress tracking** — real-time scan progress with found counts and status indicators
- **Searchable results** — filter by username, nickname, or mutual friend name
- **One-click profiles** — open user profiles directly from the results
- **Configurable scanning** — control concurrency, delays, scan limits, and cache retention
- **Context menu integration** — launch directly from the guild right-click menu
---

## DOWNLOAD INSTRUCTIONS

You can either **git clone** the repository or **manually install** it by downloading a ZIP.

> [!WARNING]
> This plugin requires the **Vencord developer build**.  
> https://docs.vencord.dev/installing/

> [!IMPORTANT]
> Inside your `Vencord` folder, ensure there is a `src/userplugins` directory.  
> If it does not exist, create it.

---

## GIT CLONE INSTALLATION

1. Open a terminal (Command Prompt / PowerShell)
2. Navigate to your Vencord `userplugins` directory:
   ```bash
   cd Vencord/src/userplugins
