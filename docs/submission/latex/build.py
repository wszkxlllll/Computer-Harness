"""Build editable XeLaTeX submission files from the reviewed Markdown sources."""
from pathlib import Path
import re, shutil, subprocess, argparse, json

HERE = Path(__file__).resolve().parent
SUB = HERE.parent
ROOT = SUB.parents[1]
OUT = ROOT / 'output' / 'submission-latex'
SRC = OUT / 'source'
BUILD = ROOT / '.cache' / 'submission-latex-build'

def esc(s):
    chars = {'\\':r'\textbackslash{}','&':r'\&','%':r'\%','$':r'\$','#':r'\#','_':r'\_','{':r'\{','}':r'\}','~':r'\textasciitilde{}','^':r'\textasciicircum{}'}
    return ''.join(chars.get(c,c) for c in s)

def inline(s):
    tokens=[]
    def link_target(url):
        if url.startswith('../evidence/'):
            return 'https://github.com/wszkxlllll/Computer-Harness/blob/main/docs/evidence/'+url[len('../evidence/'):]
        return url
    def hold(v):
        tokens.append(v); return f'ZZTOKEN{len(tokens)-1}ZZ'
    s=re.sub(r'\$([^$\n]+)\$',lambda m:hold('$'+m[1]+'$'),s)
    s=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',lambda m:hold(r'\url{'+link_target(m[2])+'}' if m[1]==m[2] else r'\href{'+link_target(m[2]).replace('%',r'\%')+r'}{\uline{'+esc(m[1])+'}}'),s)
    s=re.sub(r'https?://[A-Za-z0-9./_%?=&:#~+\-]+',lambda m:hold(r'\url{'+m[0]+'}'),s)
    s=re.sub('[①②③④⑤⑥⑦⑧⑨]',lambda m:hold(r'\textcircled{\scriptsize '+str(ord(m[0])-ord('①')+1)+'}'),s)
    s=re.sub(r'`([^`]+)`',lambda m:hold(r'\texttt{'+esc(m[1])+'}'),s)
    s=re.sub(r'\*\*([^*]+)\*\*',lambda m:hold(r'\textbf{'+esc(m[1])+'}'),s)
    s=esc(s)
    for i,t in reversed(list(enumerate(tokens))): s=s.replace(f'ZZTOKEN{i}ZZ',t)
    return s

