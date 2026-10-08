// Proves the proposed grant model on real MariaDB: throwaway schema + accounts, dropped at the end.
const m = require(require('module').createRequire('C:/Users/HP/Desktop/UBoss-Software/backend/package.json').resolve('mariadb'));
require(require('module').createRequire('C:/Users/HP/Desktop/UBoss-Software/backend/package.json').resolve('dotenv')).config({ path: 'C:/Users/HP/Desktop/UBoss-Software/backend/.env', quiet: true });
const u = new URL(process.env.DATABASE_URL);
const base = { host: u.hostname, port: +u.port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
const DB = 'uboss_grantcheck', P = 'gc-' + Math.random().toString(36).slice(2);
(async () => {
  const root = await m.createConnection(base);
  const q = (c, s) => c.query(s);
  const out = [];
  try {
    await q(root, `CREATE DATABASE ${DB}`);
    await q(root, `CREATE TABLE ${DB}.audit_logs LIKE uboss_test.audit_logs`);
    await q(root, `CREATE TABLE ${DB}.orders_probe (id INT PRIMARY KEY)`);
    await q(root, `INSERT INTO ${DB}.audit_logs (id, actorType, actorUserId, actorEmail, action, resourceType, ipAddress, userAgent, createdAt) VALUES ('01AAAAAAAAAAAAAAAAAAAAAAAA','CUSTOMER','01USERUSERUSERUSERUSERUSER','person@example.com','x','user','10.0.0.1','ua',NOW(3)), ('01BBBBBBBBBBBBBBBBBBBBBBBB','SYSTEM',NULL,NULL,'y','user',NULL,NULL,'2020-01-01')`);
    for (const acc of ['gc_app', 'gc_maint']) await q(root, `CREATE USER '${acc}'@'localhost' IDENTIFIED BY '${P}'`);
    // app: the production model (SELECT, INSERT database-wide; UPDATE/DELETE per table except audit_logs)
    await q(root, `GRANT SELECT, INSERT ON ${DB}.* TO 'gc_app'@'localhost'`);
    await q(root, `GRANT UPDATE, DELETE ON ${DB}.orders_probe TO 'gc_app'@'localhost'`);
    // maintenance: exactly what erasure and retention need, on audit_logs only
    await q(root, `GRANT SELECT, DELETE ON ${DB}.audit_logs TO 'gc_maint'@'localhost'`);
    await q(root, `GRANT UPDATE (actorEmail, ipAddress, userAgent) ON ${DB}.audit_logs TO 'gc_maint'@'localhost'`);
    await q(root, 'FLUSH PRIVILEGES');
    const app = await m.createConnection({ ...base, user: 'gc_app', password: P, database: DB });
    const mt = await m.createConnection({ ...base, user: 'gc_maint', password: P, database: DB });
    const tryQ = async (label, c, s, expectOk) => { try { await c.query(s); out.push(`${expectOk ? 'PASS' : 'FAIL'} ${label}: allowed`); } catch (e) { out.push(`${expectOk ? 'FAIL' : 'PASS'} ${label}: denied (${e.code})`); } };
    await tryQ('app UPDATE audit_logs', app, `UPDATE audit_logs SET actorEmail='z' WHERE 1=0`, false);
    await tryQ('app DELETE audit_logs', app, `DELETE FROM audit_logs WHERE 1=0`, false);
    await tryQ('app INSERT audit_logs', app, `INSERT INTO audit_logs (id, action, resourceType, createdAt) VALUES ('01CCCCCCCCCCCCCCCCCCCCCCCC','z','user',NOW(3))`, true);
    await tryQ('app UPDATE other table', app, `UPDATE orders_probe SET id=id WHERE 1=0`, true);
    await tryQ('maint pseudonymise (actorEmail, ipAddress, userAgent)', mt, `UPDATE audit_logs SET actorEmail='erased-x@erased.invalid', ipAddress=NULL, userAgent=NULL WHERE actorUserId='01USERUSERUSERUSERUSERUSER'`, true);
    await tryQ('maint rewrite action', mt, `UPDATE audit_logs SET action='forged' WHERE 1=0`, false);
    await tryQ('maint rewrite afterJson', mt, `UPDATE audit_logs SET afterJson=NULL WHERE 1=0`, false);
    await tryQ('maint rewrite actorUserId', mt, `UPDATE audit_logs SET actorUserId=NULL WHERE 1=0`, false);
    await tryQ('maint INSERT audit_logs', mt, `INSERT INTO audit_logs (id, action, resourceType, createdAt) VALUES ('01DDDDDDDDDDDDDDDDDDDDDDDD','z','user',NOW(3))`, false);
    await tryQ('maint retention DELETE', mt, `DELETE FROM audit_logs WHERE createdAt < '2021-01-01'`, true);
    await tryQ('maint touch other table', mt, `UPDATE orders_probe SET id=id WHERE 1=0`, false);
    const rows = await root.query(`SELECT id, actorEmail, ipAddress, userAgent, action FROM ${DB}.audit_logs ORDER BY id`);
    out.push('rows after: ' + JSON.stringify(rows));
    await app.end(); await mt.end();
  } finally {
    for (const acc of ['gc_app', 'gc_maint']) await q(root, `DROP USER IF EXISTS '${acc}'@'localhost'`).catch(() => {});
    await q(root, `DROP DATABASE IF EXISTS ${DB}`);
    out.push('cleanup: accounts and schema dropped');
    await root.end();
  }
  console.log(out.join('\n'));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
