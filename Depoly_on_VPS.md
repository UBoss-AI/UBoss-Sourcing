# Put Gloviaa Mart on Your Hostinger VPS: A Step-by-Step Guide

This guide is for someone doing this **for the first time**.
Follow the parts in order. Do not skip ahead.

---

## Before you start: how to use this guide

**The grey boxes are commands.** Copy one box, paste it into the black terminal window, and press **Enter**.
Wait until it finishes before you paste the next one. It has finished when you see a new line ending in `#`.

**How to paste into the terminal:** right-click inside the window. (Ctrl + V often does not work there.)

**Words in CAPITALS are yours to replace**, for example `YOURDOMAIN.COM` or `CHANGE_ME_1`. Type your own value in their place.

**If a command shows red text or the word "error":** stop. Copy the last few lines and ask for help. Do not keep going.

**Never share your passwords or keys** with anyone, in chat or in screenshots.

---

## How long it takes

About **3 to 4 hours** the first time. You can stop after any part, and carry on later from the next one.

## Track your progress

Tick each part as you finish it:

- [ ] Get Backblaze and the other things ready
- [ ] Part 1: Set up the server in Hostinger
- [ ] Part 2: Connect to the server
- [ ] Part 3: Update the server and make it safe
- [ ] Part 4: Install the programs
- [ ] Part 5: Create the database
- [ ] Part 6: Download the project and fill in the settings
- [ ] Part 7: Build the app
- [ ] Part 8: Start the app
- [ ] Part 9: Point your domain at the server
- [ ] Part 10: Configure nginx
- [ ] Part 11: Turn on https
- [ ] Part 12: Check that everything works
- [ ] Part 13: Before real customers arrive
- [ ] Part 14: Turn on automatic backups

## Words you will see

| Word | What it means |
|---|---|
| **VPS / server** | A computer in Hostinger's building that runs your website all day, every day |
| **Terminal** | The black window where you type commands |
| **SSH** | The way your computer connects to the server's terminal |
| **root** | The server's main administrator account. It can do anything. |
| **Command** | One line you paste into the terminal, followed by Enter |
| **Domain** | Your website name, for example `gloviaamart.com` |
| **Subdomain** | A name in front of the domain, for example `shop.gloviaamart.com` |
| **DNS** | The internet's address book. It turns a name into your server's IP address. |
| **IP address** | Your server's number on the internet, for example `123.45.67.89` |
| **Database** | Where all the orders, users and products are stored |
| **nginx** | The program that shows your websites to visitors |
| **SSL / https** | The padlock in the browser. It keeps visitors' data safe. |
| **Settings file (`.env`)** | One file that holds every password and setting the app needs |
| **Bucket** | A storage folder in Backblaze |

---

## What you need before you begin

Tick each one off:

- [ ] The Hostinger VPS is bought (you have done this).
- [ ] You know your domain name, for example `gloviaamart.com`, and can log in to the website where you bought it.
- [ ] A free **Backblaze B2** account with two buckets, one for uploads and one for backups. Write down the bucket names, the **Endpoint**, the **keyID** and the **applicationKey**. (The section just below shows how.)
- [ ] Email sending details (SMTP), your **live** Stripe key, a GitHub token, and a safe place for passwords. (The section after Backblaze shows how to get each one.)

---

## Get your Backblaze B2 account ready (one time, about 10 minutes)

**Why:** the app keeps uploaded pictures, invoices and backups **outside** the server. Then they survive even if the server breaks. Backblaze B2 gives you 10 GB free, and no payment card is needed.

**1. Sign up**
1. Go to **backblaze.com**, then **Sign Up**, then choose **B2 Cloud Storage**.
2. Enter your email and a strong password. Choose the region **EU Central** (close to your server). The region can't be changed later.
3. Open the confirmation email and click the link.