def convert(text, report=False):
    lines=text.splitlines(); out=[]; i=0
    if report:
        i=next(j for j,l in enumerate(lines) if l.startswith('## 一、'))
    while i<len(lines):
        l=lines[i].strip(); i+=1
        if not l: continue
        if l=='$$':
            formula=[]
            while i<len(lines) and lines[i].strip()!='$$': formula.append(lines[i]); i+=1
            i+=1
            out += [r'\begin{equation}', '\n'.join(formula), r'\end{equation}']
            continue
        if l=='~~~algorithm':
            algorithm=[]
            while i<len(lines) and lines[i].strip()!='~~~': algorithm.append(lines[i]); i+=1
            i+=1
            # Keep the first explanatory reference and its algorithm together.
            introduction=[]
            if len(out)>=2 and out[-1]=='' and out[-2].startswith('算法1是'):
                introduction=[out[-2]+r'\par\medskip']
                del out[-2:]
            out += [r'\begin{figure}[htbp]\noindent\begin{minipage}{\linewidth}']+introduction+[r'\hrule\vspace{5pt}',r'{\sffamily\bfseries '+inline(algorithm[0])+r'}\par\vspace{4pt}',r'\fontsize{10}{13}\selectfont\begin{algorithmic}[1]']
            blocks=[]
            for raw in algorithm[1:]:
                indent=len(raw)-len(raw.lstrip()); step=raw.strip()
                while blocks and indent<=blocks[-1][0]:
                    out.append('\\End'+blocks.pop()[1])
                if step.startswith(('Input:','Output:')):
                    command='Require' if step.startswith('Input:') else 'Ensure'
                    out.append('\\'+command+' '+inline(step.split(':',1)[1].strip()))
                    continue
                match=re.match(r'^(while|for|if) (.*):$',step)
                if match:
                    command={'while':'While','for':'For','if':'If'}[match[1]]
                    out.append('\\'+command+'{'+inline(match[2])+'}')
                    blocks.append((indent,command))
                else:
                    out.append(r'\State '+inline(step).replace('&lt;-',r'$\gets$').replace('<-',r'$\gets$'))
            while blocks: out.append('\\End'+blocks.pop()[1])
            out += [r'\end{algorithmic}\vspace{4pt}\hrule\end{minipage}\end{figure}']
            continue
        img=re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)',l)
        if img:
            while i<len(lines) and not lines[i].strip(): i+=1
            caption=lines[i].strip() if i<len(lines) and re.match(r'图[A-Z]?\d',lines[i]) else img[1]
            if i<len(lines) and re.match(r'图[A-Z]?\d',lines[i]): i+=1
            file=Path(img[2]).name
            height='132mm' if file.startswith(('fig01','fig02')) else '108mm'
            placement='H' if report and file.startswith(('fig05','fig06')) else 'htbp'
            out += [r'\begin{figure}['+placement+r']\centering',r'\includegraphics[width=0.96\linewidth,height='+height+r',keepaspectratio]{'+file+'}',r'\caption{'+inline(caption)+'}',r'\end{figure}']
        elif l.startswith('#'):
            level=len(l)-len(l.lstrip('#')); title=l[level:].strip()
            if report and title.startswith('5.5 '): out.append(r'\FloatBarrier')
            if report and title.startswith('九、'):
                out += [r'\label{bodyend}\clearpage',r'\mainsection{'+inline(title)+'}']
            else:
                command='mainsection' if level<=2 else 'subheading' if level==3 else 'minorheading'
                out += ['\\'+command+'{'+inline(title)+'}']
        elif l.startswith('>'):
            para=[l.lstrip('> ').strip()]
            while i<len(lines) and lines[i].startswith('>'): para.append(lines[i].lstrip('> ').strip()); i+=1
            out += [r'\begin{quote}\sloppy',inline('\n'.join(para)).replace('\n',r'\par '),r'\end{quote}']
        elif l.startswith('|') and i<len(lines) and re.match(r'^\|[\s:|\-]+\|$',lines[i].strip()):
            heads=[c.strip() for c in l.strip('|').split('|')];i+=1;rows=[]
            while i<len(lines) and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')]);i+=1
            widths=[.17,.27,.39,.17] if len(heads)==4 else [1/len(heads)]*len(heads)
            available=r'\dimexpr\linewidth-'+str(2*len(heads))+r'\tabcolsep\relax'
            spec=''.join(r'>{\raggedright\arraybackslash}p{'+str(w)+r'\dimexpr'+r'\linewidth-'+str(2*len(heads))+r'\tabcolsep\relax}' for w in widths)
            out += [r'\begingroup\small\setlength{\tabcolsep}{4pt}\renewcommand{\arraystretch}{1.35}',r'\begin{longtable}{'+spec+r'}\toprule', ' & '.join(r'\textbf{'+inline(h)+'}' for h in heads)+r' \\ \midrule\endhead']
            for row in rows:
                assert len(row)==len(heads)
                out += [' & '.join(inline(c) for c in row)+r' \\']
            out += [r'\bottomrule\end{longtable}\endgroup']
        else:
            out += [inline(l), '']
    return '\n'.join(out)

