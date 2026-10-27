export const modules = Object.freeze([
  { id: 'connections', icon: '⇄', title: 'Conexiones', description: 'PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, ClickHouse y MongoDB.', status: 'Disponible', action: 'connections' },
  { id: 'sql', icon: '⌘', title: 'Editor SQL', description: 'Consultas, pestañas y resultados en un mismo lugar.', status: 'Disponible', action: 'sql' },
  { id: 'modeling', icon: '◇', title: 'Diseño de datos', description: 'Diagramas de relaciones y modelado visual.', status: 'Planificado' },
  { id: 'jdbc', icon: '◫', title: 'Motores JDBC', description: 'PostgreSQL, MySQL y otros motores a través de DBeaver.', status: 'Pendiente de integración' }
]);
