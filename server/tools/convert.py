#!/usr/bin/env python3
# Cat-AgentUI built-in document converter. Runs INSIDE the sandbox, mounted
# read-only at /opt/tools; the model never writes this command itself, so it
# needs no per-call confirmation. Routes by file extension:
#
#   md / txt / html / htm / docx / doc / odt / rtf  -> pdf
#   md / txt / html / htm / docx / doc / odt / rtf  -> docx
#   docx / doc / odt / rtf / html                   -> md
#   pdf                                             -> txt / md
#
# Requirements are reported precisely (what is missing, who can install it).
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CSS = """
@page { size: A4; margin: 2cm 1.8cm; @bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; color: #888; } }
html { font-family: "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "Droid Sans Fallback", "DejaVu Sans", sans-serif; font-size: 10.5pt; line-height: 1.7; color: #222; }
h1 { font-size: 20pt; margin: 0 0 14pt; padding-bottom: 6pt; border-bottom: 1.5pt solid #333; }
h2 { font-size: 14pt; margin: 18pt 0 8pt; }
h3 { font-size: 12pt; margin: 14pt 0 6pt; }
p { margin: 0 0 8pt; text-align: justify; }
ul, ol { margin: 0 0 8pt 1.4em; padding: 0; }
li { margin: 2pt 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0 12pt; font-size: 9.5pt; }
th, td { border: 0.6pt solid #999; padding: 4pt 6pt; vertical-align: top; }
th { background: #f0f0f0; font-weight: 600; }
tr { page-break-inside: avoid; }
code { font-family: "DejaVu Sans Mono", "Noto Sans Mono CJK SC", monospace; font-size: 9pt; background: #f4f4f4; padding: 0 3pt; border-radius: 2pt; }
pre { background: #f4f4f4; padding: 8pt; border-radius: 3pt; font-size: 8.5pt; white-space: pre-wrap; word-break: break-all; }
pre code { background: none; padding: 0; }
blockquote { margin: 8pt 0; padding: 4pt 12pt; border-left: 3pt solid #bbb; color: #555; }
img { max-width: 100%; }
hr { border: 0; border-top: 0.6pt solid #bbb; margin: 12pt 0; }
a { color: #1f4fd8; text-decoration: none; }
"""

TEXTY = {"md", "markdown", "txt"}
HTMLY = {"html", "htm"}
OFFICE = {"docx", "doc", "odt", "rtf"}
LEGACY = {"doc", "odt", "rtf"}


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def ext(p):
    return p.suffix.lower().lstrip(".")


def need(binary, hint):
    if not shutil.which(binary):
        die(f"缺少 {binary}:{hint}")


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"{cmd[0]} 失败:{(r.stderr or r.stdout).strip()[:600]}")
    return r.stdout


def to_docx_if_legacy(src, tmp):
    """Old binary .doc / .odt / .rtf need LibreOffice; pandoc can't read them."""
    if ext(src) not in LEGACY:
        return src
    office = shutil.which("soffice") or shutil.which("libreoffice")
    if not office:
        die(f"旧格式 .{ext(src)} 需要 LibreOffice 才能读取,当前沙盒没有安装;请把文件另存为 .docx 后重试(或让管理员安装 libreoffice-core)")
    run([office, "--headless", "--convert-to", "docx", "--outdir", str(tmp), str(src)])
    out = tmp / (src.stem + ".docx")
    if not out.exists():
        die("LibreOffice 转换未产生 .docx 文件")
    return out


def md_to_html(text):
    try:
        import markdown
        return markdown.markdown(text, extensions=["tables", "fenced_code", "toc", "sane_lists"])
    except ImportError:
        if shutil.which("pandoc"):
            r = subprocess.run(["pandoc", "-f", "gfm", "-t", "html"], input=text, capture_output=True, text=True)
            if r.returncode == 0:
                return r.stdout
        die("缺少 markdown 库(且没有 pandoc):请管理员在 沙盒 → Python 运行库 中安装 markdown")


def html_to_pdf(html, out, base):
    try:
        from weasyprint import HTML, CSS as WCSS
    except ImportError:
        die("缺少 weasyprint:请管理员在 沙盒 → Python 运行库 中安装 weasyprint")
    except OSError as e:
        die(f"weasyprint 的系统库缺失({str(e)[:120]}):请管理员查看 沙盒 → 环境自检 里的「PDF 排版库」并按提示安装")
    doc = f'<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body>{html}</body></html>'
    HTML(string=doc, base_url=str(base)).write_pdf(str(out), stylesheets=[WCSS(string=CSS)])


def main():
    if len(sys.argv) != 3:
        die("用法: convert.py 输入文件 输出文件", 2)
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    if not src.exists():
        die(f"输入文件不存在:{src}")
    s, o = ext(src), ext(out)
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        if o == "pdf":
            if s in TEXTY:
                html_to_pdf(md_to_html(src.read_text(encoding="utf-8", errors="replace")), out, src.parent)
            elif s in HTMLY:
                html_to_pdf(src.read_text(encoding="utf-8", errors="replace"), out, src.parent)
            elif s in OFFICE:
                need("pandoc", "请管理员安装 pandoc(沙盒 → 环境自检)")
                d = to_docx_if_legacy(src, tmp)
                media = tmp / "media"
                html = run(["pandoc", str(d), "-t", "html", "--extract-media", str(media)])
                html_to_pdf(html, out, media.parent)
            else:
                die(f"不支持把 .{s} 转成 PDF(支持:md / txt / html / docx / doc / odt / rtf)")
        elif o == "docx":
            need("pandoc", "请管理员安装 pandoc(沙盒 → 环境自检)")
            if s in TEXTY:
                run(["pandoc", str(src), "-f", "gfm", "-o", str(out)])
            elif s in HTMLY:
                run(["pandoc", str(src), "-f", "html", "-o", str(out)])
            elif s in OFFICE:
                d = to_docx_if_legacy(src, tmp)
                shutil.copyfile(d, out) if d != src else run(["pandoc", str(src), "-o", str(out)])
            else:
                die(f"不支持把 .{s} 转成 Word(支持:md / txt / html / docx / doc / odt / rtf)")
        elif o in ("md", "markdown", "txt"):
            if s == "pdf":
                if shutil.which("pdftotext"):
                    run(["pdftotext", "-layout", str(src), str(out)])
                else:
                    try:
                        from pypdf import PdfReader
                    except ImportError:
                        die("缺少 pdftotext(poppler-utils)与 pypdf,无法读取 PDF 文本")
                    out.write_text("\n\n".join((p.extract_text() or "") for p in PdfReader(str(src)).pages), encoding="utf-8")
            elif s in OFFICE or s in HTMLY:
                need("pandoc", "请管理员安装 pandoc(沙盒 → 环境自检)")
                d = to_docx_if_legacy(src, tmp) if s in OFFICE else src
                run(["pandoc", str(d), "-t", "gfm", "--wrap=none", "-o", str(out)])
            else:
                die(f"不支持把 .{s} 转成文本(支持:pdf / docx / doc / odt / rtf / html)")
        else:
            die(f"不支持的输出格式 .{o}(支持:pdf / docx / md / txt)")

    if not out.exists() or out.stat().st_size == 0:
        die("转换未产生输出文件")
    print(f"已生成 {out}({out.stat().st_size} 字节)")


if __name__ == "__main__":
    main()
