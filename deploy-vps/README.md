# Automatic updates from GitHub (one-time setup)

This folder lets you update your live site **from GitHub, with one button**. GitHub builds the new version, sends it to your server, and the server switches over to it. If the new version does not start, the server **goes back to the old one by itself**.

Do this **after** your site is already running (all of `Depoly_on_VPS.md`, including Part 14, the backups).

**Time:** about 30 minutes, once.

| File | What it is |
|---|---|
| `setup-deploy-user.sh` | Run once on the server. Creates the `deploy` user and the safety rules. |
| `deploy-activate.sh` | The only program GitHub is allowed to run on your server. |
| `../.github/workflows/deploy-vps.yml` | The **Deploy to VPS** button in GitHub. |

---

## Step 1: Switch to the release layout (the server must do this once)

**Why:** automatic updates keep each version in its own folder under `/srv/uboss/releases/`, and `/srv/uboss/current` is a **shortcut (link)** to the one in use. If you followed `Depoly_on_VPS.md` Part 7.3, `current` is a normal folder. This step turns it into a link.

> 💡 **Installing for the first time?** Do this step **instead of** Part 7.3 of `Depoly_on_VPS.md`. In Part 3, create `/srv/uboss/releases` instead of `/srv/uboss/current`.

Log in to the server (Part 2 of `Depoly_on_VPS.md`). Paste these **one at a time**.

Get the newest code, which includes this folder:

```bash
cd /srv/uboss/repo && git pull
```

