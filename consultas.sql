-- =====================================================================
-- CONSULTAS ÚTILES DEL BOT DE WHATSAPP
-- Base: bddgeneral  |  Esquema: bot
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. LEADS (solicitudes completadas) - lo que revisa el equipo comercial
-- ---------------------------------------------------------------------

-- Todos los leads, del más reciente al más antiguo
SELECT id, telefono, canal, tipo_internet, ubicacion, requerimiento, creado
FROM bot.leads
ORDER BY creado DESC;

-- Solo leads de VENTAS
SELECT telefono, tipo_internet, ubicacion, creado
FROM bot.leads
WHERE canal = 'ventas'
ORDER BY creado DESC;

-- Solo requerimientos de SERVICIO AL CLIENTE
SELECT telefono, requerimiento, creado
FROM bot.leads
WHERE canal = 'servicio'
ORDER BY creado DESC;

-- Leads de HOY
SELECT * FROM bot.leads
WHERE creado::date = CURRENT_DATE
ORDER BY creado DESC;

-- Leads de los últimos 7 días
SELECT * FROM bot.leads
WHERE creado >= now() - INTERVAL '7 days'
ORDER BY creado DESC;

-- ---------------------------------------------------------------------
-- 2. REPORTES / MÉTRICAS
-- ---------------------------------------------------------------------

-- Cuántos leads por día
SELECT creado::date AS dia, COUNT(*) AS total
FROM bot.leads
GROUP BY dia
ORDER BY dia DESC;

-- Cuántos por canal
SELECT canal, COUNT(*) AS total
FROM bot.leads
GROUP BY canal;

-- Qué tipo de servicio piden más (ventas)
SELECT tipo_internet, COUNT(*) AS total
FROM bot.leads
WHERE canal = 'ventas'
GROUP BY tipo_internet
ORDER BY total DESC;

-- Qué requerimientos son más frecuentes (servicio al cliente)
SELECT requerimiento, COUNT(*) AS total
FROM bot.leads
WHERE canal = 'servicio'
GROUP BY requerimiento
ORDER BY total DESC;

-- ---------------------------------------------------------------------
-- 3. HISTORIAL DE CHATS (respaldo de mensajes)
-- ---------------------------------------------------------------------

-- Últimos 100 mensajes de todos los chats
SELECT telefono, direccion, tipo, contenido, creado
FROM bot.mensajes
ORDER BY creado DESC
LIMIT 100;

-- Conversación completa de un número (cambia el número)
SELECT direccion, tipo, contenido, creado
FROM bot.mensajes
WHERE telefono = '593958693149'
ORDER BY creado ASC;

-- Cuántos mensajes por día
SELECT creado::date AS dia,
       COUNT(*) FILTER (WHERE direccion = 'entrante') AS recibidos,
       COUNT(*) FILTER (WHERE direccion = 'saliente') AS enviados
FROM bot.mensajes
GROUP BY dia
ORDER BY dia DESC;

-- Personas que escribieron pero NO completaron el flujo (posibles leads perdidos)
SELECT DISTINCT m.telefono
FROM bot.mensajes m
LEFT JOIN bot.leads l ON l.telefono = m.telefono
WHERE l.id IS NULL;

-- ---------------------------------------------------------------------
-- 4. PAUSAS DEL BOT
-- ---------------------------------------------------------------------

-- Números en los que el bot está callado ahora mismo
SELECT telefono, motivo, pausado_hasta,
       pausado_hasta - now() AS tiempo_restante
FROM bot.pausas
WHERE pausado_hasta > now()
ORDER BY pausado_hasta;

-- Reactivar el bot para un número específico (quitar la pausa)
DELETE FROM bot.pausas WHERE telefono = '593958693149';

-- Reactivar el bot para TODOS (usar con cuidado)
DELETE FROM bot.pausas;

-- Cuántas veces intervino un asesor por día
SELECT creado::date AS dia, COUNT(*) AS intervenciones
FROM bot.mensajes
WHERE direccion = 'asesor'
GROUP BY dia
ORDER BY dia DESC;

-- ---------------------------------------------------------------------
-- 5. CONVERSACIONES (trazabilidad)
-- Cada activación del bot genera una conversación con id propio.
-- estado_final: completado | intervencion_asesor | reiniciado |
--               reactivado_manual | NULL (sigue abierta)
-- ---------------------------------------------------------------------