**2. Create the uploads bucket**
1. In the left menu, click **Buckets**, then **Create a Bucket**.
2. Name it something like `gloviaa-uploads-123`. The name must be unique worldwide, so add some numbers.
3. **Files in Bucket:** choose **Private**.
4. **Default Encryption:** choose **Enable**.
5. Click **Create a Bucket**.
6. On the new bucket, copy the **Endpoint**. It looks like `s3.eu-central-003.backblazeb2.com`. **Write it down.**

**3. Create the backups bucket**

Do the same again, with a name like `gloviaa-backups-123`. Choose **Private** and **Encryption on** again.

**4. Create a key the app can use**
1. In the left menu, click **Application Keys**, then **Add a New Application Key**.
2. **Name:** `uboss-server`.
3. **Allow access to bucket(s):** choose **All**.
4. **Type of access:** choose **Read and Write**.
5. Click **Create New Key**.
6. ⚠️ The **applicationKey** appears **only once**. Copy **keyID** and **applicationKey** into your password manager now.

✅ **Done when:** you have written down two bucket names, the Endpoint, the keyID and the applicationKey.

---

## Get the other things ready

**1. Email sending details (SMTP)**

The app uses these to send order emails and sign-up links.
- **If your email is on Hostinger:** go to hPanel → **Emails** → your mailbox → **Connect apps & devices**. Note down the **SMTP server** (usually `smtp.hostinger.com`), the **port** (`465`), your **email address** and its **password**.
- **If you use Gmail or Google Workspace:**
  1. Turn on 2-Step Verification for the account.
  2. Go to **myaccount.google.com → Security → App passwords** and make one.
  3. The server is `smtp.gmail.com`, the port is `465`, the username is your email address, and the password is the app password you just made.

**2. Stripe live keys**

1. Log in to **dashboard.stripe.com**.
2. Switch **off** "Test mode" (top right).
3. Go to **Developers → API keys**, and copy the **Secret key**. It starts with `sk_live_`.

Your Stripe account must be fully activated (business details and bank account filled in) before live keys appear.

**3. GitHub personal access token**

The server uses this to download your code.
1. On **github.com**, click your picture (top right), then **Settings**.
2. At the bottom left, click **Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
3. **Name:** `vps-download`. **Expiration:** 90 days.
4. **Repository access:** *Only select repositories*, then choose **UBoss-Sourcing**.
5. **Permissions → Contents:** **Read-only**.
6. Click **Generate token**, then copy it straight away. It starts with `github_pat_` and is shown only once.

**4. A safe place for passwords**

Use a password manager. **Bitwarden** is free (bitwarden.com). A paper notebook kept somewhere safe also works.
Throughout this guide you will create about 10 passwords and keys. Save every one there.

✅ **Done when:** you have the SMTP details, the Stripe live key and the GitHub token, all saved in your password manager.

---

## What we are building

When the guide is finished, your server will have:

| What | What it does | Address |
|---|---|---|
| The shop | Where customers and sellers shop, and where Seller Hub lives | `https://shop.YOURDOMAIN.COM` |
| The admin panel | Where your staff manage everything | `https://admin.YOURDOMAIN.COM` |
| The carrier portal | Where delivery partners work | `https://carriers.YOURDOMAIN.COM` |
| The API | The "brain" that all three websites talk to | Hidden inside the server |
| The worker | Sends emails and makes PDFs in the background | Hidden inside the server |
| The database | Stores all the data | Hidden inside the server |

---

## Part 1: Set up the server in Hostinger

**What you will do:** install a fresh operating system on the VPS.

1. Log in to **hpanel.hostinger.com**.
2. Click **VPS** in the left menu, then click your server.
3. Find **OS & Panel → Operating System**.
4. Choose **Ubuntu 24.04** (plain, with no panel and no Docker). Click **Change OS**.
5. It asks you to set a **root password**. Make a strong one and **write it down**.
6. Wait about 5–10 minutes until it says the server is running.
7. On the VPS overview page, find the **IP address**. It looks like `123.45.67.89`. **Write it down.**

✅ **Done when:** hPanel shows the server as *Running*, and you have written down both the IP address and the root password.

