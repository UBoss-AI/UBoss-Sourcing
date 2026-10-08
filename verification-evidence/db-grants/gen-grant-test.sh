set -euo pipefail
MY=/c/xampp/mysql/bin/mysql.exe
eval "$(cd /c/Users/HP/Desktop/UBoss-Software/backend && node -e "require('dotenv').config({quiet:true});const u=new URL(process.env.DATABASE_URL);console.log('export MYSQL_PWD='+JSON.stringify(decodeURIComponent(u.password))+' DBU='+JSON.stringify(decodeURIComponent(u.username))+' DBH='+u.hostname+' DBP='+(u.port||3306))")"
R="$MY -h $DBH -P $DBP -u $DBU"
DB=uboss_grantgen; PW="gg-$RANDOM$RANDOM"
cleanup() { $R -e "DROP USER IF EXISTS 'gg_app'@'localhost'; DROP USER IF EXISTS 'gg_maint'@'localhost'; DROP DATABASE IF EXISTS $DB;"; echo "cleanup: dropped"; }
trap cleanup EXIT
$R -e "CREATE DATABASE $DB; CREATE TABLE $DB.audit_logs LIKE uboss_test.audit_logs; CREATE TABLE $DB._prisma_migrations LIKE uboss_test._prisma_migrations; CREATE TABLE $DB.orders LIKE uboss_test.orders;
CREATE USER 'gg_app'@'localhost' IDENTIFIED BY '$PW'; GRANT SELECT, INSERT, UPDATE, DELETE ON $DB.* TO 'gg_app'@'localhost';
CREATE USER 'gg_maint'@'localhost' IDENTIFIED BY '$PW';"
run_generator() {
  printf "SET @app_user='gg_app'; SET @app_host='localhost'; SET @maint_user='gg_maint'; SET @maint_host='localhost';\n" \
    | cat - deploy/mariadb/post-migrate-grants.sql | $R -N -B $DB
}
STATEMENTS="$(run_generator)"
echo "--- generated statements:"; printf '%s\n' "$STATEMENTS" | grep -v '^SELECT' | sed 's/^/    /'
echo "--- verification:"; VER="$(printf '%s\n' "$STATEMENTS" | $R -B $DB)"; printf '%s\n' "$VER" | sed 's/^/    /'
printf '%s\n' "$VER" | grep -q 'maintenance-scoped' && echo "PASS maintenance account scoped exactly" || echo "FAIL maintenance scope"
[ "$(printf '%s\n' "$VER" | grep -c 'append-only')" -eq 2 ] && echo "PASS app account append-only on 2 tables" || echo "FAIL append-only"
# Behaviour, as the accounts themselves:
MYSQL_PWD=$PW $MY -h $DBH -P $DBP -u gg_app $DB -e "UPDATE audit_logs SET actorEmail='x' WHERE 1=0" 2>/dev/null && echo "FAIL app can update audit" || echo "PASS app cannot update audit_logs"
MYSQL_PWD=$PW $MY -h $DBH -P $DBP -u gg_maint $DB -e "UPDATE audit_logs SET actorEmail='x', ipAddress=NULL, userAgent=NULL WHERE 1=0; DELETE FROM audit_logs WHERE 1=0" && echo "PASS maint can pseudonymise and delete"
MYSQL_PWD=$PW $MY -h $DBH -P $DBP -u gg_maint $DB -e "UPDATE audit_logs SET action='x' WHERE 1=0" 2>/dev/null && echo "FAIL maint can rewrite action" || echo "PASS maint cannot rewrite action"
# Negative: widen the maintenance grant; verification must now refuse it.
$R -e "GRANT INSERT ON $DB.audit_logs TO 'gg_maint'@'localhost'"
VER2="$(run_generator | $R -B $DB)"
printf '%s\n' "$VER2" | grep -q 'MAINTENANCE GRANT WRONG' && echo "PASS widened maintenance grant is reported WRONG" || echo "FAIL widened grant not detected"
# Negative: a missing account produces no grant statements for it.
$R -e "DROP USER 'gg_maint'@'localhost'"
printf '%s\n' "$(run_generator)" | grep -q "gg_maint" | true
N="$(run_generator | grep -c "TO 'gg_maint'" || true)"; [ "$N" = "0" ] && echo "PASS no grant emitted for a missing maintenance account" || echo "FAIL emitted $N"