-- Todas las conversaciones, con duración y cantidad de mensajes
SELECT c.id, c.telefono, c.inicio, c.fin, c.estado_final,
       c.fin - c.inicio AS duracion,
       (SELECT COUNT(*) FROM bot.mensajes m WHERE m.conversacion_id = c.id) AS mensajes
FROM bot.conversaciones c
ORDER BY c.inicio DESC;

-- Cuántas conversaciones por día y cómo terminaron
SELECT inicio::date AS dia, estado_final, COUNT(*) AS total
FROM bot.conversaciones
GROUP BY dia, estado_final
ORDER BY dia DESC;

-- Tasa de conversión: cuántas conversaciones llegaron al final
SELECT
  COUNT(*) AS total_conversaciones,
  COUNT(*) FILTER (WHERE estado_final = 'completado') AS completadas,
  ROUND(100.0 * COUNT(*) FILTER (WHERE estado_final = 'completado') / NULLIF(COUNT(*),0), 1) AS porcentaje
FROM bot.conversaciones;

-- Cuántas requirieron que un asesor interviniera
SELECT COUNT(*) FROM bot.conversaciones WHERE estado_final = 'intervencion_asesor';

-- Historial de un cliente: todas sus conversaciones separadas
SELECT id, inicio, fin, estado_final
FROM bot.conversaciones
WHERE telefono = '593958693149'
ORDER BY inicio DESC;

-- Ver una conversación completa (cambia el id)
SELECT direccion, tipo, contenido, creado
FROM bot.mensajes
WHERE conversacion_id = 1
ORDER BY creado ASC;

-- ---------------------------------------------------------------------
-- 6. ATRIBUCIÓN DE PAUTA (de qué anuncio vino cada cliente)
-- origen: 'ad' = anuncio | 'post' = publicación | 'organico' = escribió directo
-- ---------------------------------------------------------------------

-- Leads con su anuncio de origen
SELECT telefono, canal, tipo_internet, requerimiento,
       origen, anuncio_id, anuncio_titulo, primer_mensaje, creado
FROM bot.leads
ORDER BY creado DESC;

-- RANKING DE ANUNCIOS: cuántos leads generó cada uno
SELECT anuncio_id, anuncio_titulo, COUNT(*) AS leads
FROM bot.leads
WHERE anuncio_id IS NOT NULL
GROUP BY anuncio_id, anuncio_titulo
ORDER BY leads DESC;

-- EFECTIVIDAD POR ANUNCIO: conversaciones iniciadas vs leads cerrados
SELECT c.anuncio_id,
       c.anuncio_titulo,
       COUNT(*) AS conversaciones,
       COUNT(*) FILTER (WHERE c.estado_final = 'completado') AS leads,
       ROUND(100.0 * COUNT(*) FILTER (WHERE c.estado_final = 'completado')
             / NULLIF(COUNT(*),0), 1) AS tasa_conversion
FROM bot.conversaciones c
WHERE c.anuncio_id IS NOT NULL
GROUP BY c.anuncio_id, c.anuncio_titulo
ORDER BY leads DESC;

-- Cuánto viene de pauta vs orgánico
SELECT origen, COUNT(*) AS total
FROM bot.conversaciones
GROUP BY origen
ORDER BY total DESC;

-- Leads de pauta de los últimos 7 días, por día y anuncio
SELECT creado::date AS dia, anuncio_titulo, COUNT(*) AS leads
FROM bot.leads
WHERE anuncio_id IS NOT NULL
  AND creado >= now() - INTERVAL '7 days'
GROUP BY dia, anuncio_titulo
ORDER BY dia DESC, leads DESC;

-- Con qué mensaje entran los clientes (útil para detectar textos de anuncios)
SELECT primer_mensaje, COUNT(*) AS veces
FROM bot.conversaciones
GROUP BY primer_mensaje
ORDER BY veces DESC
LIMIT 30;

-- ---------------------------------------------------------------------
-- 7. SESIONES EN CURSO (diagnóstico)
-- ---------------------------------------------------------------------

-- Quién está a mitad del flujo en este momento
SELECT telefono, estado, datos, actualizado
FROM bot.whatsapp_sesiones
ORDER BY actualizado DESC;

-- Limpiar sesiones abandonadas (más de 24 horas sin actividad)
DELETE FROM bot.whatsapp_sesiones
WHERE actualizado < now() - INTERVAL '24 hours';
