import os
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))

# a small figure so the converter's image path is exercised
img_path = os.path.join(OUT, "_figure.png")
img = Image.new("RGB", (520, 200), (247, 249, 252))
d = ImageDraw.Draw(img)
d.rectangle([20, 20, 500, 180], outline=(47, 143, 216), width=3)
d.line([40, 160, 140, 90, 240, 130, 340, 60, 470, 110], fill=(214, 69, 69), width=4)
for x in range(40, 481, 60):
    d.line([x, 175, x, 185], fill=(120, 130, 145), width=2)
img.save(img_path)

doc = Document()
doc.core_properties.title = "伴读插件验收样本"

doc.add_heading("DocMate 验收样本", level=0)
doc.add_paragraph("这份文档用来验收 docx → HTML 的转换：标题层级、行内样式、列表、表格、图片和分页都要能读出来。")

doc.add_heading("一、行内样式", level=1)
p = doc.add_paragraph("这一段包含 ")
r = p.add_run("加粗文字")
r.bold = True
p.add_run("、")
r = p.add_run("斜体文字")
r.italic = True
p.add_run("、")
r = p.add_run("下划线")
r.underline = True
p.add_run("，以及一段 ")
r = p.add_run("行内代码样式")
r.font.name = "Consolas"
p.add_run(" 的等宽片段。")

doc.add_heading("二、列表", level=1)
doc.add_paragraph("无序列表第一项", style="List Bullet")
doc.add_paragraph("无序列表第二项", style="List Bullet")
doc.add_paragraph("有序列表第一项", style="List Number")
doc.add_paragraph("有序列表第二项", style="List Number")

doc.add_heading("三、表格", level=1)
table = doc.add_table(rows=1, cols=3)
table.style = "Table Grid"
hdr = table.rows[0].cells
hdr[0].text = "格式"
hdr[1].text = "渲染方式"
hdr[2].text = "备注"
for row in [
    ("Markdown", "客户端 React 渲染", "零依赖解析器"),
    ("DOCX", "Host 半转 HTML", "可选图片内联"),
    ("PDF", "pdf.js 画布 + 文本层", "支持划词"),
]:
    cells = table.add_row().cells
    for i, value in enumerate(row):
        cells[i].text = value

doc.add_heading("四、图片", level=1)
doc.add_paragraph("下面这张图由转换器内联成 data URI：")
doc.add_picture(img_path, width=Inches(4.2))
doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER

doc.add_heading("五、引用与分页", level=1)
q = doc.add_paragraph("「伴随式阅读的关键不是把 AI 放在旁边，而是让它知道你在看哪一行。」")
q.paragraph_format.left_indent = Inches(0.4)
q.runs[0].italic = True

doc.add_page_break()
doc.add_heading("第二页", level=1)
doc.add_paragraph("分页之后的内容应该出现在 <hr class=\"dm-docx-pagebreak\"> 之后。")
doc.add_paragraph("结束。")

out_docx = os.path.join(OUT, "课程大纲.docx")
doc.save(out_docx)
os.remove(img_path)
print("wrote", out_docx, os.path.getsize(out_docx), "bytes")
