"""Render selected pages and check release text for the maintained user guide."""
from pathlib import Path
import pypdfium2 as pdfium
from pypdf import PdfReader
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
source = root / 'output/pdf/LQTAC_dbFox_Manual_de_usuario_0.2.6.pdf'
output = root / 'tmp/pdfs'
output.mkdir(parents=True, exist_ok=True)
reader = PdfReader(source)
text = '\n'.join(page.extract_text() for page in reader.pages)
assert '0.2.5' not in text
for term in ['SSH', 'NULL', 'Pegar campo', 'Buscar y reemplazar', 'Filas por página']:
    assert term in text, term
document = pdfium.PdfDocument(source)
pages = [0, 1, 5, 10, 12, 30, 31, 32, 33, 34]
sheet = Image.new('RGB', (1224, 5 * 820), 'white')
draw = ImageDraw.Draw(sheet)
for position, index in enumerate(pages):
    image = document[index].render(scale=1).to_pil().convert('RGB')
    image.save(output / f'manual-page-{index+1}.png')
    x, y = (position % 2) * 612, (position // 2) * 820
    sheet.paste(image, (x, y))
    draw.text((x+10, y+795), f'Page {index+1}', fill='black')
sheet.save(output / 'manual-review.png')
print(f'{len(reader.pages)} pages checked. Rendered {len(pages)} review pages.')