Give this version a name (today's date and time):

```bash
NAME=$(date -u +%Y%m%d-%H%M%S)-manual && echo $NAME
```

✅ It prints something like `20261005-101500-manual`.

Make its folder:

```bash
mkdir -p /srv/uboss/releases/$NAME
```

Copy the backend you built in Part 7.1 into it:

```bash
rsync -a /srv/uboss/repo/backend/ /srv/uboss/releases/$NAME/backend/
```

Copy the three websites you built in Part 7.2:

```bash
rsync -a /srv/uboss/repo/apps/customer-web/dist/ /srv/uboss/releases/$NAME/customer-web/
```

```bash
rsync -a /srv/uboss/repo/apps/admin-web/dist/ /srv/uboss/releases/$NAME/admin-web/
```

```bash
rsync -a /srv/uboss/repo/apps/logistics-web/dist/ /srv/uboss/releases/$NAME/logistics-web/
```

Give the files to the app's user:

```bash
chown -R uboss:uboss /srv/uboss/releases
```

**Only if `current` is a normal folder** (you followed Part 7.3 before), move it out of the way. Skip this on a first install:

```bash
[ -L /srv/uboss/current ] || mv /srv/uboss/current /srv/uboss/current.old
```

Make `current` point at the new folder:

```bash
ln -sfn /srv/uboss/releases/$NAME /srv/uboss/current
```

Check it:

```bash
ls -l /srv/uboss/current
```

✅ **Done when:** it shows `current -> /srv/uboss/releases/20261005-...-manual`.

Restart the app so it runs from the new place:

```bash
systemctl restart uboss-api@4000 uboss-api@4001 uboss-api@4002 uboss-worker
```

✅ Open `https://shop.YOURDOMAIN.COM` - it still works. Later, when everything is fine for a few days, you can delete the old folder with `rm -rf /srv/uboss/current.old`.

---

## Step 2: Create the `deploy` user on the server

First, make sure the virus scanner is switched on for uploads. An update **refuses to run** without it, because a live shop must scan every uploaded file. This adds the setting only if it is missing:

```bash
grep -q '^MALWARE_SCANNER_DRIVER=clamav' /srv/uboss/shared/.env || echo 'MALWARE_SCANNER_DRIVER=clamav' >> /srv/uboss/shared/.env
```

Check the scanner is running:

```bash
systemctl is-active clamav-daemon
```

✅ It says `active`. ❌ If not, run `systemctl enable --now clamav-daemon` and wait 2 minutes.

Now create the user. Paste this:

```bash
bash /srv/uboss/repo/deploy-vps/setup-deploy-user.sh
```

✅ **Done when:** it ends with `OK automatic deploy setup is in place.`

❌ If it says `the uboss user does not exist yet`, your first install is not finished. Finish `Depoly_on_VPS.md` first.

Keep this server window open.

---

## Step 3: Make a key for GitHub (on your Windows computer)

A **key** is like a password file. GitHub will use it to talk to your server.

Open a **new PowerShell window** on your computer (not the server window). Paste:

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\uboss_deploy -C uboss-deploy
```

- When it asks for a **passphrase**, just press **Enter** twice (GitHub cannot type one).

✅ **Done when:** it shows a picture made of characters, and says your key was saved.

This made two files:
- `uboss_deploy` - the **private** key. It goes to GitHub only. Never share it anywhere else.
- `uboss_deploy.pub` - the **public** key. It goes to the server.

Show the public key:

```powershell
Get-Content $HOME\.ssh\uboss_deploy.pub
```

✅ It is **one line** starting with `ssh-ed25519`. Copy the whole line.

---

## Step 4: Put the public key on the server

Go back to the **server** window. Type this, then paste your line between the quotes, then press **Enter**:

```bash
bash /srv/uboss/repo/deploy-vps/setup-deploy-user.sh "PASTE-THE-ssh-ed25519-LINE-HERE"
```

✅ **Done when:** it says `adding the key with its forced command`, then `OK`.

This puts the key in `/home/deploy/.ssh/authorized_keys` **with a lock on it**: the key can run `/srv/uboss/bin/deploy-activate` and nothing else. Even if someone stole it, they could not open a terminal on your server.

**Test it** from your Windows PowerShell window. Put your server's IP address in place of `YOUR_VPS_IP`:

```powershell
ssh -i $HOME\.ssh\uboss_deploy deploy@YOUR_VPS_IP hello
```

- If it asks *"Are you sure you want to continue connecting?"*, type `yes`.

✅ **Done when:** it says `request refused`. That is **correct**: the server refuses everything except a real deploy.

❌ If it asks for a password, Step 4 did not work. Run it again and check that you pasted the whole line.

---

## Step 5: Get the server's fingerprint

GitHub must know your server's **fingerprint**, so it never sends your app to a fake server. In PowerShell:

```powershell
ssh-keyscan -t ed25519 YOUR_VPS_IP
```

✅ It prints one line starting with your IP and `ssh-ed25519`. Keep it for Step 7.

---

## Step 6: Create the "production" environment in GitHub

1. Open your project on **github.com**.
2. Click **Settings** (top right of the project, with the gear ⚙️).
3. On the left, click **Environments**.
4. Click **New environment**. Type `production`. Click **Configure environment**.
5. Tick **Required reviewers**. Type your own GitHub username (and anyone else who may approve an update). Click **Save protection rules**.

✅ **Done when:** `production` is listed, with "1 protection rule" or more.

> ⚠️ **Required reviewers is the safety switch.** Without it, anyone who can press the button can change your live site.

---

## Step 7: Add the four secrets

Still in **Settings → Environments → production**, scroll to **Environment secrets** and click **Add environment secret** four times:

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | The **private** key. In PowerShell run `Get-Content $HOME\.ssh\uboss_deploy -Raw` and copy **everything**, including the `-----BEGIN` and `-----END` lines. |
| `DEPLOY_HOST` | Your server's IP address, for example `203.0.113.10` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KNOWN_HOSTS` | The line from Step 5 |

✅ **Done when:** all four names are listed. (GitHub never shows a secret again after you save it. That is normal.)

---

## Step 8: Add the five variables

1. Go to **Settings → Secrets and variables → Actions**.
2. Click the **Variables** tab, then **New repository variable**, five times.

Replace `YOURDOMAIN.COM` with your real domain:

| Name | Value |
|---|---|
| `CUSTOMER_API_BASE` | `https://shop.YOURDOMAIN.COM/api/v1` |
| `ADMIN_API_BASE` | `https://admin.YOURDOMAIN.COM/api/v1` |
| `LOGISTICS_API_BASE` | `https://carriers.YOURDOMAIN.COM/api/v1` |
| `CUSTOMER_SITE_URL` | `https://shop.YOURDOMAIN.COM` |
| `SMOKE_URL` | `https://shop.YOURDOMAIN.COM` |

✅ **Done when:** all five are listed. No value ends with `/`.

> ❌ A wrong `..._API_BASE` gives you a site that opens but where nothing works (you cannot sign in). Check the spelling carefully.

---

## Step 9: Run an update

Whenever there is new code on GitHub that you want live:

> Running the Docker Compose install instead? It goes live on every push to `main` — see `deploy-docker/README.md`.

1. Open your project on **github.com** and click **Actions** (top menu).
2. On the left, click **Deploy to VPS**.
3. On the right, click **Run workflow**. Choose `production`. Click the green **Run workflow** button.
4. Wait about 5 minutes for **Build the release artifact** to finish.
5. A yellow box says **Waiting for review**. Click **Review deployments**, tick `production`, and click **Approve and deploy**.
6. Wait about 5 more minutes.

✅ **Done when:** every step has a green tick ✓, including **Smoke test**. Open your sites in the browser to check.

What the server does, in order:
1. Checks the file really came from this build (a checksum).
2. Puts it in a new folder under `/srv/uboss/releases/`.
3. **If there are database changes**, makes sure there is a backup from the last 30 hours, and takes one if not. **No backup, no update.**
4. Applies the database changes.
5. Points `current` at the new folder.
6. Restarts the three copies of the app **one at a time**, waiting until each says it is ready. Your site stays online.
7. **If any copy does not become ready within 2 minutes,** it points `current` back at the old folder and restarts again. The step turns red ❌ and your site keeps running the old version.

❌ **Common problems:**

| You see | What to do |
|---|---|
| `CUSTOMER_SITE_URL is not set` (or another name) | Add that variable (Step 8). |
| `Secret DEPLOY_... is not set` | Add that secret to the **production** environment (Step 7). |
| `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` is wrong. Redo Step 5 and paste the line again. |
| `Permission denied (publickey)` | The key on the server and in GitHub do not match. Redo Steps 4 and 7. |
| `the backup failed` | Backups are not set up (Part 14 of `Depoly_on_VPS.md`). Nothing was changed. |
| `rolled back to ...` | The new version did not start. Your site is on the old version. On the server, read the log: `journalctl -u uboss-api@4000 -n 50 --no-pager` |

---

## Undo an update (roll back)

If an update went through but something is wrong, go back to the version before. In the **server** window:

```bash
sudo -u uboss bash /srv/uboss/repo/deploy/scripts/rollback.sh
```

✅ **Done when:** it says `rolled back to ...`.

To see which versions are on the server (the newest is at the top):

```bash
ls -1t /srv/uboss/releases
```

To go back to one particular version, put its name at the end:

```bash
sudo -u uboss bash /srv/uboss/repo/deploy/scripts/rollback.sh 20261005-101500-manual
```

> ⚠️ A roll back changes the **app**, not the **database**. If the bad update changed the database, ask for help before rolling back.

The server keeps the **5** newest versions and deletes older ones by itself.

---

## For the technically curious

- **The lock on the key.** `/home/deploy/.ssh/authorized_keys` holds `restrict,command="/srv/uboss/bin/deploy-activate" ssh-ed25519 ...`. Whatever GitHub asks for, the server runs `deploy-activate`, which accepts only `receive uboss-<40 hex>.tgz`, `receive uboss-<40 hex>.tgz.sha256` and `activate uboss-<40 hex>.tgz`. The file is sent over that same connection (scp and sftp cannot pass a forced command).
- **Two users.** `deploy` only receives files and checks the checksum. The real work runs as `uboss` via `sudo -u uboss`. `uboss` may run, as root, only: restart `uboss-api@4000/4001/4002` and `uboss-worker`, start `uboss-backup.service`, and `/usr/local/lib/uboss/apply-grants`. The rules are in `/etc/sudoers.d/uboss-deploy-vps`.
- **Grants without `.env`.** `apply-grants.sh` normally reads `/srv/uboss/shared/.env`, which `uboss` can edit. Root never runs it that way here: the wrapper reads the database name from root-owned `/etc/uboss/deploy-vps.conf` instead.
- **One at a time.** The same lock file as `deploy/scripts/release.sh` and `rollback.sh` (`/srv/uboss/shared/.release.lock`), so a deploy and a roll back can never overlap.
- **Database changes must be additive** (new tables, new nullable columns). For a short time the old app runs on the new database. A rename or a drop needs two updates - see the top of `deploy/scripts/release.sh`.
- **Logs.** Every step is in the GitHub run, and on the server: `journalctl -t uboss-deploy -n 50 --no-pager`.
- **Re-running the setup** is safe. After `git pull`, run Step 2 again to install the newest `deploy-activate`.