def resource_table():
    rows=[]
    for line in (SUB/'third-party-resources.md').read_text(encoding='utf-8').splitlines():
        if re.match(r'\|\s*\d',line): rows.append([x.strip() for x in line.strip('|').split('|')])
    heads=['序号','资源名称及类型','版本/来源','许可证/授权类型','使用/开放方式','关键义务/限制','团队自主修改或开发内容','合规状态']
    widths=[8,32,29,33,32,36,45,18]
    spec='|'+ '|'.join(r'>{\raggedright\arraybackslash}p{'+str(w)+'mm}' for w in widths)+'|'
    out=[r'\newgeometry{left=17mm,right=17mm,top=18mm,bottom=18mm}',r'\begin{landscape}',r'\pagestyle{empty}']
    for start in range(0,len(rows),6):
        if start: out.append(r'\clearpage')
        out += [r'\begin{center}{\Large\sffamily 开源及第三方资源使用清单'+('（续）' if start else '')+r'}\end{center}',r'\vspace{4mm}',r'\begingroup\fontsize{11}{16}\selectfont\setlength{\tabcolsep}{4pt}\renewcommand{\arraystretch}{1.25}',r'\noindent\begin{tabular}{'+spec+r'}\hline', ' & '.join(r'\textbf{'+h+'}' for h in heads)+r' \\ \hline']
        for row in rows[start:start+6]: out.append(' & '.join(inline(c) for c in row)+r' \\ \hline')
        out += [r'\end{tabular}\endgroup']
    out += [r'\end{landscape}',r'\restoregeometry']
    return '\n'.join(out)

def build(engine):
    SRC.mkdir(parents=True,exist_ok=True)
    BUILD.mkdir(parents=True,exist_ok=True)
    manuscripts=SRC
    manuscripts.mkdir(exist_ok=True)
    for name in ['technical-report.md','third-party-resources.md','real-task-cases.md']:
        shutil.copy2(SUB/name,manuscripts/name)
    (SRC/'figures').mkdir(exist_ok=True)
    for p in (SUB/'figures').glob('fig*.png'): shutil.copy2(p,SRC/'figures'/p.name)
    for name in ['preamble.tex','cover.tex']: shutil.copy2(HERE/name,SRC/name)
    (SRC/'report-body.tex').write_text(convert((SUB/'technical-report.md').read_text(encoding='utf-8'),True),encoding='utf-8')
    (SRC/'resources.tex').write_text(resource_table(),encoding='utf-8')
    report=r'''\input{preamble}
\begin{document}
\input{cover}
\pagenumbering{Roman}
\setcounter{tocdepth}{1}\tableofcontents\clearpage
\pagenumbering{arabic}
\input{report-body}
\clearpage\input{resources}
\end{document}
'''
    docs={'01-technical-report':report,'02-third-party-resources':r'\input{preamble}\begin{document}\input{resources}\end{document}'}
    cards=r'\input{preamble}\begin{document}\fancyhead[R]{\small 真实任务卡（补充材料）}'+'\n'+convert((SUB/'real-task-cases.md').read_text(encoding='utf-8'))+r'\end{document}'
    docs['03-real-task-cases']=cards
    for name,source in docs.items():
        (SRC/(name+'.tex')).write_text(source,encoding='utf-8')
        for attempt in range(2):
            result=subprocess.run([engine,'-interaction=nonstopmode','-halt-on-error','-output-directory='+str(BUILD),name+'.tex'],cwd=SRC,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (BUILD/(name+'.build.txt')).write_bytes(result.stdout)
            if result.returncode: raise RuntimeError(name+' compile failed; see build.txt')
        shutil.copy2(BUILD/(name+'.pdf'),OUT/(name+'.pdf'))
    from pypdf import PdfReader
    summary={}
    for name in docs:
        p=OUT/(name+'.pdf'); summary[name]={'pages':len(PdfReader(p).pages),'bytes':p.stat().st_size}
    aux=(BUILD/'01-technical-report.aux').read_text(encoding='utf-8')
    summary['bodyLastPage']=re.search(r'\\newlabel\{bodyend\}\{\{[^}]*\}\{([^}]*)',aux).group(1)
    (OUT/'build-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--engine',default='xelatex');args=parser.parse_args();build(args.engine)
