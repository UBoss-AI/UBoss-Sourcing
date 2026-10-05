"""Run on the configured VPS as root; refusal cases never reach activation."""
import hashlib
import io
from pathlib import Path
import subprocess
import tarfile

incoming = Path('/var/lib/uboss-deploy/incoming')
name = 'uboss-web-' + '0' * 40 + '.tgz'
archive = incoming / name
checksum = incoming / (name + '.sha256')
if archive.exists() or checksum.exists():
    raise SystemExit('Test name is already in use')
try:
    for kind in ('traversal', 'symlink', 'checksum'):
        with tarfile.open(archive, 'w:gz') as bundle:
            member = tarfile.TarInfo('../gloviaa-deploy-gate-test')
            if kind == 'symlink':
                member.name = 'apps/customer-web/dist/test-link'
                member.type = tarfile.SYMTYPE
                member.linkname = '/tmp/gloviaa-deploy-gate-test'
                bundle.addfile(member)
            else:
                member.size = 1
                bundle.addfile(member, io.BytesIO(b'x'))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if kind == 'checksum': digest = '0' * 64
        checksum.write_text(f'{digest}  {name}\n')
        result = subprocess.run(['/usr/local/sbin/uboss-docker-activate', name],capture_output=True,text=True)
        if result.returncode == 0:
            raise SystemExit(f'{kind} was unexpectedly accepted')
        expected = 'checksum mismatch' if kind == 'checksum' else 'Unsafe archive entry refused'
        if expected not in result.stdout + result.stderr:
            raise SystemExit(f'{kind} refused for an unexpected reason: {result.stderr}')
        print(f'{kind} refusal: passed')
finally:
    archive.unlink(missing_ok=True)
    checksum.unlink(missing_ok=True)
