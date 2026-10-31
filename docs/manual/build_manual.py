"""Build the branded PDF from maintained content and real desktop captures."""
from pathlib import Path
import sys,json
from xml.sax.saxutils import escape
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor, Color, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.utils import ImageReader
from content import PAGES
from dashboard_content import DASHBOARD_PAGES
PAGES = PAGES + DASHBOARD_PAGES

# Keep the guide aligned with the current product and its existing SQLite/credential behavior.
for page in PAGES:
    for key in ('title', 'lead', 'caption'):
        if key in page: page[key] = page[key].replace('LQTAC Data Base', 'LQTAC dbFox')
    page['blocks'] = [(title, text.replace('LQTAC Data Base.exe', 'LQTAC dbFox.exe').replace('LQTAC Data Base', 'LQTAC dbFox')) for title, text in page.get('blocks', [])]
    edits = {
        'Abrir y empezar a trabajar': {
            '2. Elige cómo empezar': 'Nueva conexión configura un servidor. Nueva base SQLite crea un archivo vacío; Abrir archivo SQLite carga una copia en memoria. El laboratorio permite practicar sin servidor.'},
        'Conocer y organizar la pantalla': {
            'Barra izquierda y explorador': 'La barra izquierda abre Inicio, Conexiones, Editor SQL, Módulos y Dashboards. El explorador muestra perfiles y objetos; Acerca de aparece al pie y el botón ? abre el manual.'},
        'Crear un perfil de servidor': {
            '2. Guarda y comprueba': 'Al conectar, introduce la contraseña. Si activas Recordar contraseña se guarda cifrada y podrás conectar directamente. Probar conexión comprueba el acceso; TLS requiere un certificado de confianza.'},
        'Elegir el motor correcto': {
            'SQLite': 'Crea una base local vacía o abre un archivo o el laboratorio, sin servidor. Los cambios se mantienen en memoria hasta pulsar Guardar copia.'},
        'Conexiones, grupos y objetos': {
            'Menú de una conexión': 'El botón derecho permite conectar, editar, duplicar, gestionar la contraseña, agrupar y borrar. En Conexiones puedes exportar o restaurar perfiles y grupos mediante .foxdb cifrado; también puedes importar archivos .lqtdb anteriores.'},
        'Practicar con el laboratorio': {
            '3. Edita sin escribir en un servidor': 'Haz doble clic o pulsa F2 en una celda editable y escribe En revisión. Enter deja el valor pendiente. Arrastra el tirador para copiarlo; pulsa Descartar o Aplicar cambios.'},
        'Modificar registros y aplicar': {
            '1. Activa la edición': 'En una consulta SELECT * de una tabla con clave primaria, haz doble clic o pulsa F2 en una celda. También puedes activar Editar datos en la barra de resultados.'},
        'Conservar respuestas y actualizar la aplicación': {
            'Primera apertura y comprobación': 'Abre LQTAC dbFox.exe desde la carpeta completa. Revisa tus conexiones, consultas y dashboards. Las contraseñas guardadas pueden requerir introducirse de nuevo en otro equipo o cuenta.'}
    }
    if page['title'] in edits:
        page['blocks'] = [(title, edits[page['title']].get(title, text)) for title, text in page['blocks']]
    if page['title'] == 'Crear un perfil de servidor': page['lead'] = 'Un perfil guarda cómo localizar el servidor; puedes guardar la contraseña cifrada de forma opcional.'
    if page['title'] in ('Ordenar, filtrar y limitar filas', 'Modificar registros y aplicar'):
        page['image'], page['crop'] = '05b-editar.png', 'stems-results'
    if page['title'] == 'Arrastrar y autorrellenar una columna':
        page['image'], page['crop'] = '05b-editar.png', 'fill-handle'

ROOT=Path(__file__).resolve().parents[2]
ASSETS=Path(__file__).parent/'assets'
VERSION=sys.argv[2] if len(sys.argv)>2 else json.loads((ROOT/'desktop/package.json').read_text(encoding='utf-8'))['version']
OUT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else ROOT/f'output/pdf/LQTAC_dbFox_Manual_de_usuario_{VERSION}.pdf'
OUT.parent.mkdir(parents=True,exist_ok=True)
for name,file in [('Segoe','segoeui.ttf'),('SegoeB','segoeuib.ttf')]:
    pdfmetrics.registerFont(TTFont(name,str(Path('C:/Windows/Fonts')/file)))
