# Push to go live (Docker Compose install)

For a server where the shop runs as a **Docker Compose project** — a folder such
as `/srv/gloviaa` holding `compose.yml`, with nginx serving the three built
sites from `apps/customer-web/dist`, `apps/admin-web/dist` and
`apps/logistics-web/dist`.

After this one-time setup, **every push to `main` goes live by itself**:

1. GitHub runs **CI** (the tests). If CI fails, nothing is deployed.
2. When CI is green, **Deploy front ends (Docker)** builds the three sites from
   that exact commit and sends them to the server.
3. The server checks the file is the one GitHub built, saves a backup of what
   is live, and swaps the new sites in. Nothing restarts.
4. GitHub then opens each site from outside and checks it serves the new build.

**What it does not update yet:** the API, worker and media containers. Their
image is built on the server from `Dockerfile.api`; a change to `backend/`
still has to be rebuilt there by hand.

| File | What it is |
|---|---|
| `setup.sh` | Run once on the server, as root. |
| `../.github/workflows/deploy-docker.yml` | The workflow that runs after every green CI on `main`. |

The systemd layout in `Depoly_on_VPS.md` uses `deploy-vps/` instead.

---

## Step 1: Make a key for GitHub (on your Windows computer)

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\uboss_deploy -C uboss-deploy
Get-Content $HOME\.ssh\uboss_deploy.pub
```

Press **Enter** twice at the passphrase question. Copy the one line that
starts with `ssh-ed25519`.

## Step 2: Run the setup on the server

Log in as root and paste, with your line between the quotes. If your compose
folder is not `/srv/gloviaa`, put its path after the key.

```bash
curl -fsSL -o /root/uboss-deploy-setup.sh https://raw.githubusercontent.com/UBoss-AI/UBoss-Sourcing/main/deploy-docker/setup.sh
less /root/uboss-deploy-setup.sh
bash /root/uboss-deploy-setup.sh "PASTE-THE-ssh-ed25519-LINE-HERE" /srv/gloviaa
```

`less` shows the script before it runs; press **q** to leave it.

✅ **Done when:** it ends with `OK push-to-live setup is in place`.

What it creates:

- A `deploy` user with **no password**. Its key can run one program, which
  accepts only "receive this release" and "put this release live".
- That program checks the release name and its checksum, backs up the live
  sites to `/var/lib/uboss-deploy/backups/`, and copies the new ones in.

Test it from PowerShell:

```powershell
ssh -i $HOME\.ssh\uboss_deploy deploy@YOUR_SERVER_IP hello
```

✅ It says `request refused`. That is correct.

## Step 3: GitHub settings

On github.com, open the repository's **Settings**.

**Environments → New environment → `production`.** Leave **Required
reviewers** off for push-to-live. Turn it on if you want to approve every
deploy.

**Environments → production → Add environment secret**, four times:

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | Run `Get-Content $HOME\.ssh\uboss_deploy -Raw \| Set-Clipboard`, then paste. Include the BEGIN and END lines. |
| `DEPLOY_HOST` | The server's IP address |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KNOWN_HOSTS` | The line printed by `ssh-keyscan -t ed25519 YOUR_SERVER_IP` |

**Secrets and variables → Actions → Variables → New repository variable**.
These are **repository** variables, not environment ones — the build step runs
outside the environment and cannot see those. No value ends with `/`.

| Name | Value |
|---|---|
| `CUSTOMER_API_BASE` | `https://shop.YOURDOMAIN.COM/api/v1` |
| `ADMIN_API_BASE` | `https://admin.YOURDOMAIN.COM/api/v1` |
| `LOGISTICS_API_BASE` | `https://carriers.YOURDOMAIN.COM/api/v1` |
| `CUSTOMER_SITE_URL` | `https://shop.YOURDOMAIN.COM` |

The admin and carrier site addresses are taken from their `..._API_BASE` with
`/api/v1` removed.

## Step 4: Push

Push to `main`. Watch **Actions**: **CI**, then **Deploy front ends (Docker)**.

✅ **Done when:** every step is green, including **Check the live sites serve
this build**.

To deploy without a new push: **Actions → Deploy front ends (Docker) → Run
workflow**.

---

## Going back to the previous version

Each deploy prints where it saved the version it replaced. On the server:

```bash
ls -1t /var/lib/uboss-deploy/backups/
cd /srv/gloviaa && mkdir -p /root/restore && tar -xzf /var/lib/uboss-deploy/backups/web-YYYYMMDD-HHMMSS.tgz -C /root/restore
for a in customer-web admin-web logistics-web; do rsync -a --delete /root/restore/apps/$a/dist/ /srv/gloviaa/apps/$a/dist/; done
```

The ten newest backups are kept.

## When it fails

| Message | Meaning |
|---|---|
| `... is not set` | A variable or secret is missing, or a variable was added to the environment instead of the repository. |
| `Permission denied (publickey)` | Step 2 has not been run, or with a different key. |
| `checksum mismatch` | The upload was cut off. Run the workflow again. |
| `serves ..., expected ...` | The files were copied but the site still shows the old build. Check nginx serves the folders named in Step 2. |
