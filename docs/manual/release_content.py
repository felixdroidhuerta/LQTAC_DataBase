"""User-facing additions for the 0.2.6 guide."""

def update_pages(pages):
    replacements = {
        'Modificar registros y aplicar': [
            ('1. Abre una tabla editable', 'Ejecuta SELECT * sobre una tabla. En MySQL y MariaDB puede tener clave PRIMARY o un índice UNIQUE completo con columnas NOT NULL. Un WHERE no impide editar. Las vistas, las consultas combinadas y las columnas protegidas pueden ser de solo lectura.'),
            ('2. Prepara los valores', 'Haz doble clic o pulsa F2 en la celda. Enter deja el cambio pendiente. En una columna que admite NULL, vaciar la celda o escribir NULL produce un nulo real. En los campos numéricos también se interpreta un valor formado solo por espacios como NULL.'),
            ('3. Revisa y confirma', 'Aplicar cambios abre primero las queries. Aplicar ejecuta los cambios y Cerrar conserva las ediciones pendientes. Una comprobación de concurrencia evita sobrescribir registros modificados desde otra sesión.'),
        ],
        'Ordenar, filtrar y limitar filas': [
            ('Filtro sobre todas las filas cargadas', 'Selecciona el campo y escribe el texto. El indicador muestra cuántas filas están disponibles para buscar. El filtro y la ordenación se aplican a todas las filas cargadas antes de paginar. Si la consulta llegó limitada, la búsqueda abarca únicamente los datos recibidos.'),
            ('Páginas y límite de consulta', 'Filas por página permite elegir 100, 500 o 1.000 y navegar al principio, atrás, adelante o al final. El selector Filas de la barra superior controla la cantidad recibida del servidor. Sin límite respeta los límites que ya tenga el SQL.'),
            ('Ordenación y exportación', 'Pulsa una cabecera para alternar ascendente, descendente y orden original. Al filtrar u ordenar vuelves a la primera página. CSV y XLSX exportan todo el conjunto filtrado y ordenado, no solo la página visible.'),
        ],
        'Practicar con el laboratorio': None,
    }
    for page in pages:
        if replacements.get(page['title']):
            page['blocks'] = replacements[page['title']]
        page['blocks'] = [(title, text.replace('Pulsa Descartar para deshacer o Aplicar cambios para actualizar la copia local.', 'Pulsa Descartar para deshacer o Aplicar cambios para revisar el SQL y confirmar con Aplicar.')) for title, text in page.get('blocks', [])]
        if page['title'] == 'Conexiones, grupos y objetos':
            page['blocks'] = [(title, 'Al conectar, la conexión, sus bases y las carpetas de objetos quedan contraídas. Despliégalas con sus flechas cuando las necesites. Actualizar conserva lo que hayas abierto manualmente. El filtro puede desplegar coincidencias. La estrella selecciona la base o esquema predeterminado; comprueba el destino antes de ejecutar.' if title == 'Buscar y seleccionar una base' else text) for title, text in page['blocks']]
        if page['title'] == 'Escribir, completar y guardar':
            page['blocks'] = [(title, text.replace('Enter acepta una sugerencia.', 'Tab o Enter aceptan la sugerencia seleccionada.').replace('Tab introduce una tabulación;', 'Sin sugerencias abiertas, Tab introduce una tabulación;')) for title, text in page['blocks']]
        if page['title'] == 'Copiar contenido y exportar':
            page['blocks'] = [('Copiar o pegar una celda', 'Un clic selecciona la celda. Ctrl+C copia su contenido completo; Ctrl+V pega texto, saltos de línea y tabuladores en esa misma celda, sin abrir el editor. El pegado respeta los campos de solo lectura y queda pendiente de Aplicar cambios.'), ('Copiar filas y exportar', 'El menú contextual permite copiar filas seleccionadas, con o sin encabezados y distintos separadores. Pegar filas es una acción independiente de pegar en una celda. CSV y XLSX exportan los resultados cargados, filtrados y ordenados.'), ('Ajustar columnas', 'Arrastra el borde derecho de una cabecera para ampliar o reducir la columna. Doble clic restablece su ancho. El ajuste se conserva al ordenar, filtrar y volver a esa respuesta durante la sesión.')]
        if page['title'] == 'Practicar con el laboratorio':
            page['blocks'] = [(title, text.replace('pulsa Probar el laboratorio. Escribe', 'pulsa Probar el laboratorio y abre una consulta con + o Ctrl+N. Escribe')) for title, text in page['blocks']]
        if page['title'] == 'Atajos para el trabajo diario':
            page['table'] = [(key.replace('Ctrl+Espacio / Enter', 'Ctrl+Espacio / Tab o Enter'), value.replace('Indentar / reducir sangría en el editor.', 'Sin sugerencias: indentar / reducir sangría.')) for key, value in page['table']]
    pages.extend([
        {'section':'COMPARAR BASES DE DATOS', 'title':'Comparar triggers, vistas y rutinas', 'lead':'El botón de flechas opuestas abre el comparador MySQL/MariaDB.', 'image':'30-comparador.png', 'caption':'Comparación real con servidores de prueba locales y definiciones ficticias.', 'blocks':[
            ('Seleccionar A y B', 'Conecta los servidores y elige servidor y base en cada lado. También puedes comparar dos bases del mismo servidor. Pulsa Comparar: se cargan los objetos visibles para tus usuarios sin cambiar la base activa de las consultas.'),
            ('Localizar diferencias', 'El listado agrupa triggers, vistas, procedimientos y funciones: Igual, Modificado, Solo en A/B o No se pudo leer. Filtra por nombre, tipo, estado o tabla del trigger. El filtro de tabla busca en ambos lados y la cabecera indica la tabla de A y B.'),
            ('Revisar el código', 'Los paneles resaltan líneas y fragmentos cambiados; las flechas saltan entre diferencias. Puedes ignorar espacios, DEFINER, nombres de base o comentarios. El código original sigue visible. Exportar informe guarda una captura JSON de la comparación.'),
        ]},
        {'section':'COMPARAR BASES DE DATOS', 'title':'Editar o tomar código del otro lado', 'lead':'Prepara un borrador y confirma el SQL antes de cambiar el destino.', 'image':'31-editar-comparacion.png', 'caption':'Editor de un trigger con destino identificado y revisión SQL antes de aplicar.', 'blocks':[
            ('Escribir o copiar como borrador', 'Editar permite modificar manualmente el objeto de ese lado. B → A prepara en A un borrador a partir de B; A → B hace lo contrario. Puedes seguir editándolo. En triggers se copia el cuerpo y se conservan inicialmente el momento y evento de destino.'),
            ('Conservar la identidad de destino', 'Se mantienen el nombre, la tabla del trigger y el DEFINER de destino. En vistas y rutinas se adapta la cabecera, conservando las referencias del cuerpo para revisión manual. Comprueba el servidor, las bases citadas y los permisos.'),
            ('Revisar y aplicar', 'Revisar SQL no escribe. Aplicar verifica que el objeto no haya cambiado, guarda una copia original e intenta restaurarla si falla la recreación. DROP + CREATE no es atómico. Los cambios correctos se reflejan en la comparación; si el resultado es incierto, verifica antes de reintentar.'),
        ]},
        {'section':'EDICIÓN DE DATOS', 'title':'Identificar la modificación que falla', 'lead':'Los errores permanecen en una ventana con el contexto de la operación.', 'image':'32-avisos-edicion.png', 'caption':'Dos valores inválidos identificados por consulta, respuesta, clave, campo y valores.', 'blocks':[
            ('Qué información muestra', 'Consulta, respuesta, servidor y tabla; fila del resultado, clave del registro, campo y tipo, valor original y propuesto. Distingue errores de validación de rechazos del servidor, muestra el SQL asociado cuando existe e indica cuántas filas llegaron a aplicarse.'),
            ('Corregir sin perder el borrador', 'Ir a celda localiza el campo aunque esté en otra página. Si el filtro oculta la fila, lo limpia para mostrarla. Corrige el valor y vuelve a revisar. La validación previa no envía cambios al servidor; los cambios restantes se conservan pendientes.'),
            ('Compartir los detalles', 'Copiar detalles reúne el diagnóstico y el SQL asociado, sin copiar todas las filas de la respuesta. Si se informa de un resultado incierto o de que hay que volver a consultar, comprueba la tabla antes de repetir escrituras.'),
        ]},
        {'section':'CONEXIONES', 'title':'Conectar mediante SSH o socket local', 'lead':'MySQL y MariaDB incorporan tres métodos de conexión.', 'blocks':[
            ('TCP/IP y conexión local', 'Estándar TCP/IP usa el servidor y puerto de la base. Socket local / tubería utiliza una ruta disponible en el mismo equipo. El servicio debe tener habilitado ese transporte.'),
            ('TCP/IP sobre SSH', 'Indica servidor SSH, puerto y usuario. Elige clave privada / agente o usuario y contraseña. La contraseña SSH se pide al conectar y se conserva durante la sesión. El campo de contraseña de base de datos sigue siendo independiente.'),
            ('Identidad del servidor', 'La huella es opcional en el formulario. Si se deja vacía, la primera conexión solicita confirmar la identidad y la recuerda en el equipo. Si cambia, se bloquea la conexión. Puedes introducir una huella SHA256 conocida para comprobarla directamente.'),
            ('Destino dentro del túnel', 'Servidor de base de datos se interpreta desde el servidor SSH. Usa 127.0.0.1 si MySQL está en ese mismo servidor. Las claves cifradas deben cargarse en el agente; en Windows se admite Pageant.'),
        ]},
        {'section':'EDITOR SQL', 'title':'Buscar, reemplazar y ver caracteres invisibles', 'lead':'La cabecera separa conexión, aclaraciones, búsqueda y acciones.', 'blocks':[
            ('Búsqueda fija', 'Selecciona Buscar o Buscar y reemplazar. Ctrl+F enfoca la búsqueda y Ctrl+H habilita el reemplazo. Las flechas recorren las coincidencias; Enter avanza y Mayús+Enter retrocede. Aa distingue mayúsculas y minúsculas.'),
            ('Reemplazar texto literal', 'Reemplazar actúa sobre la coincidencia seleccionada. Si no hay ninguna seleccionada, primero la localiza. Reemplazar todo modifica todas las coincidencias del documento SQL actual. Se busca texto literal y se conserva el resto del script.'),
            ('Caracteres especiales', 'El botón de párrafo muestra puntos para espacios, flechas para tabuladores y saltos, y rombos para otros caracteres ocultos. La ayuda muestra los códigos Unicode detectados, incluidos espacios no separables y caracteres de ancho cero. Es una visualización; el SQL conserva sus caracteres originales.'),
        ]},
        {'section':'CONSULTAS', 'title':'Cambiar de servidor y conservar respuestas', 'lead':'Una misma pestaña SQL puede trabajar con varios servidores conectados.', 'blocks':[
            ('Seleccionar el destino', 'En la cabecera, el selector de servidor ofrece las sesiones conectadas. Conecta el perfil desde el explorador para que aparezca. Comprueba también la base o esquema antes de ejecutar.'),
            ('Respuestas por servidor', 'Al cambiar de servidor se conserva la respuesta anterior con sus ediciones pendientes. Al volver, se recupera su contexto. Estas respuestas y cambios pendientes se mantienen durante la sesión abierta de la aplicación.'),
            ('Otra query con cambios pendientes', 'Si vuelves a ejecutar con cambios sin aplicar, aparece otra pestaña de respuesta. La anterior conserva las ediciones. Si ambas consultan la misma tabla, la nueva lee los valores guardados en el servidor.'),
        ]},
        {'section':'EDICIÓN DE DATOS', 'title':'Contenido completo, filas y confirmaciones', 'lead':'Revisa el SQL antes de guardar una modificación o borrar registros.', 'blocks':[
            ('Textos extensos', 'Botón derecho sobre una celda y Ver contenido completo abre el texto entero. Editar contenido permite modificarlo. Dejar cambio pendiente lo devuelve a la cuadrícula; después pulsa Aplicar cambios y confirma el SQL.'),
            ('Copiar y pegar registros', 'Selecciona filas con Ctrl o Mayús y usa el menú contextual para copiarlas, con o sin encabezados y separadas por tabulador, punto y coma o coma. Pegar filas prepara inserciones pendientes. Los identificadores autoincrementales reciben nuevos valores.'),
            ('Borrar filas seleccionadas', 'Quitar fila prepara el borrado de las filas seleccionadas. La ventana indica cantidad, claves y queries. Aplicar ejecuta esos borrados y Cerrar cancela. Las demás ediciones pendientes no se aplican con esta acción.'),
            ('Tiempo máximo', 'La preparación de edición y la comprobación de estructura usan el tiempo configurado. Al agotarlo se solicita cancelación y se informa del vencimiento. La sesión puede seguir ocupada hasta que el servidor confirme la cancelación.'),
        ]},
        {'section':'ESTRUCTURA', 'title':'Copiar campos entre tablas', 'lead':'Copia la definición de una columna y añádela al borrador de otra tabla.', 'blocks':[
            ('Seleccionar y copiar', 'En Columnas, marca las casillas de los campos. Mayús+clic selecciona un rango; la casilla de cabecera marca todos. Botón derecho sobre un campo seleccionado conserva el conjunto y permite Copiar campos. La copia permanece disponible durante la sesión.'),
            ('Pegar', 'Abre la tabla destino y usa botón derecho, Pegar campos. Se añaden juntos al borrador, con sus atributos editables, valores predeterminados e indicadores de clave primaria o única. Si un nombre existe, se añade un sufijo.'),
            ('Revisar la definición', 'El pegado solo modifica el borrador. Revisa el tipo, las expresiones, los índices y el SQL antes de aplicar. Si ya existe un campo autoincremental, se impide pegar otro con ese atributo. Los campos con atributos avanzados no representables requieren copiar su DDL manualmente.'),
        ]},
        {'section':'CONEXIONES', 'title':'Conectar todos sin abrir consultas', 'lead':'Conecta tus perfiles y abre una hoja SQL solo cuando la necesites.', 'image':'28-conectar-todos.png', 'caption':'Botón de encendido junto a Actualizar en el Explorador y botón Conectar todos en Conexiones. Datos ficticios.', 'blocks':[
            ('Desde cualquiera de los dos botones', 'En Conexiones pulsa Conectar todos, o usa el icono de encendido junto a Actualizar en el Explorador. Se omiten las sesiones ya abiertas. Los dos botones se deshabilitan mientras dura el proceso.'),
            ('Contraseñas y conexiones omitidas', 'Se usan las contraseñas guardadas. Si falta una, aparece el formulario correspondiente; Cancelar omite ese perfil y continúa con el siguiente. Al terminar se muestra el resumen de conexiones abiertas, omitidas y con error.'),
            ('Abrir y desplegar a tu ritmo', 'Conectar no crea una consulta, tampoco al abrir SQLite o el laboratorio. Usa +, Ctrl+N o Abrir editor para trabajar. El Explorador queda contraído; sus flechas permiten abrir solo las conexiones, bases y carpetas necesarias.'),
        ]},
        {'section':'COPIAS Y RESTAURACIÓN', 'title':'Exportar e importar todo', 'lead':'Traslada la configuración de dbFox en un único archivo .foxdb cifrado.', 'image':'29-copia-completa.png', 'caption':'Exportar todo solicita una contraseña propia del archivo y su confirmación.', 'blocks':[
            ('Qué incluye la copia completa', 'En Conexiones pulsa Exportar todo. Incluye perfiles, grupos, contraseñas guardadas, dashboards, favoritos SQL, ajustes y borradores de la interfaz. Elige y conserva la contraseña del archivo: será necesaria para restaurarlo.'),
            ('Cómo restaurar', 'Guarda los cambios pendientes y desconecta todas las bases. Pulsa Importar todo, introduce la contraseña y selecciona el archivo. Revisa el resumen y confirma: sustituye la configuración actual y recarga la aplicación. Los archivos anteriores quedan en Data/restore-backups.'),
            ('Qué debes trasladar aparte', 'No copia las bases de los servidores, los archivos SQL o SQLite externos ni las ediciones pendientes de las respuestas. Exportar conexiones y las exportaciones individuales de dashboards siguen disponibles para copias parciales.'),
        ]},
    ])
    return pages
