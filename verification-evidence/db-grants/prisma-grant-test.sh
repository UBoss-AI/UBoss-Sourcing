set -euo pipefail
MY=/c/xampp/mysql/bin/mysql.exe
cd /c/Users/HP/Desktop/UBoss-Software/backend
eval "$(node -e "require('dotenv').config({quiet:true});const u=new URL(process.env.DATABASE_URL);console.log('export MYSQL_PWD='+JSON.stringify(decodeURIComponent(u.password))+' DBU='+JSON.stringify(decodeURIComponent(u.username))+' DBH='+u.hostname+' DBP='+(u.port||3306))")"
R="$MY -h $DBH -P $DBP -u $DBU"; DB=uboss_grantprisma; PW="gp$RANDOM$RANDOM"
cleanup() { $R -e "DROP USER IF EXISTS 'gp_app'@'localhost'; DROP USER IF EXISTS 'gp_maint'@'localhost'; DROP DATABASE IF EXISTS $DB;"; rm -f scripts/.tmp-maint-probe.ts; echo "cleanup: accounts, schema and probe removed"; }
trap cleanup EXIT
$R -e "CREATE DATABASE $DB; CREATE TABLE $DB.audit_logs LIKE uboss_test.audit_logs; CREATE TABLE $DB._prisma_migrations LIKE uboss_test._prisma_migrations;
INSERT INTO $DB.audit_logs (id, actorType, actorUserId, actorEmail, action, resourceType, ipAddress, userAgent, createdAt) VALUES ('01AAAAAAAAAAAAAAAAAAAAAAAA','CUSTOMER','01USERUSERUSERUSERUSERUSER','person@example.com','x','user','10.0.0.1','ua',NOW(3)), ('01BBBBBBBBBBBBBBBBBBBBBBBB','SYSTEM',NULL,NULL,'y','user',NULL,NULL,'2020-01-01');
CREATE USER 'gp_app'@'localhost' IDENTIFIED BY '$PW'; GRANT SELECT, INSERT, UPDATE, DELETE ON $DB.* TO 'gp_app'@'localhost';
CREATE USER 'gp_maint'@'localhost' IDENTIFIED BY '$PW';"
printf "SET @app_user='gp_app'; SET @app_host='localhost'; SET @maint_user='gp_maint'; SET @maint_host='localhost';\n" | cat - ../deploy/mariadb/post-migrate-grants.sql | $R -N -B $DB | $R -B $DB >/dev/null
DATABASE_URL="mysql://gp_app:$PW@$DBH:$DBP/$DB" DATABASE_MAINTENANCE_URL="mysql://gp_maint:$PW@$DBH:$DBP/$DB" NODE_ENV=development npx tsx scripts/.tmp-maint-probe.ts 2>&1 | grep -E "PASS|FAIL"
$R -N -e "SELECT CONCAT('rows now: ', GROUP_CONCAT(CONCAT(id,'=',IFNULL(actorEmail,'-'),'/',IFNULL(ipAddress,'-'),'/',action))) FROM $DB.audit_logs"
