"""Local checks of GENERATED audit artifacts only; not the user's repository CI."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import yaml

root = Path(__file__).resolve().parents[1]
checks = []

def record(name, detail):
    checks.append({'name': name, 'result': 'pass', 'detail': detail})

pins = {
    'actions/checkout': {'major': 'v6', 'sha': 'd23441a48e516b6c34aea4fa41551a30e30af803'},
    'actions/setup-node': {'major': 'v6', 'sha': '249970729cb0ef3589644e2896645e5dc5ba9c38'},
    'pnpm/action-setup': {'major': 'v4', 'sha': 'b906affcce14559ad1aafd4ab0e942779e9f58b1'},
    'actions/upload-artifact': {'major': 'v4', 'sha': 'ea165f8d65b6e75b540449e92b4886f43607fa02'},
}
for name, entry in pins.items():
    entry['source'] = f'https://github.com/{name}/commit/{entry["sha"]}'
(root / 'verification/action-pins.json').write_text(json.dumps({
    'queriedOn': '2026-09-17',
    'method': 'GitHub connector: official tag references; pnpm annotated tag dereferenced to commit',
    'actions': pins,
}, indent=2, ensure_ascii=False) + '\n', encoding='utf8')

for f in sorted((root / 'templates').rglob('*.yml')):
    # BaseLoader retains "on" as a string rather than YAML 1.1's boolean conversion.
    value = yaml.load(f.read_text('utf8'), Loader=yaml.BaseLoader)
    assert isinstance(value, dict), f
    if f.parent.name == 'workflows':
        assert {'name', 'on', 'jobs', 'permissions'} <= value.keys(), f
        assert value['permissions'] == {'contents': 'read'}, f
        assert 'pull_request_target' not in value['on'], f
        for job in value['jobs'].values():
            assert 'self-hosted' not in str(job.get('runs-on', '')), f
            assert int(job['timeout-minutes']) > 0
            for step in job['steps']:
                if 'uses' in step:
                    name, sha = step['uses'].split('@')
                    assert re.fullmatch('[0-9a-f]{40}', sha)
                    assert pins[name]['sha'] == sha
                assert 'secrets.' not in str(step), f
                if step.get('name', '').startswith('Upload'):
                    path = step['with']['path']
                    assert all(x not in path for x in ['runs/', '.env', 'provider-exchanges', '**'])
        record(f'{f.name}: YAML and structural checks', 'Readonly permissions, pinned actions, bounded jobs; no live runner, secrets, or raw-run upload.')
    else:
        assert value['version'] == '2'
        record(f'{f.name}: YAML parse', 'Dependabot configuration parses.')

candidate = root / 'templates/scripts/create-source-candidate.mjs'
subprocess.run(['node', '--check', str(candidate)], check=True, capture_output=True, text=True)
record('candidate script syntax', 'node --check passed.')

with tempfile.TemporaryDirectory(prefix='harness-audit-template-') as tmp:
    tmp = Path(tmp)
    def git(*args):
        return subprocess.run(['git', *args], cwd=tmp, check=True, capture_output=True, text=True)
    git('init', '-q')
    (tmp / 'packages/computer-cua').mkdir(parents=True)
    (tmp / 'package.json').write_text('{"private":true,"packageManager":"pnpm@11.19.0"}\n')
    (tmp / 'packages/computer-cua/package.json').write_text('{"dependencies":{"@trycua/cua-driver":"0.22.2"}}\n')
    (tmp / 'pnpm-lock.yaml').write_text('lockfileVersion: "9.0"\n')
    (tmp / '.gitignore').write_text('runs/\nrelease-assets/\n')
    git('add', '.')
    git('-c', 'user.name=Audit fixture', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'synthetic fixture')
    (tmp / 'runs').mkdir()
    (tmp / 'runs/ignored-synthetic.txt').write_text('not part of source candidate')
    first = subprocess.run(['node', str(candidate)], cwd=tmp, check=True, capture_output=True, text=True)
    out = tmp / 'release-assets'
    manifest = json.loads((out / 'manifest.json').read_text())
    assert manifest['commit'] == git('rev-parse', 'HEAD').stdout.strip()
    assert manifest['kind'] == 'source-only'
    for line in (out / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ')
        assert hashlib.sha256((out / name).read_bytes()).hexdigest() == digest
    with tarfile.open(out / 'source.tar.gz', 'r:gz') as tar:
        names = tar.getnames()
        assert 'Computer-Harness/package.json' in names
        assert not any('/runs/' in name for name in names)
    record('candidate synthetic repository smoke', 'Archive contains tracked fixture source only; commit manifest and both checksums verified. No product build or install ran.')
    again = subprocess.run(['node', str(candidate)], cwd=tmp, capture_output=True, text=True)
    assert again.returncode != 0
    record('candidate refuses existing output', 'Second invocation failed rather than overwriting candidate.')
    shutil.rmtree(out)
    (tmp / 'package.json').write_text('{"private":true}\n')
    dirty = subprocess.run(['node', str(candidate)], cwd=tmp, capture_output=True, text=True)
    assert dirty.returncode != 0 and 'uncommitted' in dirty.stderr
    record('candidate refuses tracked modifications', 'Dirty source was rejected before archive creation.')

text_files = []
for f in root.rglob('*'):
    if not f.is_file() or f.suffix not in {'.md', '.json', '.mjs', '.yml', '.py', '.tap'}:
        continue
    text = f.read_text('utf8')
    if f.name != 'validate-deliverables.py':
        assert '\ufffd' not in text, f
    text_files.append(f)
record('UTF-8 readback', f'{len(text_files)} generated text files read without replacement characters.')

result = {
    'scope': 'Generated deliverables only. No repository dependency install, full typecheck/Vitest, live API, desktop, or GitHub Actions execution.',
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'checks': checks,
}
(root / 'verification/template-checks.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
print(json.dumps(result, indent=2, ensure_ascii=False))