---

## Part 2: Connect to the server from your computer

**What you will do:** open a terminal on your Windows computer and log in to the server.

1. Press the **Windows key**, type **PowerShell**, and press **Enter**. A blue window opens.
2. Type this, putting your IP address in place of `YOUR_VPS_IP`, and press **Enter**:

```bash
ssh root@YOUR_VPS_IP
```

3. The first time, it asks *"Are you sure you want to continue connecting?"*. Type `yes` and press **Enter**.
4. It asks for a password. Type the root password from Part 1, and press **Enter**.
   **Nothing appears while you type the password. That is normal.** Type it anyway.

✅ **Done when:** you see a line like `root@srv12345:~#`. You are now *inside* the server. Every command from here on goes into this window.

> **Tip:** if the window ever closes, open PowerShell again and repeat step 2.
> **Tip:** hPanel also has a **Browser terminal** button. It works the same way, and it is your backup if SSH stops working.

---

## Part 3: Update the server and make it safe

**What you will do:** install the latest updates and turn on the firewall.

Update everything. This can take a few minutes. If a pink or purple screen asks a question, just press **Enter**.

```bash
apt update && apt upgrade -y
```

Create a special user, called `uboss`, for running the app. That way the app never has full control of the server.

```bash
adduser --system --group --home /srv/uboss uboss
```

Create the folders the app uses:

```bash
mkdir -p /srv/uboss/current /srv/uboss/shared /srv/uboss/media
```

Now the firewall. It blocks everything except the doors you open. Paste these **one at a time**.

Open the door for SSH, so you can still log in:

```bash
ufw allow OpenSSH
```

Open the doors for websites (http and https):

```bash
ufw allow 80
```

```bash
ufw allow 443
```

Switch the firewall on. If it asks *"may disrupt existing ssh connections"*, type `y` and press **Enter**.

```bash
ufw enable
```

Check it:

```bash
ufw status
```

✅ **Done when:** the status shows `Status: active`, and lists `OpenSSH`, `80` and `443`.

> ⚠️ **Safety check:** leave this window open. Open a **second** PowerShell window and log in again (Part 2). If that works, you are safe. If it does not, use hPanel's Browser terminal and run `ufw disable`.

---

## Part 4: Install the programs the app needs

**What you will do:** install Node.js (which runs the app), nginx (which shows the websites), MariaDB (the database) and a few helpers.

