import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
files = sorted((root / 'addon').rglob('*.js')) + sorted((root / 'tests').glob('*.js'))
for path in files:
    subprocess.run(['node', '--check', str(path)], check=True)
print(f'Syntax checks passed: {len(files)} JavaScript files')
