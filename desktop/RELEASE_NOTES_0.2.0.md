# LQTAC Data Base 0.2.0

## Novedades

- Módulo Dashboard: biblioteca por conexión, fuentes de varias consultas, gráficos, indicadores y tablas dinámicas.
- Diseño visual con campos agrupados por tabla, búsqueda, arrastre de campos y columnas, vista previa y paneles móviles/redimensionables.
- Modelo de relaciones 1:N, combinación de fuentes, filtros propagados, medidas y columnas calculadas.
- Funciones locales con sintaxis MySQL: HOUR, DATE, SEC_TO_TIME, TIME_TO_SEC, CONCAT, DATE_FORMAT, condiciones y otras disponibles en la ayuda.
- Actualización manual o automática de fuentes sin abrir pestañas SQL, conservando los datos anteriores ante un error o cambio de estructura.
- Exportación e importación de dashboards con diseño, datos y consultas, con asignación de conexiones en el equipo de destino y sin contraseñas de conexión.
- Respuestas numeradas y renombrables que se conservan por consulta al cambiar de pestaña o servidor durante la sesión.
- Explorador plegable para ganar espacio y manual actualizado de 30 páginas.

## Descarga y uso

Descarga y extrae todo el ZIP portable para Windows x64. Abre LQTAC Data Base.exe. No requiere instalar Node.js.

Para actualizar desde otra versión, cierra ambas aplicaciones y copia tu carpeta Data a la carpeta de la nueva versión. Conserva una copia de seguridad; el paquete publicado se distribuye sin Data personal ni conexiones configuradas.

El manual también está incluido en el ZIP como Manual-de-usuario.pdf. El archivo SHA256 permite comprobar la integridad de las descargas.

## Validación

111 pruebas de lógica y pruebas de la interfaz con datos ficticios: diseño visual, relaciones y fórmulas, intercambio de dashboards, actualización de fuentes y conservación de respuestas. El ejecutable portable se comprueba abriéndolo dos veces, con SQLite, fórmulas, dashboards y preferencias persistentes.

## Límites relevantes

Las fuentes de dashboard son capturas; requieren conexiones disponibles para actualizarse. La actualización automática funciona con la aplicación abierta. Las fórmulas implementan un subconjunto local de MySQL; no ejecutan SQL ni sustituyen toda su sintaxis. Las respuestas de consultas se conservan durante la sesión, mientras que los dashboards guardados permanecen en Data.