**Node.js version 24.** First, add the place to download it from:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
```

Now install Node.js and the helpers. This takes a few minutes.
`clamav-daemon` is a virus scanner for uploaded files. `rclone` copies backups to Backblaze.

```bash
apt install -y nodejs git nginx certbot python3-certbot-nginx clamav-daemon rclone
```

Check the Node.js version:

```bash
node -v
```

✅ It must show something starting with `v24`, for example `v24.3.0`.

**The database: MariaDB 11.4.** First, add the place to download it from:

```bash
curl -LsS https://r.mariadb.com/downloads/mariadb_repo_setup | bash -s -- --mariadb-server-version=11.4
```

```bash
apt install -y mariadb-server
```

Make the database safe:

```bash
mariadb-secure-installation
```

It asks some questions:
- *"Enter current password for root"*: just press **Enter**.
- *Switch to unix_socket authentication*: type `n`.
- *Change the root password?*: type `y`, then make a **new strong password** and write it down.
- Every other question: type `y`.

✅ **Done when:** it says *"Thanks for using MariaDB!"*.

---

## Part 5: Create the database

**What you will do:** create an empty database, plus four accounts that the app uses to reach it.

First, think of **four new strong passwords**. Write them down as:
- `CHANGE_ME_1`, for the app
- `CHANGE_ME_2`, for updates
- `CHANGE_ME_3`, for clean-up
- `CHANGE_ME_4`, for backups

> **Easy way to make a strong password:** run `openssl rand -hex 16` and copy what it prints. Use letters and numbers only.

Open the database. It asks for the MariaDB root password from Part 4.

```bash
mariadb -u root -p
```

The line now starts with `MariaDB [(none)]>`.

Before pasting, put your own passwords in place of `CHANGE_ME_1` to `CHANGE_ME_4`. The easiest way is to edit the block in Notepad first. Then paste the whole block:

```sql
CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'uboss_app'@'localhost' IDENTIFIED BY 'CHANGE_ME_1';
CREATE USER 'uboss_migrate'@'localhost' IDENTIFIED BY 'CHANGE_ME_2';
CREATE USER 'uboss_maintenance'@'localhost' IDENTIFIED BY 'CHANGE_ME_3';
CREATE USER 'uboss_backup'@'localhost' IDENTIFIED BY 'CHANGE_ME_4';
GRANT ALL PRIVILEGES ON uboss.* TO 'uboss_migrate'@'localhost';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON uboss.* TO 'uboss_backup'@'localhost';
EXIT;
```

**Why four accounts?** If one password ever leaks, the damage stays small.

| Account | Used for | What it may do |
|---|---|---|
| `uboss_app` | The running app | Read and write the shop's data. It can never change the audit log, the record of who did what. |
| `uboss_migrate` | Updating the app | Create and change tables |
| `uboss_maintenance` | Automatic clean-up | Remove old audit records, and erase a person's data when they ask |
| `uboss_backup` | The nightly backup | Read only |

The `uboss_app` and `uboss_maintenance` permissions are set later, in Part 7.

**Check that the database is hidden from the internet:**

```bash
ss -ltn | grep 3306
```

✅ It must show `127.0.0.1:3306`.

❌ If it shows `0.0.0.0:3306`, fix it like this:
1. Open the file:

   ```bash
   nano /etc/mysql/mariadb.conf.d/50-server.cnf
   ```

2. Find the line `bind-address`, and change it to `bind-address = 127.0.0.1`.
3. Save and close the file (see the box below).
4. Restart the database:

   ```bash
   systemctl restart mariadb
   ```

> **How to use `nano` (the text editor):**
> - Move around with the **arrow keys**. Type normally.
> - **Save and close:** press **Ctrl + X**, then **Y**, then **Enter**.
> - **To find a word:** press **Ctrl + W**, type it, and press **Enter**.

---

## Part 6: Download the project and fill in the settings

**What you will do:** copy the project onto the server, then give it your passwords and settings.
**Time:** about 20 minutes.

### Step 6.1: Download the project

Paste this. Put your GitHub username in place of `YOUR_GITHUB_USERNAME`:

```bash
cd /srv/uboss && git clone https://github.com/YOUR_GITHUB_USERNAME/UBoss-Sourcing.git repo
```

It asks two questions:
- **Username:** type your GitHub username, then press **Enter**.
- **Password:** paste your **GitHub token** (it starts with `github_pat_`), then press **Enter**. Nothing appears while you paste. That is normal.

✅ **Done when:** the last line says `done.`

❌ If it says `Authentication failed`, the token is wrong or has expired. Make a new one (see "Get the other things ready") and try again.

### Step 6.2: Make four secret keys

Paste this **one** command. It prints 4 long random codes:

```bash
for i in 1 2 3 4; do openssl rand -hex 32; done
```

Keep them for the next step.

### Step 6.3: Fill in your settings sheet in Notepad

1. Open **Notepad** on your computer.
2. Copy this sheet into it.
3. Replace every `<...>` with your own value. Take the passwords from your password manager, and the 4 secret keys from Step 6.2.

```
NODE_ENV=production
DATABASE_URL=mysql://uboss_app:<CHANGE_ME_1>@localhost:3306/uboss
DATABASE_MAINTENANCE_URL=mysql://uboss_maintenance:<CHANGE_ME_3>@localhost:3306/uboss
MIGRATE_DATABASE_URL=mysql://uboss_migrate:<CHANGE_ME_2>@localhost:3306/uboss
CUSTOMER_WEB_ORIGIN=https://shop.<YOURDOMAIN.COM>
ADMIN_WEB_ORIGIN=https://admin.<YOURDOMAIN.COM>
LOGISTICS_WEB_ORIGIN=https://carriers.<YOURDOMAIN.COM>
COOKIE_SECURE=true
REALTIME_BUS_DRIVER=database
QUEUE_DRIVER=database
SESSION_COOKIE_SECRET=<secret key 1>
ACCESS_TOKEN_SECRET=<secret key 2>
REFRESH_TOKEN_SECRET=<secret key 3>
SECRETS_ENCRYPTION_KEY=<secret key 4>
STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
S3_REGION=eu-central-003
S3_BUCKET=gloviaa-uploads-123
S3_ACCESS_KEY_ID=<Backblaze keyID>
S3_SECRET_ACCESS_KEY=<Backblaze applicationKey>
S3_FORCE_PATH_STYLE=true
S3_SSE=AES256
EMAIL_DRIVER=smtp
SMTP_HOST=<for example smtp.hostinger.com>
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<your email address>
SMTP_PASSWORD=<your email password>
STRIPE_SECRET_KEY=<sk_live_...>
```

✅ **Done when:** there is **no `<` or `>` left anywhere** in the sheet.

### Step 6.4: Create the settings file

This command copies the example settings file into place, then makes it private so only the app can read it:

```bash
cp /srv/uboss/repo/backend/.env.example /srv/uboss/shared/.env && chmod 600 /srv/uboss/shared/.env && chown uboss:uboss /srv/uboss/shared/.env
```

### Step 6.5: Paste your sheet at the end of the file

You **don't need to search** for anything. Anything written at the **bottom** of the file replaces the same setting higher up.

1. Open the file:

   ```bash
   nano /srv/uboss/shared/.env
   ```

2. Jump to the very end: press **Ctrl + End**. If that does nothing, hold **Page Down** until you reach the end.
3. Press **Enter** twice, to start a new empty line.
4. In Notepad, press **Ctrl + A**, then **Ctrl + C**, to copy your whole sheet.
5. In the terminal, **right-click** to paste it.
6. Save and close: press **Ctrl + X**, then **Y**, then **Enter**.

### Step 6.6: Check it

Paste this. It shows the important lines, with the passwords hidden:

```bash
grep -E '^(NODE_ENV|STORAGE_DRIVER|EMAIL_DRIVER|COOKIE_SECURE|REALTIME_BUS_DRIVER|S3_BUCKET)=' /srv/uboss/shared/.env | tail -6
```

✅ **Done when:** it shows `production`, `s3`, `smtp`, `true`, `database` and `gloviaa-uploads-123`.

Now close Notepad **without saving**.

> 💡 **If a setting is wrong**, the app refuses to start in Part 8, and tells you which one. Open the file again (Step 6.5), go to the end, fix that line, and save.

---

## Part 7: Build the app

**What you will do:** turn the code into a finished app. Mostly this means pasting and waiting.
**Time:** about 30–40 minutes, mostly waiting.

> **Before you start:** in every block below, replace `YOURDOMAIN.COM` with your real domain. The easiest way is to copy the block into Notepad, use **Edit → Replace**, then copy it back.

### Step 7.1: Build the backend

Paste this whole block at once. It:
- loads your settings
- installs the parts the backend needs
- builds the backend
- creates the database tables
- locks down the database accounts
- adds the starting data (currencies, countries and so on)

**It takes 10–15 minutes.** Don't close the window.

```bash
set -a; . /srv/uboss/shared/.env; set +a
cd /srv/uboss/repo/backend
npm ci && npm run build
DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy
bash /srv/uboss/repo/deploy/scripts/apply-grants.sh
npm run db:reference
```

✅ **Done when:**
- you see *"All migrations have been successfully applied"*
- you see green `+` lines from the grants step
- the block ends with no red `error`

❌ **Common problems:**

| You see | What to do |
|---|---|
| `Access denied for user 'uboss_migrate'` | The `CHANGE_ME_2` password in your sheet doesn't match Part 5. Fix it in the settings file (Step 6.5), then paste this block again. |
| `the audit maintenance account does not exist` | You skipped a line in Part 5. Redo Part 5, then paste this block again. |
| `npm ERR!` | Copy the last 10 lines, and ask for help. |

> ⚠️ **Never** run `prisma migrate dev` on the server. Always `migrate deploy`.

### Step 7.2: Build the three websites

Paste this whole block (with your domain filled in). It builds the shop, the admin panel and the carrier portal, one after another. **It takes about 10 minutes.**

```bash
cd /srv/uboss/repo/apps/customer-web && npm ci && VITE_API_BASE_URL=https://shop.YOURDOMAIN.COM/api/v1 VITE_PUBLIC_SITE_URL=https://shop.YOURDOMAIN.COM npm run build
cd /srv/uboss/repo/apps/admin-web && npm ci && VITE_API_BASE_URL=https://admin.YOURDOMAIN.COM/api/v1 npm run build
cd /srv/uboss/repo/apps/logistics-web && npm ci && VITE_API_BASE_URL=https://carriers.YOURDOMAIN.COM/api/v1 npm run build
```

✅ **Done when:** you see `✓ built in ...` **three times**.

### Step 7.3: Put the finished app in place

This copies the finished backend and the three websites into the folder the server runs from:

```bash
cd /srv/uboss
rsync -a --delete repo/backend/ current/backend/
rsync -a --delete repo/apps/customer-web/dist/ current/customer-web/
rsync -a --delete repo/apps/admin-web/dist/ current/admin-web/
rsync -a --delete repo/apps/logistics-web/dist/ current/logistics-web/
chown -R uboss:uboss /srv/uboss
ls current
```

✅ **Done when:** the last line shows four names: `admin-web`, `backend`, `customer-web` and `logistics-web`.


## Part 8: Start the app

**What you will do:** start the API and the worker, and make sure they start again by themselves after a restart.

Copy the project's ready-made start-up files into place:

```bash
cp /srv/uboss/repo/deploy/systemd/uboss-* /etc/systemd/system/
```

Tell the server about them:

```bash
systemctl daemon-reload
```

Start three copies of the API, plus one worker. Three copies means that if one is restarting, the others keep the site running.

```bash
systemctl enable --now uboss-api@4000 uboss-api@4001 uboss-api@4002 uboss-worker
```

Check that they are running:

```bash
systemctl status uboss-api@4000 --no-pager
```

```bash
systemctl status uboss-worker --no-pager
```

✅ Both say **`active (running)`** in green.

❌ If one says `failed`, look at its log:

```bash
journalctl -u uboss-api@4000 -n 30 --no-pager
```

The log names the setting that is wrong. Fix it like this:
1. Open the settings file:

   ```bash
   nano /srv/uboss/shared/.env
   ```

2. Correct the setting, then save and close.
3. Restart the app:

   ```bash
   systemctl restart uboss-api@4000 uboss-api@4001 uboss-api@4002 uboss-worker
   ```

> ⚠️ Always run **only one** worker. Two workers would send every email twice.

---

## Part 9: Point your domain at the server

**What you will do:** tell the internet that `shop.`, `admin.` and `carriers.` on your domain live on this server.

1. Log in to the website where you manage your domain's DNS. That may be Hostinger, Cloudflare, GoDaddy or another company.
2. Open **DNS settings** (sometimes called *DNS records* or *Manage DNS*).
3. Add **three** records like this:

| Type | Name | Points to / Value | TTL |
|---|---|---|---|
| A | `shop` | YOUR_VPS_IP | 300 (or Auto) |
| A | `admin` | YOUR_VPS_IP | 300 (or Auto) |
| A | `carriers` | YOUR_VPS_IP | 300 (or Auto) |

4. Save. Then wait **10–30 minutes**.

> If your DNS is with **Cloudflare**, set each record's cloud to **grey (DNS only)** for now. You can turn it orange later.

**Check it from your Windows computer.** Open a *new* PowerShell window; don't use the server window.

```powershell
nslookup shop.YOURDOMAIN.COM
```

✅ **Done when:** the result shows your VPS IP address. Check `admin` and `carriers` the same way.

---

## Part 10: Configure nginx (the program that shows your websites)

**What you will do:** set up nginx to show the three websites, and to send requests for `/api/v1` to the app.

Go back to the **server** window.

Copy the project's ready-made nginx files:

```bash
cp -r /srv/uboss/repo/deploy/nginx/snippets/* /etc/nginx/snippets/
```

```bash
cp /srv/uboss/repo/deploy/nginx/uboss.conf /etc/nginx/sites-available/uboss.conf
```

Replace the placeholder domain with yours. Type your real domain, for example `gloviaamart.com`:

```bash
sed -i 's/example\.com/YOURDOMAIN.COM/g' /etc/nginx/sites-available/uboss.conf
```

Switch the site on, and switch off nginx's default welcome page:

```bash
ln -s /etc/nginx/sites-available/uboss.conf /etc/nginx/sites-enabled/
```

```bash
rm -f /etc/nginx/sites-enabled/default
```

---

## Part 11: Turn on https (the padlock 🔒)

**What you will do:** get free security certificates, so that your sites open with `https://`.

Paste this, with your domain in place of `YOURDOMAIN.COM`:

```bash
certbot --nginx -d shop.YOURDOMAIN.COM -d admin.YOURDOMAIN.COM -d carriers.YOURDOMAIN.COM
```

It asks a few things:
- **Your email**: type it. It is used for expiry warnings.
- **Agree to the terms**: type `y`.
- **Share your email**: type `n`.

Now test nginx's settings:

```bash
nginx -t
```

✅ It says `syntax is ok` and `test is successful`.

Apply the settings:

```bash
systemctl reload nginx
```

Check that the certificates will renew themselves every 3 months:

```bash
certbot renew --dry-run
```

✅ It says *"Congratulations, all simulated renewals succeeded"*.

> ❌ If `certbot` fails with *"DNS problem"*, Part 9 is not finished yet. Wait longer and try again.

---

## Part 12: Check that everything works

**Test 1: the server says it is ready.** In the server window:

```bash
curl -s https://shop.YOURDOMAIN.COM/health/ready
```

✅ It prints a short message saying the system is ready (not an error).

**Test 2: open each site in your browser:**
- `https://shop.YOURDOMAIN.COM`
- `https://admin.YOURDOMAIN.COM`
- `https://carriers.YOURDOMAIN.COM`

✅ Each one shows a padlock 🔒 and its sign-in page. Sign in to each one.

**Test 3: the app survives a restart.** In the server window:

```bash
reboot
```

Wait 2 minutes, then open the sites again. ✅ They come back by themselves.

---

## Part 13: Before real customers arrive

Go through this list in the **admin panel** and tick each item off:

- [ ] **Remove the test accounts** made during development. Create real staff accounts under **Staff**.
- [ ] **Set up currencies.** Give every product a price in each currency you sell in. Turn those currencies on in your Stripe account too.
- [ ] **Connect payments.** In your Stripe dashboard, go to **Developers → Webhooks → Add endpoint**, and enter:
  `https://shop.YOURDOMAIN.COM/api/v1/payments/webhooks/stripe`
  Then copy its **Signing secret** into the admin panel under **Integrations**.
  *(Razorpay: the same, but ending `/webhooks/razorpay`.)*
  ⚠️ This step is essential. An order is only confirmed through this webhook.
- [ ] **Place one real test order** and check that the confirmation email arrives.
- [ ] **Give each business customer payment terms** in their currency.
- [ ] **Publish your Terms and Conditions** before anybody signs up.
- [ ] **Run the data check:** go to **Settings → Master data**, then the go-live check.
- [ ] **Check who has admin access.** Remove anyone who shouldn't have it.
- [ ] **Change every key** that was used during development: Stripe, email, AI and so on.
- [ ] **Set up an uptime alert.** Make a free account at **uptimerobot.com** and add a monitor for
  `https://shop.YOURDOMAIN.COM/health/live`. It emails you if the site goes down.

---

## Part 14: Turn on automatic backups

**Why:** if the server breaks, a Hostinger snapshot breaks with it. Real backups must live **somewhere else**. We use your Backblaze **backups** bucket.

**Step 1: Connect the server to Backblaze.**

```bash
rclone config
```

Answer the questions:
- `n` for a *new remote*. For the name, type `b2`.
- Storage type: type `b2` (Backblaze B2) and press **Enter**.
- **account**: paste your Backblaze **keyID**.
- **key**: paste your Backblaze **applicationKey**.
- For everything else, just press **Enter**. At the end, type `q` to quit.

Check that it works. It should print the names of your two buckets:

```bash
rclone lsd b2:
```

**Step 2: Make a backup password.** Run this, and save the result in your password manager:

```bash
openssl rand -hex 32
```

⚠️ **Without this password, your backups can never be opened.** Keep it safe, and keep it off the server.

**Step 3: Add the backup settings:**

```bash
nano /srv/uboss/shared/.env
```

Add these three lines at the bottom. Use your `CHANGE_ME_4` password, the backup password from step 2, (the bucket name is already filled in).

```
UBOSS_BACKUP_DATABASE_URL=mysql://uboss_backup:CHANGE_ME_4@localhost:3306/uboss
UBOSS_BACKUP_PASSPHRASE=YOUR_BACKUP_PASSWORD
UBOSS_OFFSITE_REMOTE=b2:gloviaa-backups-123
```

Save and close.

**Step 4: Switch on the nightly backup and the health monitor:**

```bash
systemctl enable --now uboss-backup.timer uboss-monitor.timer
```

**Step 5: Run one backup now, to test it:**

```bash
systemctl start uboss-backup
```

```bash
journalctl -u uboss-backup -n 20 --no-pager
```

✅ The log shows no errors, and a new backup file appears in your backups bucket on backblaze.com (Buckets → Browse Files).

Backups now run every night. They are encrypted and kept for 14 days.
**Once a month**, test restoring one, so you know it really works.

---

## Part 15: Updating to a new version later

Whenever new code is pushed to GitHub, follow these steps.

1. **Take a backup first:**

   ```bash
   systemctl start uboss-backup
   ```

2. **Download the new code:**

   ```bash
   cd /srv/uboss/repo && git pull
   ```

3. **Build it:** do **all of Part 7** again (7a, 7b and 7c).

4. **Restart the app one copy at a time**, so the site stays online:

   ```bash
   systemctl restart uboss-api@4000 && sleep 10 && systemctl restart uboss-api@4001 && sleep 10 && systemctl restart uboss-api@4002 && systemctl restart uboss-worker
   ```

5. **Check:** open the sites in your browser, and run Test 1 from Part 12.

> **Later on**, once you are comfortable, the project can do all of this automatically from GitHub, with a button and an automatic undo if something fails. Ask for help setting up the **Deploy** workflow.

---

## Quick help: common problems

| Problem | What to do |
|---|---|
| A site shows **502 Bad Gateway** | The app is not running. Run `systemctl status uboss-api@4000 --no-pager`, then read its log as in Part 8. |
| The site doesn't open at all | Check that DNS is working (Part 9) and that the firewall allows 80 and 443 (Part 3). |
| No padlock, or a "not secure" warning | Run the `certbot` command from Part 11 again. |
| `Permission denied` | Run `chown -R uboss:uboss /srv/uboss`, then restart the app. |
| You can't log in with SSH | In hPanel, open **Browser terminal**, then run `ufw allow OpenSSH`. |
| The server is out of disk space | Run `df -h`, then ask for help before deleting anything. |