pdfmetrics.registerFontFamily('Segoe',normal='Segoe',bold='SegoeB',italic='Segoe',boldItalic='SegoeB')
NAVY=HexColor('#0b203d'); BLUE=HexColor('#2675c8'); CYAN=HexColor('#23adc7')
INK=HexColor('#152b43'); GRAY=HexColor('#52657a'); LIGHT=HexColor('#e5edf5')
W,H=612,792; LEFT=48; RIGHT=564; WIDTH=RIGHT-LEFT; BOTTOM=55
BODY=ParagraphStyle('body',fontName='Segoe',fontSize=10.2,leading=15,textColor=INK)
HEAD=ParagraphStyle('head',fontName='SegoeB',fontSize=11.3,leading=15,textColor=NAVY)
LEAD=ParagraphStyle('lead',fontName='Segoe',fontSize=11.2,leading=16,textColor=GRAY)
TITLE=ParagraphStyle('title',fontName='SegoeB',fontSize=25,leading=29,textColor=NAVY)
CAP=ParagraphStyle('caption',fontName='Segoe',fontSize=8.2,leading=11,textColor=GRAY)
c=canvas.Canvas(str(OUT),pagesize=(W,H),pageCompression=1)
c.setTitle('LQTAC dbFox '+VERSION+' · Manual de usuario')
c.setAuthor('LQTAC dbFox')
c.setSubject('Guía funcional ilustrada: conexiones, SQL, resultados, edición y configuración')
c.setCreator('LQTAC dbFox · Manual mantenible con ReportLab')
TOTAL=len(PAGES)+2

def para(text,x,y,width,style):
    p=Paragraph(escape(text).replace('\n','<br/>'),style);_,h=p.wrap(width,1000)
    p.drawOn(c,x,y-h);return y-h

def footer(page):
    c.setStrokeColor(LIGHT);c.setLineWidth(.6);c.line(LEFT,43,RIGHT,43)
    c.setFillColor(GRAY);c.setFont('Segoe',8)
    c.drawString(LEFT,28,'LQTAC dbFox '+VERSION+'  /  Manual de usuario')
    c.drawRightString(RIGHT,28,f'{page:02d} / {TOTAL:02d}')
    if page>2:
        c.linkRect('Volver al índice','contents',(LEFT,22,RIGHT-60,40),relative=0,thickness=0)

def image(name,y,max_h=310,crop=None):
    im=Image.open(ASSETS/name).convert('RGB')
    if crop=='library':im=im.crop((270,100,940,530))
    if crop=='stems-results':im=im.crop((0,round(im.height*.53),im.width,im.height))
    if crop=='fill-handle':im=im.crop((round(im.width*.49),round(im.height*.62),round(im.width*.77),round(im.height*.84)))
    if crop=='split-mask':
        first,second=im.crop((0,0,im.width,326)),im.crop((0,326,im.width,im.height))
        pair=Image.new('RGB',(im.width*2+16,max(first.height,second.height)),'white')
        pair.paste(first,(0,0));pair.paste(second,(im.width+16,0));im=pair
    scale=min(WIDTH/im.width,max_h/im.height); iw,ih=im.width*scale,im.height*scale
    x=LEFT+(WIDTH-iw)/2
    c.setFillColor(NAVY);c.roundRect(x-1,y-ih-1,iw+2,ih+2,3,fill=1,stroke=0)
    c.drawImage(ImageReader(im),x,y-ih,width=iw,height=ih)
    return y-ih-8

def badge(n,x,y):
    c.setFillColor(CYAN);c.circle(x,y,9,fill=1,stroke=0)
    c.setFillColor(NAVY);c.setFont('SegoeB',10);c.drawCentredString(x,y-3,str(n))

# Cover: genuine logo, one real application view, restrained branded typography.
c.bookmarkPage('cover');c.addOutlineEntry('Portada','cover',0)
c.setFillColor(HexColor('#061329'));c.rect(0,642,W,150,fill=1,stroke=0)
logo=Image.open(ROOT/'assets/branding/app-icon.png')
c.drawImage(ImageReader(logo),LEFT,698,width=66,height=66,mask='auto')
wordmark=Image.open(ROOT/'assets/branding/lqtac-data-base-white.png').crop((0,160,1774,590))
c.setFillColor(white);c.setFont('SegoeB',31);c.drawString(LEFT+84,735,'dbFox')
c.setFillColor(HexColor('#c5d8ec'));c.setFont('Segoe',12);c.drawString(LEFT+85,708,'by')
c.drawImage(ImageReader(wordmark),LEFT+104,705,width=73,height=18,mask='auto')
c.setFillColor(HexColor('#79e5f5'));c.setFont('SegoeB',9);c.drawString(LEFT,667,'GUÍA FUNCIONAL  /  VERSIÓN '+VERSION)
para('Manual de usuario',LEFT,609,WIDTH,ParagraphStyle('cover',parent=TITLE,fontSize=35,leading=41,textColor=HexColor('#111111')))
para('Conectar, consultar y trabajar con tus datos.',LEFT,548,WIDTH,LEAD)
y=image('03-consultas.png',505,max_h=335)
para('Conexiones · SQL · Resultados · Dashboards',LEFT,y-13,WIDTH,HEAD)
para('Actualizado · 31 de octubre de 2026\nCapturas reales con datos ficticios y SQLite local.\nEdición '+VERSION+'.',LEFT,108,WIDTH,CAP)
footer(1);c.showPage()

