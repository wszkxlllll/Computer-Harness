"""Build the combined supporting-evidence PDF from reviewed sources."""
from pathlib import Path
import importlib.util, shutil, subprocess, json, hashlib, re, argparse
from pypdf import PdfReader

HERE=Path(__file__).resolve().parent
SUB=HERE.parent
ROOT=SUB.parents[1]
OUT=ROOT/'output/submission-latex'
SRC=OUT/'evidence-source'
CACHE=ROOT/'.cache/submission-evidence-build'
spec=importlib.util.spec_from_file_location('report_build',HERE/'build.py')
report=importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

def build(engine='xelatex'):
    SRC.mkdir(parents=True,exist_ok=True)
    CACHE.mkdir(parents=True,exist_ok=True)
    shutil.copy2(HERE/'preamble.tex',SRC/'preamble.tex')
    for name in ['supporting-evidence.md','real-task-cases.md']:
        shutil.copy2(SUB/name,SRC/name)
    (SRC/'evidence').mkdir(exist_ok=True)
    for p in (SUB/'evidence').glob('*'):
        if p.is_file(): shutil.copy2(p,SRC/'evidence'/p.name)
    (SRC/'figures').mkdir(exist_ok=True)
    for p in list((SUB/'evidence').glob('*.png'))+[SUB/'figures/fig05-crossapp-demo.png',SUB/'figures/fig06-shopping-correction-demo.png']:
        shutil.copy2(p,SRC/'figures'/p.name)
    parts=(SUB/'supporting-evidence.md').read_text(encoding='utf-8').split('<!-- pagebreak -->')
    texparts=[]
    for part in parts:
        tex=report.convert(part)
        tex=tex.replace(r'\begin{figure}[htbp]',r'\begin{figure}[H]')
        tex=tex.replace('height=108mm','height=112mm')
        texparts.append(tex)
    cards=(SUB/'real-task-cases.md').read_text(encoding='utf-8')
    cards=cards[cards.index('## '):]
    # Use smaller hierarchy under section six; preserve all task wording.
    cards='\n'.join('#'+line if line.startswith('#') else line for line in cards.splitlines())
    body='\n\\clearpage\n'.join(texparts)+'\n'+report.convert(cards)
    source=r'''\input{preamble}
\usepackage{xcolor}
\usepackage[normalem]{ulem}
\definecolor{evidencelink}{HTML}{145DA0}
\hypersetup{pdftitle={光语者：开源贡献与真实任务佐证},pdfauthor={应光},colorlinks=true,urlcolor=evidencelink,linkcolor=evidencelink}
\begin{document}
\fancyhead[R]{\small 开源贡献与真实任务佐证}
'''+body+r'\end{document}'
    (SRC/'04-supporting-evidence.tex').write_text(source,encoding='utf-8')
    for _ in range(2):
        p=subprocess.run([engine,'-interaction=nonstopmode','-halt-on-error','-output-directory='+str(CACHE),'04-supporting-evidence.tex'],cwd=SRC,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (CACHE/'build.txt').write_bytes(p.stdout)
        if p.returncode: raise RuntimeError('Evidence build failed; see .cache/submission-evidence-build/build.txt')
    dest=OUT/'04-supporting-evidence-links.pdf'
    compiled=CACHE/'04-supporting-evidence.pdf'
    try:
        shutil.copy2(compiled,dest)
    except PermissionError:
        dest=OUT/'04-supporting-evidence-updated.pdf'
        shutil.copy2(compiled,dest)
    info={'file':dest.name,'pages':len(PdfReader(dest).pages),'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()}
    (OUT/'evidence-build-summary.json').write_text(json.dumps(info,indent=2),encoding='utf-8')
    print(json.dumps(info,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine',default='xelatex')
    build(parser.parse_args().engine)