# Two-column, linked contents.
c.bookmarkPage('contents');c.addOutlineEntry('Índice','contents',0)
c.setFillColor(CYAN);c.setFont('SegoeB',9);c.drawString(LEFT,747,'ORIENTACIÓN')
para('Encuentra tu tarea',LEFT,722,WIDTH,TITLE)
para('Empieza por una conexión o salta a la tarea que necesites. Pulsa una entrada para ir a su página; el pie de página vuelve a este índice.',LEFT,674,WIDTH,LEAD)
colw=246; ys=[605,605]; split=(len(PAGES)+1)//2
for i,p in enumerate(PAGES):
    col=0 if i<split else 1;x=LEFT+col*270;y=ys[col]
    label=p['title'];page=i+3
    c.setFillColor(BLUE);c.setFont('SegoeB',10);c.drawString(x,y-1,f'{page:02d}')
    st=ParagraphStyle('toc',parent=BODY,fontSize=10,leading=13)
    bottom=para(label,x+28,y+2,colw-30,st)
    c.linkRect(label,f'page{page}',(x,bottom-5,x+colw,y+8),relative=0,thickness=0)
    ys[col]=y-34
para('Cómo leer las imágenes',LEFT,103,WIDTH,HEAD)
para('Las capturas utilizan datos ficticios del laboratorio local. Los servidores y sus contenidos no se han consultado. Las funciones disponibles dependen del motor y de los permisos del usuario.',LEFT,83,WIDTH,CAP)
footer(2);c.showPage()

checks=[]
for i,p in enumerate(PAGES):
    number=i+3;c.bookmarkPage(f'page{number}');c.addOutlineEntry(p['title'],f'page{number}',0)
    c.setFillColor(CYAN);c.setFont('SegoeB',9);c.drawString(LEFT,747,p['section'])
    y=para(p['title'],LEFT,723,WIDTH,TITLE)-13
    y=para(p['lead'],LEFT,y,WIDTH,LEAD)-17
    if p.get('image'):
        # Screens remain unmodified; crops retain the genuine panel UI.
        top=y
        y=image(p['image'],y,max_h=300 if len(p.get('blocks',[]))<4 else 253,crop=p.get('crop'))
        if p['title']=='Conocer el espacio de trabajo':
            im=Image.open(ASSETS/p['image']);s=min(WIDTH/im.width,300/im.height);x=LEFT+(WIDTH-im.width*s)/2
            for n,xx,yy in [(1,75,120),(2,300,145),(3,320,550)]:badge(n,x+xx*s,top-yy*s)
        y=para(p['caption'],LEFT,y,WIDTH,CAP)-15
    if p.get('table'):
        data=[[Paragraph('<b>'+escape(p['table'][0][0])+'</b>',BODY),Paragraph('<b>'+escape(p['table'][0][1])+'</b>',BODY)]]
        for a,b in p['table'][1:]:
            data.append([Paragraph(escape(a),BODY),Paragraph(escape(b),BODY)])
        table=Table(data,colWidths=[185,WIDTH-185],hAlign='LEFT')
        table.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('BACKGROUND',(0,0),(-1,0),LIGHT),('LINEBELOW',(0,0),(-1,0),.7,CYAN),('LINEBELOW',(0,1),(-1,-1),.3,LIGHT),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),('LEFTPADDING',(0,0),(-1,-1),9)]))
        _,th=table.wrap(WIDTH,1000);table.drawOn(c,LEFT,y-th);y-=th+17
    for title,text in p.get('blocks',[]):
        y=para(title,LEFT,y,WIDTH,HEAD)-4
        y=para(text,LEFT,y,WIDTH,BODY)-12
    checks.append((number,round(y,1),p['title']))
    if y<BOTTOM:raise RuntimeError(f'Page {number} overflow: bottom {y:.1f} / {p["title"]}')
    footer(number);c.showPage()
c.save()
md=['# LQTAC dbFox '+VERSION+' - Manual de usuario','','Actualizado: 31 de octubre de 2026.','Capturas reales con datos ficticios y SQLite local.']
for p in PAGES:
    md.extend(['','## '+p['title'],'',p['lead']])
    if p.get('image'):md.extend(['','![Captura de '+p['title']+'](assets/'+p['image']+')','',p['caption']])
    if p.get('table'):md.extend(['','| '+p['table'][0][0]+' | '+p['table'][0][1]+' |','| --- | --- |']+['| '+a+' | '+b+' |' for a,b in p['table'][1:]])
    for title,text in p.get('blocks',[]):md.extend(['','### '+title,'',text])
(Path(__file__).parent/'Manual_de_usuario.md').write_text('\n'.join(md)+'\n',encoding='utf-8',newline='\n')
print(f'PDF: {OUT}\nPages: {TOTAL}')
for row in checks:print(row)
